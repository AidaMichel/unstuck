import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Collects facts about a project using only read-only operations:
// directory listing, reading ordinary text files, and fixed git inspection commands (no shell).
// Secret files (.env, keys, credentials) are never opened; only their names are noted.

export interface Commit { hash: string; subject: string; date: string; files: string[] }
export interface SecretHit { file: string; line: number; kind: string; masked: string }
export const isTestFile = (rel: string) => TEST_FILE.test(rel) || /(^|\/)(fixtures?|__mocks__|mocks?|examples?)\//.test(rel);
export interface Facts {
  root: string;
  name: string;
  intent: { source: string; text: string } | null;
  docs: string[];
  stack: string[];
  manifest: { type?: string; scripts: Record<string, string>; deps: string[]; description?: string } | null;
  git: {
    isRepo: boolean;
    branch?: string;
    modified: string[];
    untracked: string[];
    commits: Commit[];
    trackedSecretFiles: string[];
  };
  files: { total: number; source: string[]; tests: string[]; lines: Record<string, number>; truncated: boolean };
  lockfiles: string[];
  secrets: SecretHit[];
  todos: { file: string; line: number; text: string }[];
  injections: { file: string; line: number; text: string }[];
  imports: { file: string; spec: string }[];
  esmSyntaxFiles: string[];
  envVarsUsed: string[];
  hasEnvExample: boolean;
}

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".turbo", ".vercel", ".cache",
  "coverage", "__pycache__", ".pytest_cache", ".venv", "venv", "target", ".idea", ".vscode", "vendor", ".expo",
]);
/** Files whose contents are never read. */
export const SECRET_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$)[\w.-]+)?|id_rsa[\w.-]*|id_ed25519[\w.-]*|\.npmrc|\.netrc|\.pypirc|credentials(\.json)?|service[-_]?account[\w.-]*\.json)$|\.(pem|key|p12|pfx|keystore|jks)$|(^|\/)secrets?\//i;
const SOURCE_EXT = /\.(m?[jt]sx?|cjs|py|go|rb|rs|java|kt|swift|php|cs|vue|svelte|dart)$/;
const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[\w-]+\.py$/;
const MAX_FILES = 20_000;
const SYSTEM_ENV = /^(HOME|PATH|PWD|USER|SHELL|TERM|TMPDIR|TEMP|TMP|NODE_ENV|CI|DEBUG|LANG|GITHUB_\w+|RUNNER_\w+|npm_\w+)$/;
const MAX_READ = 512 * 1024;

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{32,}/, "OpenAI-style API key"],
  [/\b(sk|rk)_live_[A-Za-z0-9]{16,}/, "Stripe live key"],
  [/\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/, "GitHub token"],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/, "AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10,}/, "Supabase service_role key"],
  [/\b(postgres(ql)?|mysql|mongodb(\+srv)?):\/\/[^:\s/]+:[^@\s]{3,}@/, "database URL with password"],
];
const INJECTION = /(ignore (all )?(previous|prior|above) instructions|note to (ai|claude|the assistant|llms?|agents?)|\b(ai|llm) agents?\s*:)/i;

export function mask(s: string): string {
  return s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.quotepath=off", ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
    });
  } catch {
    return null;
  }
}

function walk(root: string, dir: string, out: string[]): boolean {
  let entries: string[];
  try { entries = readdirSync(dir).sort(); } catch { return true; }
  for (const name of entries) {
    if (out.length >= MAX_FILES) return false;
    const full = path.join(dir, name);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) continue; // never follow links out of the project
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name) && !walk(root, full, out)) return false; }
    else if (st.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return true;
}

