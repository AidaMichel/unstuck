import { createHash } from "node:crypto";
import { readdirSync, readFileSync, lstatSync } from "node:fs";
import path from "node:path";

// The guard blocks known-bad actions. The snapshot is an observer: it fingerprints the project
// before a run and compares afterwards, so changes are reported. It never writes or restores
// anything — another editor or agent may be working in the same folder, and its changes are not ours to undo.

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".turbo", ".vercel",
  ".cache", "coverage", ".nyc_output", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".venv", "venv", "target", ".gradle", ".idea", ".vscode", "tmp", ".parcel-cache", "storybook-static",
]);
const SKIP_FILES = /(\.tsbuildinfo|\.log|\.DS_Store|\.pyc)$|^unstuck-(fix-)?report\.md$|^unstuck-comment\.md$/;
const MAX_FILES = 50_000;

export interface Snapshot {
  hashes: Map<string, string>;
  truncated: boolean;
}

function walk(root: string, dir: string, out: string[]): boolean {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return true; }
  for (const name of entries) {
    if (out.length >= MAX_FILES) return false;
    const full = path.join(dir, name);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      if (!walk(root, full, out)) return false;
    } else if (st.isFile() && !SKIP_FILES.test(name)) {
      out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  return true;
}

export function takeSnapshot(repo: string): Snapshot {
  const files: string[] = [];
  const complete = walk(repo, repo, files);
  const hashes = new Map<string, string>();
  for (const rel of files) {
    try {
      const buf = readFileSync(path.join(repo, rel));
      hashes.set(rel, createHash("sha256").update(buf).digest("hex"));
    } catch { /* unreadable: skip */ }
  }
  return { hashes, truncated: !complete };
}

export interface Diff { added: string[]; changed: string[]; removed: string[] }

export function diffSnapshots(before: Snapshot, after: Snapshot): Diff {
  const added: string[] = [], changed: string[] = [], removed: string[] = [];
  for (const [rel, h] of after.hashes) {
    const prev = before.hashes.get(rel);
    if (prev === undefined) added.push(rel);
    else if (prev !== h) changed.push(rel);
  }
  for (const rel of before.hashes.keys()) if (!after.hashes.has(rel)) removed.push(rel);
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

export function totalChanges(d: Diff): number {
  return d.added.length + d.changed.length + d.removed.length;
}

export function describeDiff(d: Diff, limit = 20): string {
  const lines = [
    ...d.changed.map((f) => `  changed  ${f}`),
    ...d.added.map((f) => `  added    ${f}`),
    ...d.removed.map((f) => `  removed  ${f}`),
  ];
  return lines.length > limit ? [...lines.slice(0, limit), `  …and ${lines.length - limit} more`].join("\n") : lines.join("\n");
}

export interface ChangeNotice {
  /** Markdown appended to the report. Empty when nothing changed. */
  markdown: string;
  /** Short text for the terminal. */
  console: string;
  /** True when the run should exit non-zero (a locked file changed during `fix`). */
  fail: boolean;
}

/**
 * Describe changes seen during a run without claiming who made them.
 * Nothing is reverted: another editor or agent may be working in the same project.
 */
export function describeChanges(
  d: Diff,
  opts: { writes: boolean; ranScripts: boolean; lockedChanged: string[] },
): ChangeNotice {
  const locked = opts.lockedChanged;
  if (!opts.writes) {
    if (totalChanges(d) === 0) return { markdown: "", console: "", fail: false };
    const cause = opts.ranScripts
      ? "This run was allowed to execute project scripts (--run-checks), which can write files such as build output or caches. Another editor or agent working in this folder at the same time could also be the cause. UNSTUCK cannot tell which."
      : "This run did not execute project scripts, so the most likely cause is another editor, agent or process working in this folder at the same time. UNSTUCK cannot confirm the cause.";
    const markdown =
      `\n\n> ⚠️ **Files changed while UNSTUCK was running.** ${cause} Nothing was reverted. ` +
      `Findings may reflect a mix of old and new code; re-run once the project is quiet.` +
      (locked.length ? ` Locked files among them: ${locked.join(", ")}.` : "") +
      `\n\n\`\`\`\n${describeDiff(d)}\n\`\`\`\n`;
    return { markdown, console: `Files changed during the run (not reverted, cause unknown):\n${describeDiff(d)}`, fail: false };
  }
  if (!locked.length) return { markdown: "", console: "", fail: false };
  const markdown =
    `\n\n> ⛔ **Locked files changed during this fix run:** ${locked.join(", ")}. ` +
    `UNSTUCK's edit tools are blocked from these files, so the change came from a command it ran or from another process working at the same time. ` +
    `Nothing was reverted. Check them with \`git diff\` before keeping anything.\n`;
  return { markdown, console: `Locked files changed during the run (not reverted): ${locked.join(", ")}`, fail: true };
}
