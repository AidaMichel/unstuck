import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

// "AI proposes, code decides": every tool call passes through here.

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "TodoWrite"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Shell commands that are never allowed, in any mode.
const ALWAYS_BLOCKED: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?\b.*(\s\/|\s~|\s\*)/i, // rm -rf on root/home/wildcard
  /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|rebase|filter-branch)\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/i, // pipe-to-shell
  /\b(sudo|chmod\s+-R\s+777|mkfs|dd\s+if=)\b/i,
  /\b(npm|pnpm|yarn)\s+publish\b/i,
  /\b(supabase\s+db\s+(push|reset)|prisma\s+migrate\s+(deploy|reset)|drizzle-kit\s+push)\b/i,
  /\b(vercel|netlify|firebase)\s+(deploy|--prod)\b/i,
  /(^|[\s;&|])(env|printenv)(\s|$)/, // dumping secrets
  /\bcat\s+[^|;&]*\.env\b/i,
];

// In read-only modes, shell commands that change files or git state are blocked.
const MUTATING: RegExp[] = [
  /(^|[\s;&|])(rm|mv|cp|touch|mkdir|rmdir|truncate|tee|chmod|chown|ln)\s/,
  /\bsed\s+-i\b/,
  /(^|[^2&])>{1,2}\s*[^&\s]/, // output redirection to a file (not 2>&1)
  /\bgit\s+(commit|add|checkout|switch|stash|merge|tag|apply|am|cherry-pick|restore|rm|mv)\b/,
  /\b(npm|pnpm|yarn|bun)\s+(install|i|add|remove|uninstall|update|upgrade)\b/,
  /\bpip3?\s+install\b/,
];

export function readLockedFiles(repo: string): string[] {
  const file = path.join(repo, "GUARDIAN.md");
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  const locked: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^#{2,3}\s+Locked files/i.test(line)) { inSection = true; continue; }
    if (/^#{1,3}\s/.test(line) || /^---\s*$/.test(line)) { inSection = false; continue; }
    if (!inSection) continue;
    const m = line.match(/^\s*[-*]\s+`?([^`\s]+)`?/);
    if (m) locked.push(m[1]);
  }
  return locked;
}

function isLocked(target: string, repo: string, locked: string[]): string | null {
  const rel = path.relative(repo, path.resolve(repo, target)).split(path.sep).join("/");
  for (const pattern of locked) {
    const p = pattern.replace(/^\.?\//, "");
    if (rel === p || rel.endsWith("/" + p)) return pattern;
  }
  return null;
}

function inside(target: string, repo: string): boolean {
  const rel = path.relative(repo, path.resolve(repo, target));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface GuardOptions {
  repo: string;
  allowWrites: boolean;
  log?: (msg: string) => void;
}

export function makeGuard({ repo, allowWrites, log }: GuardOptions): CanUseTool {
  const locked = readLockedFiles(repo);
  const deny = (message: string): PermissionResult => {
    log?.(`blocked: ${message}`);
    return { behavior: "deny", message };
  };
  const allow = (input: Record<string, unknown>): PermissionResult => ({ behavior: "allow", updatedInput: input });

  return async (toolName, input) => {
    if (READ_TOOLS.has(toolName)) {
      const p = (input.file_path ?? input.path) as string | undefined;
      if (p && !inside(p, repo)) return deny(`reading outside the project is not allowed: ${p}`);
      if (p && /(^|\/)\.env(\.|$)/.test(p) && !/\.env\.(example|sample|template)$/.test(p)) {
        return deny("reading .env files is not allowed; report that secrets live there instead");
      }
      return allow(input);
    }

    if (WRITE_TOOLS.has(toolName)) {
      if (!allowWrites) return deny("this mode is read-only; propose the change in the report instead");
      const p = (input.file_path ?? input.notebook_path) as string | undefined;
      if (!p) return deny("write without a file path");
      if (!inside(p, repo)) return deny(`writing outside the project is not allowed: ${p}`);
      const hit = isLocked(p, repo, locked);
      if (hit) return deny(`${p} is LOCKED in GUARDIAN.md (${hit}); it cannot be edited`);
      if (/(^|\/)(\.env|.*\.pem|.*\.key)$/.test(p)) return deny("editing secrets files is not allowed");
      return allow(input);
    }

    if (toolName === "Bash") {
      const cmd = String(input.command ?? "");
      for (const re of ALWAYS_BLOCKED) if (re.test(cmd)) return deny(`command not allowed: ${cmd}`);
      if (!allowWrites) for (const re of MUTATING) if (re.test(cmd)) {
        return deny(`read-only mode: this command would change files or git state: ${cmd}`);
      }
      return allow(input);
    }

    return deny(`tool ${toolName} is not available in UNSTUCK`);
  };
}
