#!/usr/bin/env node
import { Command, Option } from "commander";
import { existsSync, readFileSync, writeFileSync, copyFileSync, appendFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { makeGuard, readLockedFiles, lockedMatch } from "./guard.js";
import { gate, redact } from "./report.js";
import { takeSnapshot, diffSnapshots, restoreProtected, describeDiff, totalChanges } from "./snapshot.js";
import { buildTeam, LEAD_ADDENDUM } from "./team.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYSTEM_PROMPT = readFileSync(path.join(ROOT, "prompts", "guardian.md"), "utf8");
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version as string;

export type Mode = "review" | "audit" | "rescue" | "fix";

interface RunOptions {
  repo: string;
  out: string;
  model?: string;
  maxTurns: number;
  base?: string;
  failOn?: string;
  quiet: boolean;
  team: boolean;
  lang?: string;
}

const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const log = (s: string) => process.stderr.write(dim(`  ${s}`) + "\n");
const warn = (s: string) => process.stderr.write(`⚠️  ${s}\n`);

function hasCredentials(): boolean {
  const e = process.env;
  return Boolean(e.ANTHROPIC_API_KEY || e.CLAUDE_CODE_OAUTH_TOKEN || e.CLAUDE_CODE_USE_BEDROCK || e.CLAUDE_CODE_USE_VERTEX);
}

export function taskFor(mode: Mode, o: Pick<RunOptions, "repo" | "base" | "team" | "lang">, extra?: string): string {
  const locked = readLockedFiles(o.repo);
  const lockedLine = locked.length
    ? `Locked files (enforced by the tool, edits are blocked and reverted): ${locked.join(", ")}.`
    : "No locked files declared.";
  const lang = o.lang ? `Write the whole report in ${o.lang}. Keep code, file paths, IDs and the summary line as they are.` : "";
  const team = o.team ? "Work as the team lead described in Team mode." : "Work alone: do all passes yourself.";
  const lines: string[] = [];
  switch (mode) {
    case "review":
      lines.push(
        "Mode: review.",
        o.base
          ? `Scope: changes between \`${o.base}\` and HEAD. Start with \`git diff ${o.base}...HEAD --stat\` and \`git diff ${o.base}...HEAD\`.`
          : "Scope: changes since the last git tag, or the last 10 commits if there is no tag. Also include uncommitted changes (`git status`, `git diff`). If this is not a git repo, review the most important source files.",
        lockedLine, team, "Run all five passes and produce the report.",
      );
      break;
    case "audit":
      lines.push("Mode: audit.", "Scope: the whole repository.", lockedLine, team, "Run all five passes and produce the report.");
      break;
    case "rescue":
      lines.push("Mode: rescue.", "Scope: the whole repository.", lockedLine, team,
        "Follow Rescue mode, then add the most important findings from the five passes, and produce the report.");
      break;
    case "fix":
      lines.push(
        "Mode: fix. In this mode you MAY edit files.",
        `Apply only these items from the previous report: ${extra}. Ignore every other item.`,
        "The previous UNSTUCK report is below. Apply one item at a time. After each item, run the relevant tests, typecheck and build (whatever exists).",
        "If an item touches a locked file, needs a secret, a migration, a CI workflow, or a production change, skip it and say why.",
        "Never refactor and change behavior in the same item. Never weaken or delete a test to make it pass. Do not commit.",
        lockedLine,
        "Finish with a short report: for each item — applied / skipped, files changed, verification results with exact counts, anything the reader must check by hand.",
        "Last line: <!-- unstuck:summary P0=0 P1=0 P2=0 P3=0 -->",
      );
      break;
  }
  if (lang) lines.push(lang);
  return lines.join("\n");
}

async function run(mode: Mode, o: RunOptions, extra?: string, previousReport?: string): Promise<number> {
  if (!existsSync(o.repo) || !statSync(o.repo).isDirectory()) {
    console.error(`Project folder not found: ${o.repo}`);
    return 2;
  }
  if (!hasCredentials()) {
    console.error("Set ANTHROPIC_API_KEY first. Get a key at https://console.anthropic.com");
    return 2;
  }

  const writes = mode === "fix";
  const team = o.team && !writes;
  const locked = readLockedFiles(o.repo);
  const before = takeSnapshot(o.repo, (rel) => lockedMatch(rel, o.repo, locked) !== null);
  if (before.truncated) warn("Large project: the change check covers the first 50,000 files only.");

  const prompt = previousReport
    ? `${taskFor(mode, { ...o, team }, extra)}\n\n---\nPrevious report:\n\n${previousReport}`
    : taskFor(mode, { ...o, team });
  process.stderr.write(`🛟 UNSTUCK ${VERSION} · ${mode}${team ? " · team" : ""} · ${o.repo}\n`);

  let report = "";
  let cost = 0;
  let failed: string | null = null;
  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: o.repo,
        systemPrompt: team ? SYSTEM_PROMPT + "\n" + LEAD_ADDENDUM : SYSTEM_PROMPT,
        tools: [
          "Read", "Grep", "Glob", "Bash",
          ...(writes ? ["Edit", "Write"] : []),
          ...(team ? ["Agent"] : []),
        ],
        ...(team ? { agents: buildTeam(SYSTEM_PROMPT, o.model) } : {}),
        permissionMode: "default",
        canUseTool: makeGuard({ repo: o.repo, allowWrites: writes, allowDelegation: team, log: o.quiet ? undefined : log }),
        settingSources: [], // ignore the user's own Claude settings so UNSTUCK behaves the same everywhere
        maxTurns: o.maxTurns,
        ...(o.model ? { model: o.model } : {}),
      },
    })) {
      if (msg.type === "assistant" && !o.quiet) {
        const who = msg.parent_tool_use_id ? "   ↳ " : "";
        for (const block of msg.message.content) {
          if (block.type !== "tool_use") continue;
          const i = block.input as Record<string, unknown>;
          const what = block.name === "Agent" ? `${i.subagent_type ?? ""} — ${i.description ?? ""}` : (i.command ?? i.file_path ?? i.pattern ?? i.path ?? "");
          log(`${who}${block.name} ${String(what).replace(/\s+/g, " ").slice(0, 100)}`);
        }
      }
      if (msg.type === "result") {
        cost = msg.total_cost_usd ?? 0;
        if (msg.subtype === "success") report = msg.result;
        else failed = msg.subtype;
      }
    }
  } catch (err) {
    failed = (err as Error).message;
  }

  // Backstop: compare the project with how it was before the run.
  const after = takeSnapshot(o.repo);
  const diff = diffSnapshots(before, after);
  const restored = restoreProtected(o.repo, before, diff);
  let notes = "";
  if (restored.length) {
    notes += `\n\n> ⛔ **UNSTUCK restored ${restored.length} locked file(s)** that were changed during the run: ${restored.join(", ")}.\n`;
    warn(`Restored locked files: ${restored.join(", ")}`);
  }
  if (!writes && totalChanges(diff) > restored.length) {
    notes += `\n\n> ⚠️ **Files changed during a read-only run** (usually a test or build script writing output). Check with \`git status\`:\n\n\`\`\`\n${describeDiff(diff)}\n\`\`\`\n`;
    warn(`Files changed during a read-only run:\n${describeDiff(diff)}`);
  }

  if (failed) {
    console.error(`\nThe run stopped early (${failed}). Try a larger --max-turns or a narrower scope.`);
    if (!report) return 1;
  }

  report = redact(report.trim()) + notes;
  const outPath = path.resolve(o.repo, o.out);
  writeFileSync(outPath, report + "\n");
  process.stdout.write("\n" + report + "\n");
  process.stderr.write(`\nReport saved to ${outPath}${cost ? ` · cost ≈ $${cost.toFixed(2)}` : ""}\n`);

  if (failed) return 1;
  return gate(report, o.failOn, warn);
}

