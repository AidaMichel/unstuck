#!/usr/bin/env node
import { Command, Option } from "commander";
import { existsSync, readFileSync, copyFileSync, statSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeGuard, readLockedFiles, lockedMatch } from "./guard.js";
import { gate, redact } from "./report.js";
import { takeSnapshot, diffSnapshots, describeChanges } from "./snapshot.js";
import { resolveReportPath, writeReportFile, latestReportPath, UnsafePathError } from "./paths.js";
import { buildTeam, LEAD_ADDENDUM } from "./team.js";
import { collectFacts } from "./offline/facts.js";
import { runRules } from "./offline/rules.js";
import { renderReport } from "./offline/render.js";
import { detectLocalModel, isLocalUrl, diagnoseWith, httpBackend } from "./llm.js";
import { CATALOG, catalogModel, defaultModel, formatBytes, sourceUrl } from "./embedded/catalog.js";
import { chooseModel, installedModels, modelDir, sidecarPath, ModelFileError } from "./embedded/store.js";
import { remoteInfo, consentText, askConsent, downloadModel } from "./embedded/download.js";
import { embeddedBackend, findRuntime, platformPackage, runtimeDir, RUNTIME_VERSION } from "./embedded/runtime.js";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYSTEM_PROMPT = readFileSync(path.join(ROOT, "prompts", "guardian.md"), "utf8");
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version as string;

export type Mode = "review" | "audit" | "rescue" | "fix";

interface RunOptions {
  repo: string;
  out?: string;
  runChecks: boolean;
  model?: string;
  maxTurns: number;
  base?: string;
  failOn?: string;
  quiet: boolean;
  team: boolean;
  lang?: string;
  engine: Engine;
  llmUrl?: string;
  localModel?: string;
  allowRemoteLlm: boolean;
  note?: string;
  modelFile?: string;
  embeddedModel?: string;
}

export type Engine = "auto" | "offline" | "local" | "embedded" | "claude";

const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const log = (s: string) => process.stderr.write(dim(`  ${s}`) + "\n");
const warn = (s: string) => process.stderr.write(`⚠️  ${s}\n`);

function hasCredentials(): boolean {
  const e = process.env;
  return Boolean(e.ANTHROPIC_API_KEY || e.CLAUDE_CODE_OAUTH_TOKEN || e.CLAUDE_CODE_USE_BEDROCK || e.CLAUDE_CODE_USE_VERTEX);
}

