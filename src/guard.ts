import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

// "AI proposes, code decides": every tool call the agent (or any specialist) makes passes through here.

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

/** Why a shell command is blocked, or null if it is allowed. */
export function checkCommand(cmd: string, allowWrites: boolean): string | null {
  for (const [re, why] of ALWAYS_BLOCKED) if (re.test(cmd)) return why;
  if (!allowWrites) for (const [re, why] of MUTATING) if (re.test(cmd)) return `read-only mode: this command ${why}`;
  return null;
}

export interface GuardOptions {
  repo: string;
  allowWrites: boolean;
  allowDelegation?: boolean;
  log?: (msg: string) => void;
}

export function makeGuard({ repo, allowWrites, allowDelegation = false, log }: GuardOptions): CanUseTool {
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
      const why = checkCommand(cmd, allowWrites);
      if (why) return deny(`${why}: ${cmd.slice(0, 160)}`);
      return allow(input);
    }

    if (DELEGATE_TOOLS.has(toolName) && allowDelegation) return allow(input);

    return deny(`tool ${toolName} is not available in UNSTUCK`);
  };
}
