import { builtinModules } from "node:module";
import path from "node:path";
import { isTestFile, type Facts } from "./facts.js";

export type Severity = "P0" | "P1" | "P2" | "P3";
export interface Finding {
  id: string;
  rule: string;
  severity: Severity;
  verified: boolean;
  title: string;      // plain language
  why: string;        // impact
  evidence: string[]; // file:line or command — observation
  next: string;       // fix (verified) or how to confirm (hypothesis)
}

// A commit counts toward a fix loop if its message starts with fix/revert/hotfix, or uses loop words anywhere.
const FIXY = /^(fix(e[sd])?|revert(ed)?|hotfix|bugfix|patch)\b|\b(again|still (broken|failing|not)|undo|re-?fix|another (fix|try|attempt)|try (again|to fix)|attempt \d|broken again)\b/i;
const VARIANT = /^(.+?)(?:[-_.]?(?:v?\d+|new|old|copy|backup|bak|orig|final|tmp|temp|alt|legacy|fixed|working))+$/i;
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function pkgName(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || BUILTINS.has(spec)) return null;
  if (/^(@\/|~\/|#|\$|virtual:)/.test(spec)) return null; // path aliases
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function runRules(f: Facts): Finding[] {
  const out: Omit<Finding, "id">[] = [];
  const add = (x: Omit<Finding, "id">) => out.push(x);

  // ---- Security ----
  const realSecrets = f.secrets.filter((s) => !isTestFile(s.file));
  const testSecrets = f.secrets.filter((s) => isTestFile(s.file));
  if (realSecrets.length) {
    add({
      rule: "secret-in-code", severity: "P0", verified: true,
      title: "Secret keys are written directly in project files",
      why: "Anyone who can see the code (or its git history) can use these keys and run up bills or read your data.",
      evidence: realSecrets.slice(0, 6).map((s) => `${s.file}:${s.line} — looks like a ${s.kind}, ${s.masked}`),
      next: "Revoke and replace these keys with the provider today, move them to environment variables, and remove them from git history.",
    });
  }
  if (testSecrets.length) {
    add({
      rule: "secret-in-tests", severity: "P1", verified: false,
      title: "Test or example files contain values shaped like real keys",
      why: "These are usually fake test values, but a real key pasted into a test is just as exposed as one in the app.",
      evidence: testSecrets.slice(0, 4).map((s) => `${s.file}:${s.line} — shaped like a ${s.kind}, ${s.masked}`),
      next: "Check each one with its provider (or ask whoever added it). If any is real, revoke it; if fake, make that obvious, e.g. include FAKE in the value.",
    });
  }
  if (f.git.trackedSecretFiles.length) {
    add({
      rule: "secret-file-tracked", severity: "P0", verified: true,
      title: "Secret files are committed to git",
      why: "Committed secret files travel with every clone and copy of the repository.",
      evidence: f.git.trackedSecretFiles.slice(0, 6).map((p) => `\`git ls-files\` — ${p} is tracked (contents not opened)`),
      next: "Rotate the secrets inside, run `git rm --cached <file>`, add it to .gitignore, and clean it from history.",
    });
  }
  if (f.injections.length) {
    add({
      rule: "prompt-injection", severity: "P1", verified: true,
      title: "Files contain instructions aimed at AI tools",
      why: "AI coding tools that read these files may follow them, e.g. deleting tests or running commands you didn't ask for.",
      evidence: f.injections.slice(0, 4).map((i) => `${i.file}:${i.line} — "${i.text}"`),
      next: "Check who added these lines and remove them unless you wrote them on purpose.",
    });
  }

  // ---- Stuck patterns in history ----
  const commits = f.git.commits;
  const reverts = commits.filter((c) => /^revert\b/i.test(c.subject));
  const fixCounts = new Map<string, string[]>();
  for (const c of commits.slice(0, 30)) {
    if (!FIXY.test(c.subject)) continue;
    for (const file of c.files) fixCounts.set(file, [...(fixCounts.get(file) ?? []), `${c.hash} "${c.subject}"`]);
  }
  const loops = [...fixCounts.entries()].filter(([, cs]) => cs.length >= 3).sort((a, b) => b[1].length - a[1].length);
  if (loops.length || reverts.length) {
    const ev = [
      ...loops.slice(0, 3).map(([file, cs]) => `\`git log\` — ${file} changed by ${cs.length} fix/revert commits: ${cs.slice(0, 3).join(", ")}`),
      ...reverts.slice(0, 3).map((c) => `\`git log\` — ${c.hash} "${c.subject}" (${c.date})`),
    ];
    add({
      rule: "fix-loop", severity: "P1", verified: true,
      title: loops.length ? "The same files keep getting \"fixed\" again and again" : "Recent work has been reverted",
      why: "Repeated fixes and reverts on the same code usually mean the real cause hasn't been found, and each attempt undoes another.",
      evidence: ev,
      next: `Stop patching. Write down what "working" means for ${loops[0]?.[0] ?? reverts[0]?.files[0] ?? "this area"} as one concrete check, then compare the last version that passed it with the current one (\`git log -p -- <file>\`).`,
    });
  }
  const churn = new Map<string, number>();
  for (const c of commits.slice(0, 30)) for (const file of c.files) churn.set(file, (churn.get(file) ?? 0) + 1);
  const hot = [...churn.entries()].filter(([file, n]) => n >= 6 && !/(lock|\.lock|CHANGELOG)/i.test(file)).sort((a, b) => b[1] - a[1]);
  if (hot.length && !loops.length) {
    add({
      rule: "hotspot", severity: "P2", verified: true,
      title: "A few files change in almost every commit",
      why: "Files that change constantly are where bugs and conflicts concentrate.",
      evidence: hot.slice(0, 4).map(([file, n]) => `\`git log -n 30\` — ${file} changed in ${n} of the last ${Math.min(30, commits.length)} commits`),
      next: `Review ${hot[0][0]} first; consider splitting it so each change touches less.`,
    });
  }
  const pending = f.git.modified.length + f.git.untracked.length;
  if (pending >= 15) {
    add({
      rule: "uncommitted-pile", severity: "P2", verified: true,
      title: "Lots of work is uncommitted",
      why: "Uncommitted changes can't be compared, reviewed or rolled back, and are easily lost or overwritten by AI tools.",
      evidence: [`\`git status\` — ${f.git.modified.length} modified, ${f.git.untracked.length} untracked files`],
      next: "Commit what works now in small, named commits, so the next change can be undone safely.",
    });
  }
  if (!f.git.isRepo) {
    add({
      rule: "no-git", severity: "P1", verified: true,
      title: "The project isn't under version control",
      why: "Without git there's no way to see what changed, compare with a working version, or undo a bad change.",
      evidence: ["`git rev-parse` — not a git repository"],
      next: "Run `git init`, then commit the current state before changing anything else.",
    });
  }

  // ---- Competing / duplicate implementations ----
  const byStem = new Map<string, string[]>();
  for (const file of f.files.source) {
    const ext = path.extname(file);
    const stem = path.join(path.dirname(file), path.basename(file, ext).replace(VARIANT, "$1")) + ext;
    byStem.set(stem, [...(byStem.get(stem) ?? []), file]);
  }
  const imported = new Set(f.imports.map((i) => path.basename(i.spec).replace(/\.[a-z]+$/, "")));
  for (const [, group] of byStem) {
    if (group.length < 2) continue;
    const unused = group.filter((g) => !imported.has(path.basename(g, path.extname(g))));
    const usedOne = unused.length && unused.length < group.length;
    add({
      rule: "competing-versions", severity: "P2", verified: Boolean(usedOne),
      title: "There are competing versions of the same code",
      why: "AI tools often add a \"v2\" next to the old version; then fixes land in one copy while the app runs the other.",
      evidence: group.map((g) => `${g} — ${f.files.lines[g] ?? "?"} lines${imported.has(path.basename(g, path.extname(g))) ? ", imported elsewhere" : ", not imported anywhere"}`),
      next: usedOne
        ? `Decide which version is the real one. ${unused.join(", ")} ${unused.length === 1 ? "is" : "are"} not imported anywhere; delete or merge after confirming.`
        : "Check which file the app actually uses (search for its imports), then keep one.",
    });
  }

  // ---- Tests ----
  if (f.files.source.length >= 3 && !f.files.tests.length) {
    add({
      rule: "no-tests", severity: "P1", verified: true,
      title: "There are no automated tests",
      why: "Without tests, every change (by you or an AI) can silently break something that used to work — a classic cause of fix loops.",
      evidence: [`${f.files.source.length} source files, 0 test files found`],
      next: "Add one test for the single most important user flow before making more changes.",
    });
  } else if (f.files.tests.length && f.manifest && !f.manifest.scripts.test) {
    add({
      rule: "tests-not-wired", severity: "P2", verified: true,
      title: "Tests exist but there's no command to run them",
      why: "Tests nobody runs don't catch anything.",
      evidence: [`${f.files.tests.length} test files; package.json has no "test" script`],
      next: "Add a \"test\" script to package.json and run it before every commit.",
    });
  }

  // ---- Node module setup ----
  if (f.manifest && f.manifest.type !== "module" && f.esmSyntaxFiles.length) {
    add({
      rule: "esm-mismatch", severity: "P2", verified: false,
      title: "Code uses modern `import` syntax but the project isn't marked as a module",
      why: "Depending on the Node version this can crash at start-up or behave differently on different machines.",
      evidence: [`package.json — no "type": "module"`, ...f.esmSyntaxFiles.slice(0, 3).map((x) => `${x} — uses import/export`)],
      next: `Run the app once (\`${f.manifest.scripts.start ? "npm start" : "node " + f.esmSyntaxFiles[0]}\`) and look for "Cannot use import statement" or a module warning.`,
    });
  }
  if (f.manifest) {
    const declared = new Set(f.manifest.deps);
    const missing = new Map<string, string>();
    for (const i of f.imports) {
      const p = pkgName(i.spec);
      if (p && !declared.has(p) && !missing.has(p)) missing.set(p, i.file);
    }
    if (missing.size) {
      add({
        rule: "undeclared-deps", severity: "P1", verified: false,
        title: "Code imports packages that aren't listed in package.json",
        why: "These may be missing on a fresh install, or be packages an AI tool invented that don't exist.",
        evidence: [...missing.entries()].slice(0, 6).map(([p, file]) => `${file} — imports "${p}", not in package.json`),
        next: "Run `npm ls <package>` for each; add real ones to package.json and remove imports of ones that don't exist.",
      });
    }
  }
  if (f.lockfiles.length > 1) {
    add({
      rule: "multiple-lockfiles", severity: "P2", verified: true,
      title: "More than one package manager has been used",
      why: "Different lockfiles install different versions, so the app can work on one machine and break on another.",
      evidence: f.lockfiles.map((l) => `${l} — present`),
      next: "Pick one package manager, delete the other lockfiles, and reinstall.",
    });
  }

  // ---- Size / clarity ----
  const giants = Object.entries(f.files.lines).filter(([file, n]) => n >= 800 && f.files.source.includes(file)).sort((a, b) => b[1] - a[1]);
  if (giants.length) {
    add({
      rule: "giant-files", severity: "P2", verified: true,
      title: "Some files are very large",
      why: "Very large files are hard for people and AI tools to change safely; edits in one part break another.",
      evidence: giants.slice(0, 4).map(([file, n]) => `${file} — ${n} lines`),
      next: `Split ${giants[0][0]} by responsibility before adding features to it.`,
    });
  }
  if (!f.intent) {
    add({
      rule: "no-goal", severity: "P2", verified: true,
      title: "The project doesn't say what it's for",
      why: "Without a written goal, neither people nor AI tools can tell whether a change moves it forward.",
      evidence: ["No README summary, GUARDIAN.md or package.json description found"],
      next: "Write two sentences at the top of README.md: who it's for and what it must do.",
    });
  }
  if (f.envVarsUsed.length && !f.hasEnvExample) {
    add({
      rule: "no-env-example", severity: "P3", verified: true,
      title: "Required settings aren't documented",
      why: "Someone setting up the project can't tell which environment variables it needs.",
      evidence: [`Code reads ${f.envVarsUsed.slice(0, 6).join(", ")}${f.envVarsUsed.length > 6 ? "…" : ""}; no .env.example found`],
      next: "Add a .env.example listing each variable name with a fake value.",
    });
  }
  if (f.todos.length >= 10) {
    add({
      rule: "todo-pile", severity: "P3", verified: true,
      title: "Many unfinished TODO/FIXME notes",
      why: "A pile of TODOs often marks half-finished features.",
      evidence: [`${f.todos.length} TODO/FIXME/HACK markers, e.g. ${f.todos[0].file}:${f.todos[0].line}`],
      next: "Turn the ones on the core user flow into tasks; delete the rest.",
    });
  }

  const order = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
  out.sort((a, b) => order[a.severity] - order[b.severity] || Number(b.verified) - Number(a.verified));
  return out.map((x, i) => ({ ...x, id: `F${i + 1}` }));
}

export function counts(findings: Finding[]): Record<Severity, number> {
  const c = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const x of findings) c[x.severity]++;
  return c;
}