export function taskFor(mode: Mode, o: Pick<RunOptions, "repo" | "base" | "team" | "lang" | "runChecks">, extra?: string): string {
  const locked = readLockedFiles(o.repo);
  const lockedLine = locked.length
    ? `Locked files (enforced by the tool, edits are blocked and reverted): ${locked.join(", ")}.`
    : "No locked files declared.";
  const lang = o.lang ? `Write the whole report in ${o.lang}. Keep code, file paths, IDs and the summary line as they are.` : "";
  const team = o.team ? "Work as the team lead described in Team mode." : "Work alone: do all passes yourself.";
  const checks = mode === "fix" || o.runChecks
    ? "Checks: ENABLED. You may run the project's tests, typecheck, lint and build."
    : "Checks: DISABLED. Do not run project scripts (tests, build, lint, package managers, interpreters); the tool refuses them. List the commands you would run and mark them 'not run — re-run with --run-checks'. Use only inspection commands (git log/diff/show/status, ls, cat, grep, find, head, tail, wc).";
  const lines: string[] = [];
  switch (mode) {
    case "review":
      lines.push(
        "Mode: review.",
        o.base
          ? `Scope: changes between \`${o.base}\` and HEAD. Start with \`git diff ${o.base}...HEAD --stat\` and \`git diff ${o.base}...HEAD\`.`
          : "Scope: changes since the last git tag, or the last 10 commits if there is no tag. Also include uncommitted changes (`git status`, `git diff`). If this is not a git repo, review the most important source files.",
        lockedLine, team, checks, "Run all five passes and produce the report.",
      );
      break;
    case "audit":
      lines.push("Mode: audit.", "Scope: the whole repository.", lockedLine, team, checks, "Run all five passes and produce the report.");
      break;
    case "rescue":
      lines.push("Mode: rescue.", "Scope: the whole repository.", lockedLine, team, checks,
        "Follow Rescue mode, then add the most important findings from the five passes, and produce the report.");
      break;
    case "fix":
      lines.push(
        "Mode: fix. In this mode you MAY edit files.",
        `Apply only these items from the previous report: ${extra}. Ignore every other item.`,
        "The previous UNSTUCK report is below. Apply one item at a time. After each item, run the relevant tests, typecheck and build (whatever exists).",
        "If an item touches a locked file, needs a secret, a migration, a CI workflow, or a production change, skip it and say why.",
        "Never refactor and change behavior in the same item. Never weaken or delete a test to make it pass. Do not commit.",
        lockedLine, checks,
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
  let outPath: string;
  try {
    outPath = resolveReportPath(o.repo, mode, o.out);
  } catch (err) {
    if (err instanceof UnsafePathError) { console.error(err.message); return 2; }
    throw err;
  }
  // Free engines: no account, no API key. Claude is used only when asked for, or in auto mode when a key is set.
  if (mode !== "fix" && (o.engine === "offline" || o.engine === "local" || o.engine === "embedded" || (o.engine === "auto" && !hasCredentials()))) {
    return runFree(mode, o, outPath);
  }
  if (!hasCredentials()) {
    console.error(mode === "fix"
      ? "`unstuck fix` edits code with Claude and needs ANTHROPIC_API_KEY. The free engines only diagnose."
      : "The Claude engine needs ANTHROPIC_API_KEY. Use --engine offline or --engine local for the free engines.");
    return 2;
  }
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const writes = mode === "fix";
  const team = o.team && !writes;
  const scripts = writes || o.runChecks;
  const locked = readLockedFiles(o.repo);
  const before = takeSnapshot(o.repo);
  if (before.truncated) warn("Large project: the change check covers the first 50,000 files only.");

  const prompt = previousReport
    ? `${taskFor(mode, { ...o, team }, extra)}\n\n---\nPrevious report:\n\n${previousReport}`
    : taskFor(mode, { ...o, team });
  process.stderr.write(`🛟 UNSTUCK ${VERSION} · ${mode}${team ? " · team" : ""}${!writes ? (scripts ? " · checks on" : " · read-only, no scripts") : ""} · ${o.repo}\n`);

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
        canUseTool: makeGuard({ repo: o.repo, allowWrites: writes, allowScripts: scripts, allowDelegation: team, log: o.quiet ? undefined : log }),
        // Best effort: stop git from refreshing its index during read-only inspection.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat" },
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

  // Observe (never revert) what changed in the project while UNSTUCK ran.
  const diff = diffSnapshots(before, takeSnapshot(o.repo));
  const lockedChanged = [...diff.changed, ...diff.removed].filter((rel) => lockedMatch(rel, o.repo, locked) !== null);
  const notice = describeChanges(diff, { writes, ranScripts: scripts, lockedChanged });
  if (notice.console) warn(notice.console);

  if (failed) {
    console.error(`\nThe run stopped early (${failed}). Try a larger --max-turns or a narrower scope.`);
    if (!report) return 1;
  }

  report = redact(report.trim()) + notice.markdown;
  try {
    writeReportFile(outPath, report + "\n", o.repo);
    if (!o.out && mode !== "fix") writeReportFile(latestReportPath(o.repo), report + "\n", o.repo);
  } catch (err) {
    console.error(`Could not save the report: ${(err as Error).message}`);
    process.stdout.write("\n" + report + "\n");
    return 1;
  }
  process.stdout.write("\n" + report + "\n");
  process.stderr.write(`\nReport saved to ${outPath}${cost ? ` · cost ≈ $${cost.toFixed(2)}` : ""}\n`);

  if (failed || notice.fail) return 1;
  return gate(report, o.failOn, warn);
}

type FactsT = ReturnType<typeof collectFacts>;
type FindingsT = ReturnType<typeof runRules>;

/** Embedded engine: any problem gives a clearly labelled offline report, never an error. */
async function runEmbedded(mode: Mode, o: RunOptions, facts: FactsT, findings: FindingsT): Promise<{ report: string; engineLabel: string }> {
  const offline = (why: string) => {
    if (!o.quiet) log(why);
    return { report: renderReport(facts, findings, o.note, `The embedded AI model was not used: ${why}. This is UNSTUCK's free offline diagnosis instead.`), engineLabel: "offline (fallback: embedded model not used)" };
  };
  let choice;
  try { choice = chooseModel({ file: o.modelFile, id: o.embeddedModel }); } catch (err) { return offline((err as Error).message); }
  if (!choice) return offline(`no embedded model is installed${o.embeddedModel ? ` for "${o.embeddedModel}"` : ""} (run \`unstuck model download\` to get one; it asks before downloading)`);
  if (!findRuntime()) return offline("the embedded AI runtime isn't installed (run `unstuck model runtime`; it asks before installing)");
  process.stderr.write(`🛟 UNSTUCK ${VERSION} · ${mode} · engine: embedded model ${choice.label} · ${o.repo}\n`);
  let loaded;
  try {
    if (!o.quiet) log(`loading ${choice.label}…`);
    loaded = await embeddedBackend(choice);
  } catch (err) {
    const msg = err instanceof ModelFileError ? err.message : `could not load the model (${(err as Error).message.split("\n")[0].slice(0, 200)})`;
    return offline(msg);
  }
  try {
    const r = await diagnoseWith(loaded.backend, facts, findings, o.note, o.lang, o.quiet ? undefined : log);
    const s = loaded.stats;
    if (!o.quiet) log(`embedded model: loaded in ${(s.loadMs / 1000).toFixed(1)}s, context ${s.contextTokens} tokens${s.answerMs !== undefined ? `, answered in ${(s.answerMs / 1000).toFixed(1)}s` : ""}${s.peakRssMB ? `, peak memory ${s.peakRssMB} MB` : ""}`);
    return { report: r.report, engineLabel: r.usedModel ? `embedded model ${choice.label}` : `offline (fallback: ${choice.label} was not usable)` };
  } finally {
    await loaded.backend.dispose?.();
  }
}

async function runFree(mode: Mode, o: RunOptions, outPath: string): Promise<number> {
  if (o.llmUrl && !isLocalUrl(o.llmUrl) && !o.allowRemoteLlm) {
    console.error(`Refusing to send project details to ${o.llmUrl}: it isn't on this computer. Add --allow-remote-llm if you trust that server.`);
    return 2;
  }
  const facts = collectFacts(o.repo);
  const findings = runRules(facts);
  let report: string;
  let engineLabel = "offline (free, no AI)";
  // auto never downloads: it uses the embedded model only if a runtime and a model are already installed.
  const embeddedReady = () => { try { return Boolean(findRuntime() && chooseModel({ file: o.modelFile, id: o.embeddedModel })); } catch { return false; } };
  if (o.engine === "offline") {
    report = renderReport(facts, findings, o.note);
  } else if (o.engine === "embedded" || (o.engine === "auto" && (o.modelFile || o.embeddedModel))) {
    ({ report, engineLabel } = await runEmbedded(mode, o, facts, findings));
  } else {
    const m = await detectLocalModel({ url: o.llmUrl, model: o.localModel });
    if (!m && o.engine === "auto" && embeddedReady()) {
      ({ report, engineLabel } = await runEmbedded(mode, o, facts, findings));
    } else if (!m) {
      const hint = o.localModel
        ? `Model "${o.localModel}" not found on ${o.llmUrl ?? "Ollama (localhost:11434) or LM Studio (localhost:1234)"}.`
        : `No local model server found${o.llmUrl ? ` at ${o.llmUrl}` : " (looked for Ollama on localhost:11434 and LM Studio on localhost:1234)"}.`;
      if (o.engine === "local") {
        console.error(`${hint}\nInstall Ollama from https://ollama.com, run \`ollama pull qwen2.5-coder:7b\`, then try again. Or use --engine offline.`);
        return 2;
      }
      if (!o.quiet) log(`${hint} Using the free offline engine. For a deeper diagnosis, install Ollama and run \`ollama pull qwen2.5-coder:7b\`.`);
      report = renderReport(facts, findings, o.note);
    } else {
      process.stderr.write(`🛟 UNSTUCK ${VERSION} · ${mode} · engine: local model ${m.model} · ${o.repo}\n`);
      const r = await diagnoseWith(httpBackend(m), facts, findings, o.note, o.lang, o.quiet ? undefined : log);
      report = r.report;
      engineLabel = r.usedModel ? `local model ${m.model}` : `offline (fallback: ${m.model} was not usable)`;
    }
  }
  if (engineLabel.startsWith("offline")) {
    process.stderr.write(`🛟 UNSTUCK ${VERSION} · ${mode} · engine: ${engineLabel} · ${o.repo}\n`);
    if (o.lang) warn("The offline engine writes in English only; --lang needs a local model or Claude.");
    if (mode === "review" && o.base) warn("The free engines diagnose the whole project; --base is used by the Claude engine only.");
  }
  try {
    writeReportFile(outPath, report + "\n", o.repo);
    if (!o.out) writeReportFile(latestReportPath(o.repo), report + "\n", o.repo);
  } catch (err) {
    console.error(`Could not save the report: ${(err as Error).message}`);
    process.stdout.write("\n" + report + "\n");
    return 1;
  }
  process.stdout.write("\n" + report + "\n");
  process.stderr.write(`\nReport saved to ${outPath} · cost: $0\n`);
  return gate(report, o.failOn, warn);
}

const program = new Command()
  .name("unstuck")
  .description("Diagnoses stuck projects, especially ones built with AI tools. Works free and offline; optionally uses a local open-source model or Claude.")
  .version(VERSION);

const common = (c: Command, defaultTeam: boolean) =>
  c
    .argument("[path]", "project folder", ".")
    .option("-o, --out <file>", "where to save the report (must be outside the project; default ~/.unstuck/reports/…)")
    .option("--run-checks", "allow running the project's tests, build and lint (they can execute code and write files)")
    .addOption(new Option("-e, --engine <engine>", "auto: Claude if ANTHROPIC_API_KEY is set, else a running local model server, else an installed embedded model, else offline").choices(["auto", "offline", "local", "embedded", "claude"]).default("auto"))
    .option("--model-file <path>", "run this GGUF model file with the embedded engine")
    .option("--embedded-model <id>", "embedded model to use (see `unstuck model list`)")
    .option("--note <text>", "what feels stuck, in your words")
    .option("--local-model <name>", "local model to use, e.g. qwen2.5-coder:7b (default: best installed)")
    .option("--llm-url <url>", "local model server, e.g. http://localhost:11434 (Ollama) or http://localhost:1234 (LM Studio)")
    .option("--allow-remote-llm", "allow --llm-url to point at another computer (project details will be sent there)")
    .option("-m, --model <model>", "Claude model to use, e.g. opus or sonnet")
    .option("--max-turns <n>", "maximum agent steps", "100")
    .option("--fail-on <level>", "exit with code 1 if findings at this severity or worse exist (P0, P1, P2, P3)")
    .option("--lang <language>", "write the report in this language, e.g. Arabic")
    .addOption(new Option("--team", `use the five-specialist team${defaultTeam ? " (default here)" : ""}`).conflicts("solo"))
    .addOption(new Option("--solo", `single agent, faster and cheaper${defaultTeam ? "" : " (default here)"}`))
    .option("-q, --quiet", "hide progress");

const opts = (p: string, c: Record<string, string | boolean | undefined>, defaultTeam: boolean): RunOptions => ({
  repo: path.resolve(p),
  out: c.out ? String(c.out) : undefined,
  runChecks: Boolean(c.runChecks),
  model: c.model as string | undefined,
  maxTurns: Math.max(1, Number(c.maxTurns) || 100),
  base: c.base as string | undefined,
  failOn: c.failOn as string | undefined,
  quiet: Boolean(c.quiet),
  team: c.team ? true : c.solo ? false : defaultTeam,
  lang: c.lang as string | undefined,
  engine: ((c.engine as string) || "auto") as Engine,
  llmUrl: c.llmUrl as string | undefined,
  localModel: c.localModel as string | undefined,
  allowRemoteLlm: Boolean(c.allowRemoteLlm),
  note: c.note as string | undefined,
  modelFile: c.modelFile as string | undefined,
  embeddedModel: c.embeddedModel as string | undefined,
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
  .option("-r, --report <file>", "report to apply from (default: this project's latest report)")
  .option("-o, --out <file>", "where to save the fix report (must be outside the project)")
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
    const repo = path.resolve(p);
    let reportPath: string;
    try {
      reportPath = c.report ? path.resolve(c.report) : latestReportPath(repo);
    } catch (err) {
      console.error((err as Error).message);
      return done(2);
    }
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
  });

// ---- unstuck model … : the only commands that download anything, and only after consent ----
const modelCmd = program.command("model").description("manage the optional embedded open-source AI model (nothing is downloaded without your consent)");

modelCmd.command("list").description("show available and installed models").action(() => {
  const installed = installedModels();
  console.log(`Embedded AI runtime: ${findRuntime() ? `installed (${findRuntime()})` : "not installed — `unstuck model runtime`"}`);
  console.log(`Models folder: ${modelDir()}\n`);
  for (const m of CATALOG) {
    const inst = installed.find((i) => i.id === m.id);
    console.log(`${inst ? "●" : "○"} ${m.id}${m.default ? " (default)" : ""}\n    ${m.name} · about ${formatBytes(m.approxBytes)} · ${m.license} · needs ~${m.minRamGB} GB RAM\n    ${m.note}${inst ? `\n    installed: ${inst.file}` : ""}`);
  }
});

modelCmd.command("download").description("download a model (asks first)").argument("[id]", "model id from `unstuck model list`")
  .option("-y, --yes", "agree to the download without asking")
  .option("--allow-unverified", "download even if the source publishes no checksum")
  .action(async (id: string | undefined, c) => {
    const m = id ? catalogModel(id) : defaultModel();
    if (!m) { console.error(`Unknown model "${id}". Run \`unstuck model list\`.`); return done(2); }
    let info;
    try { info = await remoteInfo(sourceUrl(m)); } catch (err) { console.error(`Could not reach the model source: ${(err as Error).message}`); return done(1); }
    const dest = path.join(modelDir(), m.file);
    process.stderr.write(consentText(m, info, dest) + "\n\n");
    if (!(await askConsent({ yes: c.yes }))) {
      console.error(process.stdin.isTTY ? "Not downloaded." : "Not downloaded: no terminal to ask for consent. Re-run with --yes to agree.");
      return done(c.yes ? 0 : 3);
    }
    try {
      let last = 0;
      const r = await downloadModel(m, info, {
        allowUnverified: c.allowUnverified,
        progress: (d, t) => { const now = Date.now(); if (now - last > 1000 && process.stderr.isTTY) { last = now; process.stderr.write(`\r  ${formatBytes(d)}${t ? ` of ${formatBytes(t)} (${Math.floor((d / t) * 100)}%)` : ""}   `); } },
      });
      process.stderr.write(`\nSaved ${formatBytes(r.bytes)} to ${r.file}${r.verified ? " · SHA-256 verified" : " · not verified (no checksum published)"}\n`);
      if (!findRuntime()) process.stderr.write("Next: `unstuck model runtime` installs the engine that runs it (also asks first).\n");
    } catch (err) {
      console.error(`Download failed: ${(err as Error).message}`);
      return done(1);
    }
  });

modelCmd.command("remove").description("delete a downloaded model").argument("<id>", "model id").option("-y, --yes", "don't ask")
  .action(async (id: string, c) => {
    const inst = installedModels().find((i) => i.id === id);
    if (!inst) { console.error(`Model "${id}" isn't installed.`); return done(2); }
    process.stderr.write(`Delete ${inst.file} (${formatBytes(inst.bytes)})?\n`);
    if (!(await askConsent({ yes: c.yes }))) { console.error("Not deleted."); return done(c.yes ? 0 : 3); }
    rmSync(inst.file, { force: true }); rmSync(sidecarPath(inst.file), { force: true });
    console.log(`Deleted ${inst.file}`);
  });

modelCmd.command("runtime").description("install the engine that runs embedded models (asks first)").option("-y, --yes", "agree without asking")
  .action(async (c) => {
    const pkg = platformPackage();
    if (!pkg) { console.error(`No prebuilt embedded runtime for ${process.platform}-${process.arch}. The offline engine still works.`); return done(2); }
    const dir = runtimeDir();
    process.stderr.write([
      "UNSTUCK would like to install the embedded AI runtime so models can run inside UNSTUCK.",
      "",
      `  Packages:   node-llama-cpp@${RUNTIME_VERSION} and ${pkg}@${RUNTIME_VERSION} (prebuilt llama.cpp)`,
      "  Source:     the npm registry (https://registry.npmjs.org)",
      "  License:    MIT",
      "  Size:       about 90 MB",
      `  Saved to:   ${dir}`,
      "",
      "Nothing is compiled or downloaded later: the runtime is loaded with building and downloading turned off.",
      "",
    ].join("\n"));
    if (!(await askConsent({ yes: c.yes }))) { console.error(process.stdin.isTTY ? "Not installed." : "Not installed: no terminal to ask for consent. Re-run with --yes to agree."); return done(c.yes ? 0 : 3); }
    mkdirSync(dir, { recursive: true });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const r = spawnSync(npm, ["install", "--prefix", dir, "--omit=optional", "--no-audit", "--no-fund", "--no-save", `node-llama-cpp@${RUNTIME_VERSION}`, `${pkg}@${RUNTIME_VERSION}`], {
      stdio: "inherit", env: { ...process.env, NODE_LLAMA_CPP_SKIP_DOWNLOAD: "true" }, shell: process.platform === "win32",
    });
    if (r.status !== 0) { console.error("Runtime install failed. The offline engine still works."); return done(1); }
    console.log(`Installed the embedded AI runtime in ${dir}`);
  });

program.parseAsync();
