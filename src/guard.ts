import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

// "AI proposes, code decides": every tool call the agent (or any specialist) makes passes through here.
// This is a policy filter on tool inputs, not an OS sandbox. It lowers risk; it cannot guarantee
// that a shell command has no side effects (see README, "Limits").

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "TodoWrite"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const DELEGATE_TOOLS = new Set(["Agent", "Task"]);

// A path that names a real secrets file (.env, .env.local, .env.production …) but not a template.
const ENV_IN_PATH = /(^|[\\/])\.env(\.(?!example\b|sample\b|template\b)[\w.-]+)?$/i;
// The same idea inside a shell command: ".env" as its own word, not "process.env".
const ENV_IN_CMD = /(^|[\s'"=:/<])\.env(\.(?!example\b|sample\b|template\b)[\w.-]+)?(?=$|[\s'";|&)>])/i;

/** Shell commands that are never allowed, in any mode. */
export const ALWAYS_BLOCKED: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, "recursive delete"],
  [/\bgit\b[^;&|]*\s(push|reset\s+--hard|clean|rebase|filter-branch|filter-repo|update-ref|reflog\s+expire|gc\s+--prune)\b/, "git history or remote change"],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, "running a script from the internet"],
  [/\b(sudo|su|doas|mkfs|shutdown|reboot)\b|\bdd\s+if=|\bchmod\s+(-R\s+)?777\b/, "system-level command"],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b|\bgh\s+release\s+create\b/, "publishing"],
  [/\bsupabase\s+(db\s+(push|reset)|migration\s+up|functions\s+deploy|secrets\s+set)\b|\bprisma\s+(migrate\s+(deploy|reset|dev)|db\s+push)\b|\bdrizzle-kit\s+(push|migrate)\b|\bknex\s+migrate\b|\brails\s+db:/, "database migration or deploy"],
  [/\b(vercel|netlify|firebase|fly|railway|heroku|wrangler)\b[^;&|]*\b(deploy|--prod|publish)\b/, "deploying"],
  [/(^|[\s;&|(])(env|printenv)(\s*$|\s*[;&|)]|\s+-)|\bexport\s+-p\b|\bset\s*$/, "dumping environment secrets"],
  [ENV_IN_CMD, "touching .env secrets"],
  [/\bgit\s+config\b[^;&|]*\s--(global|system)\b/, "changing global git config"],
];

