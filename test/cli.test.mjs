import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { takeSnapshot, diffSnapshots, totalChanges } from "../dist/snapshot.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), "unstuck-cli-")));
const run = (args, env = {}) => {
  const e = { ...process.env, ...env };
  delete e.ANTHROPIC_API_KEY; delete e.CLAUDE_CODE_OAUTH_TOKEN; delete e.CLAUDE_CODE_USE_BEDROCK; delete e.CLAUDE_CODE_USE_VERTEX;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...e, ...env } });
};

function project() {
  const repo = tmp();
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  return repo;
}

for (const mode of ["review", "audit", "rescue"]) {
  test(`REGRESSION: ${mode} --out inside the project is refused before anything runs, project untouched`, () => {
    const repo = project();
    const before = takeSnapshot(repo);
    const r = run([mode, repo, "--out", path.join(repo, "unstuck-report.md")], { ANTHROPIC_API_KEY: "sk-ant-test-not-used" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Refusing to write the report inside the project/);
    assert.equal(totalChanges(diffSnapshots(before, takeSnapshot(repo))), 0);
    assert.ok(!existsSync(path.join(repo, "unstuck-report.md")));
  });
}

test("default run without a key exits cleanly and leaves the project untouched", () => {
  const repo = project();
  const before = takeSnapshot(repo);
  const r = run(["audit", repo]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ANTHROPIC_API_KEY/);
  assert.equal(totalChanges(diffSnapshots(before, takeSnapshot(repo))), 0);
});

test("UNSTUCK_REPORT_DIR inside the project is refused", () => {
  const repo = project();
  const r = run(["review", repo], { ANTHROPIC_API_KEY: "sk-ant-test-not-used", UNSTUCK_REPORT_DIR: path.join(repo, "reports") });
  assert.equal(r.status, 2);
  assert.ok(!existsSync(path.join(repo, "reports")));
});

test("fix looks for the latest report outside the project", () => {
  const repo = project(), reports = tmp();
  const r = run(["fix", "F1", repo], { UNSTUCK_REPORT_DIR: reports });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /No report found at /);
  assert.ok(r.stderr.includes(reports), r.stderr);
});

test("init creates GUARDIAN.md and no longer edits .gitignore", () => {
  const repo = project();
  const r = run(["init", repo]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(path.join(repo, "GUARDIAN.md")));
  assert.equal(readFileSync(path.join(repo, ".gitignore"), "utf8"), "node_modules\n");
});

test("help documents --run-checks and the outside-project report default", () => {
  const r = run(["review", "--help"]);
  assert.match(r.stdout, /--run-checks/);
  assert.match(r.stdout, /must be outside the project/);
});
