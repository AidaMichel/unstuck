import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { resolveReportPath, reportDir, isWithin, writeReportFile, latestReportPath, UnsafePathError } from "../dist/paths.js";

const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), "unstuck-paths-")));
const NOENV = {};

test("default report path is outside the project, per-project and timestamped", () => {
  const repo = tmp();
  const out = resolveReportPath(repo, "review", undefined, NOENV, new Date("2026-11-04T10:20:30Z"));
  assert.ok(!isWithin(out, repo));
  assert.ok(out.startsWith(path.join(homedir(), ".unstuck", "reports")));
  assert.match(path.basename(out), /^review-20261104-102030\.md$/);
  assert.notEqual(reportDir(repo, NOENV), reportDir(tmp(), NOENV), "different projects get different folders");
});

test("REGRESSION: --out inside the project is refused", () => {
  const repo = tmp();
  for (const out of [path.join(repo, "unstuck-report.md"), path.join(repo, "docs", "r.md"), repo]) {
    assert.throws(() => resolveReportPath(repo, "review", out, NOENV), UnsafePathError, out);
  }
});

test("--out through a symlinked folder that points into the project is refused", () => {
  const repo = tmp(), outside = tmp();
  symlinkSync(repo, path.join(outside, "link-to-repo"));
  assert.throws(() => resolveReportPath(repo, "review", path.join(outside, "link-to-repo", "r.md"), NOENV), UnsafePathError);
});

test("writing onto a symlinked file is refused", () => {
  const repo = tmp(), outside = tmp();
  writeFileSync(path.join(repo, "victim.ts"), "keep me");
  symlinkSync(path.join(repo, "victim.ts"), path.join(outside, "r.md"));
  assert.throws(() => resolveReportPath(repo, "review", path.join(outside, "r.md"), NOENV), UnsafePathError);
  assert.throws(() => writeReportFile(path.join(outside, "r.md"), "x", repo), UnsafePathError);
  assert.equal(readFileSync(path.join(repo, "victim.ts"), "utf8"), "keep me");
});

test("a non-file output path is refused", () => {
  const repo = tmp(), outside = tmp();
  mkdirSync(path.join(outside, "dir"));
  assert.throws(() => resolveReportPath(repo, "review", path.join(outside, "dir"), NOENV), UnsafePathError);
});

test("UNSTUCK_REPORT_DIR inside the project is refused; outside is used", () => {
  const repo = tmp(), outside = tmp();
  assert.throws(() => resolveReportPath(repo, "audit", undefined, { UNSTUCK_REPORT_DIR: path.join(repo, ".reports") }), UnsafePathError);
  const out = resolveReportPath(repo, "audit", undefined, { UNSTUCK_REPORT_DIR: outside });
  assert.ok(out.startsWith(outside));
});

test("reviewing a folder that contains the default report folder falls back to the temp folder", () => {
  const out = resolveReportPath(homedir(), "review", undefined, NOENV);
  assert.ok(!isWithin(out, homedir()), out);
});

test("writeReportFile creates folders outside the project and writes the file", () => {
  const repo = tmp(), outside = tmp();
  const target = path.join(outside, "a", "b", "r.md");
  writeReportFile(target, "hello", repo);
  assert.equal(readFileSync(target, "utf8"), "hello");
  assert.ok(latestReportPath(repo, { UNSTUCK_REPORT_DIR: outside }).endsWith("latest.md"));
});
