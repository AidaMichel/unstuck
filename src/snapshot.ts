import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import path from "node:path";

// The guard blocks known-bad actions. The snapshot catches anything it missed
// (a test script that writes files, an inline script, a tool we didn't foresee):
// it fingerprints the project before a run and compares afterwards.

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".turbo", ".vercel",
  ".cache", "coverage", ".nyc_output", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".venv", "venv", "target", ".gradle", ".idea", ".vscode", "tmp", ".parcel-cache", "storybook-static",
]);
const SKIP_FILES = /(\.tsbuildinfo|\.log|\.DS_Store|\.pyc)$|^unstuck-(fix-)?report\.md$|^unstuck-comment\.md$/;
const MAX_FILES = 50_000;
const MAX_KEEP_BYTES = 2_000_000; // file contents kept for restoring locked files

export interface Snapshot {
  hashes: Map<string, string>;
  kept: Map<string, Buffer>; // contents of protected (locked) files
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

export function takeSnapshot(repo: string, isProtected: (rel: string) => boolean = () => false): Snapshot {
  const files: string[] = [];
  const complete = walk(repo, repo, files);
  const hashes = new Map<string, string>();
  const kept = new Map<string, Buffer>();
  for (const rel of files) {
    try {
      const buf = readFileSync(path.join(repo, rel));
      hashes.set(rel, createHash("sha256").update(buf).digest("hex"));
      if (isProtected(rel) && buf.length <= MAX_KEEP_BYTES) kept.set(rel, buf);
    } catch { /* unreadable: skip */ }
  }
  return { hashes, kept, truncated: !complete };
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

/** Put protected files back exactly as they were. Returns the files restored. */
export function restoreProtected(repo: string, before: Snapshot, diff: Diff): string[] {
  const restored: string[] = [];
  for (const rel of [...diff.changed, ...diff.removed]) {
    const buf = before.kept.get(rel);
    if (!buf) continue;
    const full = path.join(repo, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, buf);
    restored.push(rel);
  }
  return restored;
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
