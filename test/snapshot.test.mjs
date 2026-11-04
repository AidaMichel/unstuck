import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as snap from "../dist/snapshot.js";
const { takeSnapshot, diffSnapshots, totalChanges, describeChanges } = snap;

function project() {
  const repo = mkdtempSync(path.join(tmpdir(), "unstuck-snap-"));
  mkdirSync(path.join(repo, "src")); mkdirSync(path.join(repo, "node_modules"));
  writeFileSync(path.join(repo, "src/locked.ts"), "original");
  writeFileSync(path.join(repo, "src/free.ts"), "a");
  writeFileSync(path.join(repo, "src/gone.ts"), "x");
  writeFileSync(path.join(repo, "node_modules/ignored.js"), "a");
  return repo;
}

test("detects added, changed and removed files; ignores dependency folders", () => {
  const repo = project();
  const before = takeSnapshot(repo);
  writeFileSync(path.join(repo, "src/locked.ts"), "edited by another agent");
  writeFileSync(path.join(repo, "src/free.ts"), "b");
  writeFileSync(path.join(repo, "src/new.ts"), "n");
  rmSync(path.join(repo, "src/gone.ts"));
  writeFileSync(path.join(repo, "node_modules/ignored.js"), "b");
  const diff = diffSnapshots(before, takeSnapshot(repo));
  assert.deepEqual(diff, { added: ["src/new.ts"], changed: ["src/free.ts", "src/locked.ts"], removed: ["src/gone.ts"] });
  assert.equal(totalChanges(diff), 4);
});

test("REGRESSION: nothing is ever restored — a concurrent agent's edit to a locked file survives", () => {
  assert.equal(snap.restoreProtected, undefined, "restore function must not exist");
  const repo = project();
  const before = takeSnapshot(repo);
  writeFileSync(path.join(repo, "src/locked.ts"), "edited by another agent");
  rmSync(path.join(repo, "src/gone.ts"));
  const diff = diffSnapshots(before, takeSnapshot(repo));
  for (const writes of [false, true]) describeChanges(diff, { writes, ranScripts: writes, lockedChanged: ["src/locked.ts"] });
  assert.equal(readFileSync(path.join(repo, "src/locked.ts"), "utf8"), "edited by another agent");
  assert.throws(() => readFileSync(path.join(repo, "src/gone.ts")), "deleted file stays deleted");
});

test("read-only: changes are a warning that does not blame UNSTUCK and does not fail the run", () => {
  const diff = { added: [], changed: ["src/a.ts"], removed: [] };
  const n = describeChanges(diff, { writes: false, ranScripts: false, lockedChanged: [] });
  assert.equal(n.fail, false);
  assert.match(n.markdown, /Files changed while UNSTUCK was running/);
  assert.match(n.markdown, /another editor, agent or process/);
  assert.match(n.markdown, /Nothing was reverted/);
  assert.doesNotMatch(n.markdown, /UNSTUCK (changed|modified|restored)/);
  const withChecks = describeChanges(diff, { writes: false, ranScripts: true, lockedChanged: ["src/a.ts"] });
  assert.match(withChecks.markdown, /cannot tell which/);
  assert.match(withChecks.markdown, /Locked files among them: src\/a\.ts/);
  assert.equal(describeChanges({ added: [], changed: [], removed: [] }, { writes: false, ranScripts: false, lockedChanged: [] }).markdown, "");
});

test("fix: a changed locked file fails the run but is not reverted", () => {
  const n = describeChanges({ added: [], changed: ["src/locked.ts"], removed: [] }, { writes: true, ranScripts: true, lockedChanged: ["src/locked.ts"] });
  assert.equal(n.fail, true);
  assert.match(n.markdown, /Nothing was reverted/);
  assert.equal(describeChanges({ added: [], changed: ["src/a.ts"], removed: [] }, { writes: true, ranScripts: true, lockedChanged: [] }).fail, false);
});
