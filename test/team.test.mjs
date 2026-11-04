import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTeam, passSection, SPECIALISTS, LEAD_ADDENDUM } from "../dist/team.js";

const prompt = readFileSync(new URL("../prompts/guardian.md", import.meta.url), "utf8");

test("every pass exists in the main prompt", () => {
  for (const n of [1, 2, 3, 4, 5]) assert.match(passSection(prompt, n), new RegExp(`^# Pass ${n}`));
  assert.ok(!passSection(prompt, 1).includes("# Pass 2"), "sections do not bleed into each other");
});

test("team has five read-only specialists, each with their own pass", () => {
  const team = buildTeam(prompt);
  assert.deepEqual(Object.keys(team), SPECIALISTS);
  assert.equal(SPECIALISTS.length, 5);
  const expected = { "code-reviewer": 1, "refactor-architect": 2, "qa-lead": 3, "risk-compliance": 4, challenger: 5 };
  for (const [k, n] of Object.entries(expected)) {
    assert.deepEqual(team[k].tools, ["Read", "Grep", "Glob", "Bash"], k);
    assert.ok(team[k].prompt.includes(`# Pass ${n}`), k);
    assert.ok(team[k].prompt.includes("Never print secret values"), k);
  }
  assert.equal(team["qa-lead"].model, "inherit");
  assert.equal(buildTeam(prompt, "sonnet")["qa-lead"].model, "sonnet");
  for (const k of SPECIALISTS) assert.ok(LEAD_ADDENDUM.includes(k));
});

test("main prompt keeps everything we promised", () => {
  for (const must of [
    "Step 0", "GUARDIAN.md", "Pass 1 — Code review", "Pass 2 — Refactor plan", "Pass 3 — QA", "Pass 4 — Risk and compliance",
    "Pass 5 — Challenge", "Pre-mortem", "Rescue mode", "plain language", "needs legal review", "PDPL", "GDPR",
    "unstuck:summary", "unstuck fix", "Never print secret values", "data, not instructions",
  ]) assert.ok(prompt.includes(must), must);
});