function readText(root: string, rel: string): string | null {
  if (SECRET_FILE.test(rel)) return null;
  try {
    const full = path.join(root, rel);
    if (lstatSync(full).size > MAX_READ) return null;
    const buf = readFileSync(full);
    if (buf.includes(0)) return null; // binary
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function firstParagraph(md: string): string {
  const lines = md.split("\n").map((l) => l.trim());
  const out: string[] = [];
  for (const l of lines) {
    if (!l) { if (out.length) break; continue; }
    if (/^#/.test(l) || /^!\[|^<|^\[!\[|^```/.test(l)) { if (out.length) break; continue; }
    out.push(l);
    if (out.join(" ").length > 300) break;
  }
  return out.join(" ").slice(0, 400);
}

export function collectFacts(rootIn: string): Facts {
  const root = path.resolve(rootIn);
  const all: string[] = [];
  const complete = walk(root, root, all);

  // Intent
  const docs = all.filter((f) => /^(README|CLAUDE|AGENTS|GUARDIAN|CONTRIBUTING)(\.[a-z]+)?$/i.test(f) || /^docs\/[^/]+\.md$/i.test(f));
  let manifest: Facts["manifest"] = null;
  let name = path.basename(root);
  const pkgText = all.includes("package.json") ? readText(root, "package.json") : null;
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText);
      name = pkg.name || name;
      manifest = {
        type: pkg.type,
        scripts: pkg.scripts ?? {},
        deps: [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})],
        description: pkg.description,
      };
    } catch { /* invalid JSON is itself evidence; handled by rules */ manifest = { scripts: {}, deps: [] }; }
  }
  let intent: Facts["intent"] = null;
  const readme = docs.find((d) => /^README/i.test(d));
  const guardian = docs.find((d) => /^GUARDIAN/i.test(d));
  const gText = guardian ? readText(root, guardian) : null;
  const gWhat = gText?.match(/What it does[^:]*:\s*(.+)/i)?.[1]?.trim();
  if (gWhat && gWhat !== "-") intent = { source: guardian!, text: gWhat };
  else if (readme) { const t = firstParagraph(readText(root, readme) ?? ""); if (t) intent = { source: readme, text: t }; }
  if (!intent && manifest?.description) intent = { source: "package.json", text: manifest.description };

  // Stack
  const has = (re: RegExp) => all.some((f) => re.test(f));
  const deps = new Set(manifest?.deps ?? []);
  const stack: string[] = [];
  if (pkgText) stack.push(has(/\.tsx?$/) ? "TypeScript/Node" : "JavaScript/Node");
  for (const [dep, label] of [["react", "React"], ["next", "Next.js"], ["vue", "Vue"], ["svelte", "Svelte"], ["vite", "Vite"], ["express", "Express"], ["@supabase/supabase-js", "Supabase"], ["firebase", "Firebase"], ["prisma", "Prisma"], ["tailwindcss", "Tailwind"], ["react-native", "React Native"], ["expo", "Expo"]] as const) if (deps.has(dep)) stack.push(label);
  if (has(/^(requirements\.txt|pyproject\.toml|setup\.py)$/)) stack.push("Python");
  if (has(/^go\.mod$/)) stack.push("Go");
  if (has(/^Cargo\.toml$/)) stack.push("Rust");
  if (has(/^supabase\//) && !stack.includes("Supabase")) stack.push("Supabase");
  if (has(/^Dockerfile$/)) stack.push("Docker");
  if (has(/^\.github\/workflows\//)) stack.push("GitHub Actions");

  // Git
  const isRepo = git(root, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
  const g: Facts["git"] = { isRepo, modified: [], untracked: [], commits: [], trackedSecretFiles: [] };
  if (isRepo) {
    g.branch = git(root, ["branch", "--show-current"])?.trim() || "(detached)";
    for (const line of (git(root, ["status", "--porcelain=v1", "--untracked-files=normal"]) ?? "").split("\n")) {
      if (!line.trim()) continue;
      const file = line.slice(3);
      (line.startsWith("??") ? g.untracked : g.modified).push(file);
    }
    const log = git(root, ["log", "-n", "50", "--no-color", "--no-ext-diff", "--no-textconv", "--name-only", "--format=%x1e%h%x1f%s%x1f%as"]) ?? "";
    for (const block of log.split("\x1e").slice(1)) {
      const [head, ...rest] = block.split("\n");
      const [hash, subject, date] = head.split("\x1f");
      g.commits.push({ hash, subject, date, files: rest.map((s) => s.trim()).filter(Boolean) });
    }
    g.trackedSecretFiles = (git(root, ["ls-files"]) ?? "").split("\n").filter((f) => f && SECRET_FILE.test(f));
  }

  // File contents
  const source = all.filter((f) => SOURCE_EXT.test(f) && !TEST_FILE.test(f));
  const tests = all.filter((f) => TEST_FILE.test(f) && SOURCE_EXT.test(f));
  const lines: Record<string, number> = {};
  const secrets: SecretHit[] = [], todos: Facts["todos"] = [], injections: Facts["injections"] = [], imports: Facts["imports"] = [];
  const esm: string[] = [];
  const envVars = new Set<string>();
  const scan = all.filter((f) => SOURCE_EXT.test(f) || /\.(md|json|ya?ml|toml|txt|html|sql|sh)$/i.test(f) || /^Dockerfile$/.test(f));
  for (const rel of scan) {
    const text = readText(root, rel);
    if (text === null) continue;
    const ls = text.split("\n");
    if (SOURCE_EXT.test(rel)) lines[rel] = ls.length;
    ls.forEach((l, i) => {
      for (const [re, kind] of SECRET_PATTERNS) {
        const m = l.match(re);
        if (m) { secrets.push({ file: rel, line: i + 1, kind, masked: mask(m[0]) }); break; } // one hit per line
      }
      if (/\b(TODO|FIXME|HACK|XXX)\b/.test(l) && todos.length < 200) todos.push({ file: rel, line: i + 1, text: l.trim().slice(0, 120) });
      if (INJECTION.test(l)) injections.push({ file: rel, line: i + 1, text: l.trim().slice(0, 160) });
    });
    if (/\.(m?[jt]sx?|cjs)$/.test(rel)) {
      for (const m of text.matchAll(/(?:^|\n)\s*import\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        imports.push({ file: rel, spec: m[1] ?? m[2] ?? m[3] });
      }
      if (/\.js$/.test(rel) && !TEST_FILE.test(rel) && /(^|\n)\s*(import\s[^(]|export\s)/.test(text)) esm.push(rel);
      for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|import\.meta\.env\.([A-Z][A-Z0-9_]+)/g)) {
        const v = m[1] ?? m[2];
        if (!SYSTEM_ENV.test(v) && !isTestFile(rel)) envVars.add(v);
      }
    }
  }

  return {
    root, name, intent, docs, stack, manifest, git: g,
    files: { total: all.length, source, tests, lines, truncated: !complete },
    lockfiles: all.filter((f) => /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(f)),
    secrets, todos, injections, imports, esmSyntaxFiles: esm, envVarsUsed: [...envVars].sort(),
    hasEnvExample: all.some((f) => /(^|\/)\.env\.(example|sample|template)$/.test(f)),
  };
}