const program = new Command()
  .name("unstuck")
  .description("An AI agent team that reviews, tests, risk-checks and rescues code — especially code built with AI tools.")
  .version(VERSION);

const common = (c: Command, defaultTeam: boolean) =>
  c
    .argument("[path]", "project folder", ".")
    .option("-o, --out <file>", "where to save the report (inside the project)", "unstuck-report.md")
    .option("-m, --model <model>", "Claude model to use, e.g. opus or sonnet")
    .option("--max-turns <n>", "maximum agent steps", "100")
    .option("--fail-on <level>", "exit with code 1 if findings at this severity or worse exist (P0, P1, P2, P3)")
    .option("--lang <language>", "write the report in this language, e.g. Arabic")
    .addOption(new Option("--team", `use the five-specialist team${defaultTeam ? " (default here)" : ""}`).conflicts("solo"))
    .addOption(new Option("--solo", `single agent, faster and cheaper${defaultTeam ? "" : " (default here)"}`))
    .option("-q, --quiet", "hide progress");

const opts = (p: string, c: Record<string, string | boolean | undefined>, defaultTeam: boolean): RunOptions => ({
  repo: path.resolve(p),
  out: String(c.out),
  model: c.model as string | undefined,
  maxTurns: Math.max(1, Number(c.maxTurns) || 100),
  base: c.base as string | undefined,
  failOn: c.failOn as string | undefined,
  quiet: Boolean(c.quiet),
  team: c.team ? true : c.solo ? false : defaultTeam,
  lang: c.lang as string | undefined,
});

