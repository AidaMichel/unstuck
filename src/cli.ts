#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { makeGuard, readLockedFiles } from "./guard.js";
import { gate } from "./summary.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYSTEM_PROMPT = readFileSync(path.join(ROOT, "prompts", "guardian.md"), "utf8");
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version as string;

type Mode = "review" | "audit" | "rescue" | "fix";

interface RunOptions {
  repo: string;
  out: string;
  model?: string;
  maxTurns: number;
  base?: string;
  failOn?: string;
  quiet?: boolean;
}

const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const log = (s: string) => process.stderr.write(dim(`  ${s}`) + "\n");

function taskFor(mode: Mode, o: RunOptions, extra?: string): string {
  const locked = readLockedFiles(o.repo);
  const lockedLine = locked.length ? `Locked files (enforced by the tool): ${locked.join(", ")}.` : "No locked files declared.";
  switch (mode) {
    case "review":
      return [
        "Mode: review.",
        o.base
          ? `Scope: changes between \`${o.base}\` and HEAD. Start with \`git diff ${o.base}...HEAD --stat\` and \`git diff ${o.base}...HEAD\`.`
          : "Scope: changes since the last git tag, or the last 10 commits if there is no tag. Also include uncommitted changes (`git status`, `git diff`). If this is not a git repo, review the most important source files.",
        lockedLine,
        "Run all five passes and produce the report.",
      ].join("\n");
    case "audit":
      return ["Mode: audit.", "Scope: the whole repository.", lockedLine, "Run all five passes and produce the report."].join("\n");
    case "rescue":
      return ["Mode: rescue.", "Scope: the whole repository.", lockedLine, "Follow Rescue mode, then add the most important findings from the five passes, and produce the report."].join("\n");
    case "fix":
      return [
        "Mode: fix. In this mode you MAY edit files.",
        `Apply only these items from the previous report: ${extra}.`,
        "The previous UNSTUCK report is below. Apply one item at a time. After each item, run the relevant tests, typecheck and build (whatever exists).",
        "If an item touches a locked file, needs a secret, a migration, or a production change, skip it and say why.",
        "Never refactor and change behavior in the same item. Never weaken a test.",
        lockedLine,
        "Finish with a short report: for each item — applied / skipped, files changed, verification results with exact counts, anything the reader must check by hand.",
        "Last line: <!-- unstuck:summary P0=0 P1=0 P2=0 P3=0 -->",
      ].join("\n");
  }
}

async function run(mode: Mode, o: RunOptions, extra?: string, previousReport?: string): Promise<number> {
  if (!existsSync(o.repo)) {
    console.error(`Project folder not found: ${o.repo}`);
    return 2;
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error("Set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN) first. Get a key at https://console.anthropic.com");
    return 2;
  }

  const prompt = previousReport ? `${taskFor(mode, o, extra)}\n\n---\nPrevious report:\n\n${previousReport}` : taskFor(mode, o, extra);
  process.stderr.write(`UNSTUCK ${VERSION} · ${mode} · ${o.repo}\n`);

  let report = "";
  let cost = 0;
  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: o.repo,
        systemPrompt: SYSTEM_PROMPT,
        tools: mode === "fix" ? ["Read", "Grep", "Glob", "Bash", "Edit", "Write"] : ["Read", "Grep", "Glob", "Bash"],
        permissionMode: "default",
        canUseTool: makeGuard({ repo: o.repo, allowWrites: mode === "fix", log: o.quiet ? undefined : log }),
        settingSources: [], // ignore the user's own Claude settings; behave the same everywhere
        maxTurns: o.maxTurns,
        ...(o.model ? { model: o.model } : {}),
      },
    })) {
      if (msg.type === "assistant" && !o.quiet) {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            const i = block.input as Record<string, unknown>;
            const what = i.command ?? i.file_path ?? i.pattern ?? i.path ?? "";
            log(`${block.name} ${String(what).slice(0, 100)}`);
          }
        }
      }
      if (msg.type === "result") {
        cost = msg.total_cost_usd ?? 0;
        if (msg.subtype === "success") report = msg.result;
        else {
          console.error(`\nThe run stopped early (${msg.subtype}). Try a larger --max-turns or a narrower scope.`);
          return 1;
        }
      }
    }
  } catch (err) {
    console.error(`\nUNSTUCK failed: ${(err as Error).message}`);
    return 1;
  }

  const outPath = path.resolve(o.repo, o.out);
  writeFileSync(outPath, report.trim() + "\n");
  process.stdout.write("\n" + report.trim() + "\n");
  process.stderr.write(`\nReport saved to ${outPath}${cost ? ` · cost ≈ $${cost.toFixed(2)}` : ""}\n`);

  return gate(report, o.failOn);
}

const program = new Command()
  .name("unstuck")
  .description("An AI agent that reviews, tests, risk-checks and rescues code — especially code built with AI tools.")
  .version(VERSION);

const common = (c: Command) =>
  c
    .argument("[path]", "project folder", ".")
    .option("-o, --out <file>", "where to save the report", "unstuck-report.md")
    .option("-m, --model <model>", "Claude model to use")
    .option("--max-turns <n>", "maximum agent steps", "80")
    .option("--fail-on <level>", "exit with code 1 if findings at this severity or worse exist (P0, P1, P2)")
    .option("-q, --quiet", "hide progress");

const opts = (p: string, c: Record<string, string | boolean | undefined>): RunOptions => ({
  repo: path.resolve(p),
  out: String(c.out),
  model: c.model as string | undefined,
  maxTurns: Number(c.maxTurns) || 80,
  base: c.base as string | undefined,
  failOn: c.failOn as string | undefined,
  quiet: Boolean(c.quiet),
});

common(program.command("review").description("review recent changes (default: since last tag or last 10 commits)"))
  .option("-b, --base <ref>", "compare against this branch or commit, e.g. origin/main")
  .action(async (p, c) => process.exit(await run("review", opts(p, c))));

common(program.command("audit").description("review the whole project")).action(async (p, c) =>
  process.exit(await run("audit", opts(p, c))),
);

common(program.command("rescue").description("diagnose a stuck or broken project and plan how to stabilize it")).action(
  async (p, c) => process.exit(await run("rescue", opts(p, c))),
);

program
  .command("fix")
  .description("apply chosen items from the last report, e.g. unstuck fix F1,R2")
  .argument("<ids>", "comma-separated IDs from the report")
  .argument("[path]", "project folder", ".")
  .option("-r, --report <file>", "report to apply from", "unstuck-report.md")
  .option("-o, --out <file>", "where to save the fix report", "unstuck-fix-report.md")
  .option("-m, --model <model>", "Claude model to use")
  .option("--max-turns <n>", "maximum agent steps", "120")
  .option("-q, --quiet", "hide progress")
  .action(async (ids, p, c) => {
    const reportPath = path.resolve(p, c.report);
    if (!existsSync(reportPath)) {
      console.error(`No report found at ${reportPath}. Run \`unstuck review\` first.`);
      process.exit(2);
    }
    process.exit(await run("fix", opts(p, c), ids, readFileSync(reportPath, "utf8")));
  });

program
  .command("init")
  .description("create a GUARDIAN.md rules file in your project")
  .argument("[path]", "project folder", ".")
  .action((p) => {
    const target = path.resolve(p, "GUARDIAN.md");
    if (existsSync(target)) {
      console.log(`GUARDIAN.md already exists at ${target}`);
      return;
    }
    copyFileSync(path.join(ROOT, "templates", "GUARDIAN.md"), target);
    console.log(`Created ${target}. Fill in your rules and locked files, then run \`unstuck review\`.`);
  });

program.parseAsync();
