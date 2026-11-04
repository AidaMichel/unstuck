import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Reports never go inside the project being reviewed. They live in a per-project folder under
// ~/.unstuck/reports (or $UNSTUCK_REPORT_DIR), so read-only runs leave the project untouched.

export class UnsafePathError extends Error {}

function real(p: string): string {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

/** Real path of `p`, following symlinks for whatever part of it already exists. */
function realLeaf(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur) && path.dirname(cur) !== cur) {
    tail.unshift(path.basename(cur));
    cur = path.dirname(cur);
  }
  return path.join(real(cur), ...tail);
}

export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(real(parent), realLeaf(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The folder this project's reports go in. */
export function reportDir(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = real(repo);
  const id = `${path.basename(root) || "root"}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
  if (env.UNSTUCK_REPORT_DIR) return path.join(path.resolve(env.UNSTUCK_REPORT_DIR), id); // validated by the caller
  for (const base of [path.join(os.homedir(), ".unstuck", "reports"), path.join(os.tmpdir(), "unstuck-reports")]) {
    const dir = path.join(base, id);
    if (!isWithin(dir, root)) return dir;
  }
  throw new UnsafePathError("Could not find a report folder outside the project. Pass --out with a path outside the project.");
}

export function timestamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/**
 * Decide where a report goes and refuse anything unsafe:
 * inside the project (directly or through a symlink), onto a symlink, or onto a non-file.
 */
export function resolveReportPath(repo: string, mode: string, out?: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): string {
  const target = out ? path.resolve(out) : path.join(reportDir(repo, env), `${mode}-${timestamp(now)}.md`);
  assertSafeOutput(target, repo);
  return target;
}

export function assertSafeOutput(target: string, repo: string): void {
  if (isWithin(target, repo)) {
    throw new UnsafePathError(
      `Refusing to write the report inside the project (${target}). Reports are kept outside the project so UNSTUCK never changes it; pick a path outside ${real(repo)} or leave --out empty.`,
    );
  }
  if (lstatExists(target)) {
    const st = lstatSync(target);
    if (st.isSymbolicLink()) throw new UnsafePathError(`Refusing to write the report through a symlink: ${target}`);
    if (!st.isFile()) throw new UnsafePathError(`Report path is not a regular file: ${target}`);
  }
}

function lstatExists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

/** Write a file without following a symlink at the final path (where the OS supports it). */
export function writeReportFile(target: string, content: string, repo: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  assertSafeOutput(target, repo); // re-check after creating folders
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(target, flags, 0o644);
  try { writeSync(fd, content); } finally { closeSync(fd); }
}

export function latestReportPath(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(reportDir(repo, env), "latest.md");
}