const done = (code: number) => { process.exitCode = code; };

common(program.command("review").description("review recent changes (default: since the last tag or last 10 commits)"), false)
  .option("-b, --base <ref>", "compare against this branch or commit, e.g. origin/main")
  .action(async (p, c) => done(await run("review", opts(p, c, false))));

common(program.command("audit").description("review the whole project with the specialist team"), true)
  .action(async (p, c) => done(await run("audit", opts(p, c, true))));

common(program.command("rescue").description("diagnose a stuck or broken project and plan how to stabilize it"), true)
  .action(async (p, c) => done(await run("rescue", opts(p, c, true))));

program
  .command("fix")
  .description("apply chosen items from the last report, e.g. unstuck fix F1,R2")
  .argument("<ids>", "comma-separated IDs from the report")
  .argument("[path]", "project folder", ".")
  .option("-r, --report <file>", "report to apply from", "unstuck-report.md")
  .option("-o, --out <file>", "where to save the fix report", "unstuck-fix-report.md")
  .option("-m, --model <model>", "Claude model to use")
  .option("--max-turns <n>", "maximum agent steps", "150")
  .option("--lang <language>", "write the report in this language")
  .option("-q, --quiet", "hide progress")
  .action(async (ids: string, p, c) => {
    const clean = ids.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const bad = clean.filter((id) => !/^[FRS]\d{1,3}$/.test(id));
    if (!clean.length || bad.length) {
      console.error(`Invalid IDs: ${bad.join(", ") || ids}. Use IDs from the report, e.g. F1,R2,S3.`);
      return done(2);
    }
    const reportPath = path.resolve(p, c.report);
    if (!existsSync(reportPath)) {
      console.error(`No report found at ${reportPath}. Run \`unstuck review\` first.`);
      return done(2);
    }
    done(await run("fix", { ...opts(p, c, false), team: false, maxTurns: Math.max(1, Number(c.maxTurns) || 150) }, clean.join(","), readFileSync(reportPath, "utf8")));
  });

program
  .command("init")
  .description("create a GUARDIAN.md rules file in your project")
  .argument("[path]", "project folder", ".")
  .action((p) => {
    const repo = path.resolve(p);
    const target = path.join(repo, "GUARDIAN.md");
    if (existsSync(target)) console.log(`GUARDIAN.md already exists at ${target}`);
    else {
      copyFileSync(path.join(ROOT, "templates", "GUARDIAN.md"), target);
      console.log(`Created ${target}. Fill in your rules and locked files, then run \`unstuck review\`.`);
    }
    const gi = path.join(repo, ".gitignore");
    const has = existsSync(gi) && /^unstuck-\*report\.md$/m.test(readFileSync(gi, "utf8"));
    if (!has) {
      appendFileSync(gi, `${existsSync(gi) && !readFileSync(gi, "utf8").endsWith("\n") ? "\n" : ""}unstuck-*report.md\n`);
      console.log("Added unstuck-*report.md to .gitignore.");
    }
  });

program.parseAsync();