/** In read-only modes, shell commands that change files, git state or installs are blocked. */
export const MUTATING: [RegExp, string][] = [
  [/(^|[\s;&|(])(rm|mv|cp|touch|mkdir|rmdir|truncate|tee|chmod|chown|ln|install|unlink|shred)\s/, "changes files"],
  [/\b(sed|perl)\s+(-[a-zA-Z]*i|--in-place)\b/, "edits files in place"],
  [/(^|[^0-9&>=-])>{1,2}\s*(?!&|\/dev\/null\b)[^\s&]/, "writes output to a file"],
  [/\bgit\b[^;&|]*\s(commit|add|checkout|switch|stash|merge|tag|apply|am|cherry-pick|restore|rm|mv|revert|branch\s+-[dDmM]|worktree|submodule|pull|fetch|init)\b/, "changes git state"],
  [/\b(npm|pnpm|yarn|bun)\s+(install|i|ci|add|remove|rm|uninstall|update|upgrade|up|link|dedupe|audit\s+fix|pkg\s+set)\b|\bnpx\s+[^\s]*\s*--yes\b/, "changes installed packages"],
  [/\b(pip3?|poetry|uv|pipenv|gem|cargo|go)\s+(install|add|remove|uninstall|get|update)\b/, "changes installed packages"],
  [/\b(writeFile|appendFile|unlink|rmSync|rmdirSync|renameSync|copyFile|mkdirSync)\w*\s*\(|open\s*\([^)]*['"][wax]\+?['"]|\.write_text\s*\(|\.write_bytes\s*\(|os\.(remove|unlink|rename)\s*\(|shutil\./, "writes files from a script"],
  [/(^|\s)--fix\b|(^|\s)--write\b|\bprettier\b[^;&|]*\s--write|\beslint\b[^;&|]*\s--fix|\b(black|ruff\s+format|gofmt\s+-w|cargo\s+fmt)\b/, "auto-fixes or formats files"],
  [/\b(jest|vitest)\b[^;&|]*\s(-u|--update(Snapshot)?)\b/, "updates test snapshots"],
];

export function readLockedFiles(repo: string): string[] {
  const file = path.join(repo, "GUARDIAN.md");
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  const locked: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^#{1,4}\s+Locked files/i.test(line)) { inSection = true; continue; }
    if (/^#{1,4}\s/.test(line) || /^---\s*$/.test(line)) { inSection = false; continue; }
    if (!inSection) continue;
    const m = line.match(/^\s*[-*]\s+`?([^`\s]+)`?/);
    if (m && m[1] !== "-") locked.push(m[1].replace(/^\.?\//, ""));
  }
  return [...new Set(locked)];
}

/** Resolve a path the way the OS will see it, following symlinks for the part that exists. */
function realTarget(target: string, repo: string): string {
  let p = path.resolve(repo, target);
  const tail: string[] = [];
  while (!existsSync(p) && path.dirname(p) !== p) {
    tail.unshift(path.basename(p));
    p = path.dirname(p);
  }
  try { p = realpathSync(p); } catch { /* keep as is */ }
  return path.join(p, ...tail);
}

export function isInside(target: string, repo: string): boolean {
  const root = (() => { try { return realpathSync(repo); } catch { return path.resolve(repo); } })();
  const rel = path.relative(root, realTarget(target, repo));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function lockedMatch(target: string, repo: string, locked: string[]): string | null {
  const root = (() => { try { return realpathSync(repo); } catch { return path.resolve(repo); } })();
  const rel = path.relative(root, realTarget(target, repo)).split(path.sep).join("/");
  for (const p of locked) {
    if (rel === p || rel.endsWith("/" + p)) return p;
    if (p.endsWith("/") && (rel.startsWith(p) || rel.includes("/" + p))) return p; // locked folder
  }
  return null;
}

// Reading a variable whose name looks secret, e.g. echo $ANTHROPIC_API_KEY.
const SECRET_VAR = /\$\{?[A-Za-z_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z_]*\}?/i;

/*
 * Read-only shell: an ALLOWLIST of inspection commands.
 * A denylist cannot make arbitrary shell read-only (any project script, interpreter or tool flag can
 * write files), so in read-only modes anything not listed here is refused. This is still a best-effort
 * filter on the command text, not a sandbox: see "Limits" in the README.
 */
const READONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "find", "sort", "cut", "tr", "jq",
  "file", "stat", "du", "echo", "printf", "pwd", "which", "diff", "cmp", "basename", "dirname", "realpath",
  "readlink", "nl", "column", "md5sum", "sha1sum", "sha256sum", "true", "git",
]);
const READONLY_GIT = new Set([
  "log", "diff", "show", "status", "blame", "ls-files", "ls-tree", "rev-parse", "rev-list", "describe",
  "shortlog", "grep", "cat-file", "merge-base", "name-rev", "count-objects",
]);
/** Flags that make an otherwise read-only command write files or run other programs. */
const UNSAFE_FLAGS: Record<string, RegExp> = {
  find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/,
  sort: /^(-o|--output(=.*)?|-[a-zA-Z]*o.*)$/,
  rg: /^--pre(=.*)?$/,
  git: /^(-c|-C|--output(=.*)?|--ext-diff|--textconv|--filters|-O.*|--open-files-in-pager(=.*)?|--exec-path(=.*)?|--git-dir(=.*)?|--work-tree(=.*)?|--no-index|--contents(=.*)?)$/,
  file: /^(-C|--compile)$/,
};

// Commands whose arguments are plain text, not files.
const TEXT_ONLY = new Set(["echo", "printf", "tr", "which", "true", "pwd", "basename", "dirname"]);
const SEARCH = new Set(["grep", "egrep", "fgrep", "rg"]);
// Short options that take a value (next word, or the rest of the word): not file names.
const VALUE_SHORT: Record<string, string> = {
  grep: "ABCmd", egrep: "ABCmd", fgrep: "ABCmd", rg: "ABCmgtTjM", head: "nc", tail: "nc", cut: "dfc", sort: "tkS", du: "d",
};
const VALUE_LONG = /^--(context|after-context|before-context|max-count|glob|iglob|type|type-not|threads|max-columns|lines|bytes|delimiter|fields|key|field-separator|max-depth)$/;
const FIND_VALUE = /^-(name|iname|path|ipath|wholename|iwholename|regex|iregex|type|maxdepth|mindepth|size|mtime|mmin|atime|ctime|perm|user|group|newer)$/;

/**
 * The words of a command that may name files, for the outside-the-project check.
 * Search patterns (grep/rg), jq filters, option values and text arguments are skipped so that
 * `grep -rn "/api/" src` is not mistaken for a path. git is skipped: it confines pathspecs to the
 * work tree, and its escape hatches (-C, --git-dir, --work-tree, --no-index, --contents) are refused as unsafe flags.
 */
export function pathArgs(name: string, args: string[]): string[] {
  if (TEXT_ONLY.has(name) || name === "git") return [];
  const out: string[] = [];
  const search = SEARCH.has(name);
  const shortValues = VALUE_SHORT[name] ?? "";
  let needPattern = search || name === "jq";
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!endOfOptions && a === "--") { endOfOptions = true; continue; }
    if (!endOfOptions && a.startsWith("--")) {
      const eq = a.indexOf("=");
      const opt = eq > 0 ? a.slice(0, eq) : a;
      if (search && opt === "--regexp") { needPattern = false; if (eq < 0) i++; continue; }
      if (search && opt === "--file") { needPattern = false; if (eq > 0) out.push(a.slice(eq + 1)); else if (i + 1 < args.length) out.push(args[++i]); continue; }
      if (eq > 0 && /(file|from|dir|path)/i.test(opt)) { out.push(a.slice(eq + 1)); continue; }
      if (eq < 0 && VALUE_LONG.test(opt)) i++;
      continue;
    }
    if (!endOfOptions && name === "find" && FIND_VALUE.test(a)) { i++; continue; }
    if (!endOfOptions && a.startsWith("-") && a.length > 1) {
      // A cluster like -rn, -A3, -e PATTERN, -rnf FILE, -fFILE.
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        const isPattern = search && ch === "e";
        const isFile = search && ch === "f";
        if (!isPattern && !isFile && !shortValues.includes(ch)) continue;
        const rest = a.slice(j + 1);
        const value = rest || (i + 1 < args.length ? args[++i] : "");
        if (isPattern) needPattern = false;
        if (isFile) { needPattern = false; if (value) out.push(value); }
        break;
      }
      continue;
    }
    if (needPattern) { needPattern = false; continue; } // first positional is the search pattern / jq filter
    out.push(a);
  }
  return out;
}

/** Split a command into pipeline segments and words. Returns null if it uses shell features we refuse. */
export function parseReadOnly(cmd: string): { segments: string[][] } | { error: string } {
  // Harmless redirections we accept, removed before parsing.
  const text = cmd.replace(/(^|\s)(?:[12]?>|&>)\s*\/dev\/null(?=\s|$)/g, " ").replace(/(^|\s)2>&1(?=\s|$)/g, " ");
  const segments: string[][] = [];
  let words: string[] = [], word = "", inWord = false, quote: "'" | '"' | null = null;
  const endWord = () => { if (inWord) words.push(word); word = ""; inWord = false; };
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    if (quote === '"') {
      if (c === '"') { quote = null; continue; }
      if (c === "$" || c === "`") return { error: "variable or command expansion is not allowed in read-only mode" };
      if (c === "\\" && i + 1 < text.length) { word += text[++i]; continue; }
      word += c; continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === "\\") { if (i + 1 < text.length) { word += text[++i]; inWord = true; } continue; }
    if (c === "$" || c === "`") return { error: "variable or command expansion is not allowed in read-only mode" };
    if (c === ">" || c === "<") return { error: "redirecting to or from files is not allowed in read-only mode" };
    if (c === "(" || c === ")" || c === "{" || c === "}") return { error: "subshells and groups are not allowed in read-only mode" };
    if (c === "|") { if (text[i + 1] === "|") i++; endSegment(); continue; }
    if (c === "&") { if (text[i + 1] === "&") { i++; endSegment(); continue; } return { error: "background jobs are not allowed in read-only mode" }; }
    if (c === ";" || c === "\n") { endSegment(); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    word += c; inWord = true;
  }
  if (quote) return { error: "unbalanced quotes" };
  endSegment();
  if (!segments.length) return { error: "empty command" };
  return { segments };
}

function checkReadOnly(cmd: string, repo: string): string | null {
  const parsed = parseReadOnly(cmd);
  if ("error" in parsed) return parsed.error;
  for (const [name, ...args] of parsed.segments) {
    if (!READONLY_COMMANDS.has(name)) {
      return `read-only mode only allows inspection commands; \`${name}\` is not one (project scripts need --run-checks)`;
    }
    const unsafe = UNSAFE_FLAGS[name];
    if (unsafe) for (const a of args) if (unsafe.test(a)) return `\`${name} ${a}\` can write files or run programs`;
    if (name === "git") {
      const sub = args.find((a) => !a.startsWith("-"));
      if (!sub || !READONLY_GIT.has(sub)) return `read-only mode only allows git inspection commands (git ${sub ?? ""})`;
    }
    // Every word that may name a file must resolve inside the project, whether or not it exists yet.
    // isInside() follows symlinks for the existing part of the path, so links pointing out are caught too.
    for (const a of pathArgs(name, args)) {
      if (a === "/dev/null") continue;
      const resolved = a.startsWith("~") ? path.join(process.env.HOME || os.homedir(), a.slice(1)) : path.resolve(repo, a);
      if (!isInside(resolved, repo)) return `reading outside the project is not allowed: ${a}`;
    }
  }
  return null;
}

export interface CommandPolicy {
  /** fix mode: may change files. */
  allowWrites: boolean;
  /** --run-checks: may run project scripts (tests, build, lint) in read-only modes. */
  allowScripts?: boolean;
  repo?: string;
}

/** Why a shell command is blocked, or null if it is allowed. */
export function checkCommand(cmd: string, policy: CommandPolicy): string | null {
  for (const [re, why] of ALWAYS_BLOCKED) if (re.test(cmd)) return why;
  if (SECRET_VAR.test(cmd)) return "reading secret environment variables";
  if (policy.allowWrites) return null;
  if (!policy.allowScripts) return checkReadOnly(cmd, policy.repo ?? process.cwd());
  // --run-checks: project scripts may run; still refuse commands that obviously change files.
  for (const [re, why] of MUTATING) if (re.test(cmd)) return `read-only mode: this command ${why}`;
  return null;
}

export interface GuardOptions {
  repo: string;
  allowWrites: boolean;
  allowScripts?: boolean;
  allowDelegation?: boolean;
  log?: (msg: string) => void;
}

export function makeGuard({ repo, allowWrites, allowScripts = false, allowDelegation = false, log }: GuardOptions): CanUseTool {
  const locked = readLockedFiles(repo);
  const deny = (message: string): PermissionResult => {
    log?.(`✋ blocked: ${message}`);
    return { behavior: "deny", message };
  };
  const allow = (input: Record<string, unknown>): PermissionResult => ({ behavior: "allow", updatedInput: input });

  return async (toolName, input) => {
    if (READ_TOOLS.has(toolName)) {
      for (const key of ["file_path", "path", "notebook_path"]) {
        const p = input[key];
        if (typeof p !== "string" || !p) continue;
        if (!isInside(p, repo)) return deny(`reading outside the project is not allowed: ${p}`);
        if (ENV_IN_PATH.test(p)) return deny("reading .env secrets is not allowed; note where secrets live instead");
      }
      if (typeof input.glob === "string" && /\.env\b(?!\.(example|sample|template))/i.test(input.glob)) {
        return deny("searching .env secrets is not allowed");
      }
      return allow(input);
    }

    if (WRITE_TOOLS.has(toolName)) {
      if (!allowWrites) return deny("this mode is read-only; propose the change in the report instead");
      const p = (input.file_path ?? input.notebook_path) as string | undefined;
      if (!p) return deny("write without a file path");
      if (!isInside(p, repo)) return deny(`writing outside the project is not allowed: ${p}`);
      const hit = lockedMatch(p, repo, locked);
      if (hit) return deny(`${p} is LOCKED in GUARDIAN.md (${hit}); it cannot be edited`);
      if (ENV_IN_PATH.test(p) || /\.(pem|key|p12|pfx)$/i.test(p)) return deny("editing secrets files is not allowed");
      if (/(^|\/)\.git\//.test(p) || /(^|\/)\.github\/workflows\//.test(p)) return deny("editing git internals or CI workflows is not allowed");
      return allow(input);
    }

    if (toolName === "Bash") {
      const cmd = String(input.command ?? "");
      const why = checkCommand(cmd, { allowWrites, allowScripts, repo });
      if (why) return deny(`${why}: ${cmd.slice(0, 160)}`);
      return allow(input);
    }

    if (DELEGATE_TOOLS.has(toolName) && allowDelegation) return allow(input);

    return deny(`tool ${toolName} is not available in UNSTUCK`);
  };
}
