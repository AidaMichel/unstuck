import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { takeSnapshot, diffSnapshots, restoreProtected, totalChanges } from "../dist/snapshot.js";

test("detects changes and restores only locked files", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "unstuck-snap-"));
  mkdirSync(path.join(repo, "src")); mkdirSync(path.join(repo, "node_modules"));
  writeFileSync(path.join(repo, "src/locked.ts"), "original");
  writeFileSync(path.join(repo, "src/free.ts"), "a");
  writeFileSync(path.join(repo, "src/gone.ts"), "x");
  writeFileSync(path.join(repo, "node_modules/ignored.js"), "a");

  const before = takeSnapshot(repo, (rel) => rel === "src/locked.ts");
  writeFileSync(path.join(repo, "src/locked.ts"), "TAMPERED");
  writeFileSync(path.join(repo, "src/free.ts"), "b");
  writeFileSync(path.join(repo, "src/new.ts"), "n");
  rmSync(path.join(repo, "src/gone.ts"));
  writeFileSync(path.join(repo, "node_modules/ignored.js"), "b");
  writeFileSync(path.join(repo, "unstuck-report.md"), "report");

  const diff = diffSnapshots(before, takeSnapshot(repo));
  assert.deepEqual(diff, { added: ["src/new.ts"], changed: ["src/free.ts", "src/locked.ts"], removed: ["src/gone.ts"] });
  assert.equal(totalChanges(diff), 4);
  assert.deepEqual(restoreProtected(repo, before, diff), ["src/locked.ts"]);
  assert.equal(readFileSync(path.join(repo, "src/locked.ts"), "utf8"), "original");
  assert.equal(readFileSync(path.join(repo, "src/free.ts"), "utf8"), "b", "non-locked edits are kept");
});

test("restores a deleted locked file", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "unstuck-snap-"));
  writeFileSync(path.join(repo, "keep.ts"), "k");
  const before = takeSnapshot(repo, () => true);
  rmSync(path.join(repo, "keep.ts"));
  const diff = diffSnapshots(before, takeSnapshot(repo));
  assert.deepEqual(restoreProtected(repo, before, diff), ["keep.ts"]);
  assert.equal(readFileSync(path.join(repo, "keep.ts"), "utf8"), "k");
});
