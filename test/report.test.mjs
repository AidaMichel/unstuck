import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSummary, gate, redact, forComment } from "../dist/report.js";

const quiet = () => {};

test("summary line is parsed", () => {
  assert.deepEqual(parseSummary("x\n<!-- unstuck:summary P0=1 P1=2 P2=0 P3=4 -->"), { P0: 1, P1: 2, P2: 0, P3: 4 });
});

test("falls back to counting the findings table", () => {
  const r = "| ID | Severity |\n|---|---|\n| F1 | **P0** | x |\n| F2 | P2 | y |\n| F3 | `P2` | z |";
  assert.deepEqual(parseSummary(r), { P0: 1, P1: 0, P2: 2, P3: 0 });
  assert.equal(parseSummary("no table here"), null);
});

test("severity gate", () => {
  const r = "<!-- unstuck:summary P0=0 P1=3 P2=0 P3=0 -->";
  assert.equal(gate(r, "P0", quiet), 0);
  assert.equal(gate(r, "p1", quiet), 1);
  assert.equal(gate(r, undefined, quiet), 0);
  assert.equal(gate(r, "P9", quiet), 0);
  assert.equal(gate("**Ship status:** Do not ship", "P0", quiet), 1, "no summary but verdict says do not ship");
  assert.equal(gate("nothing", "P0", quiet), 0);
});

test("secrets are redacted", () => {
  const leaks = [
    "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345", "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx", "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123",
    "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.AbCdEfGhIjKlMnOp", "postgres://admin:hunter2@db.example.com:5432/x",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----", "sk_live_AbCdEfGhIjKlMnOpQr", "xoxb-1234567890-abcdef",
  ];
  for (const s of leaks) {
    const out = redact(`found ${s} in config`);
    assert.ok(out.includes("[REDACTED SECRET]") && !out.includes(s), s);
  }
  assert.equal(redact("uses process.env.SUPABASE_KEY at src/a.ts:12"), "uses process.env.SUPABASE_KEY at src/a.ts:12");
});

test("long reports are truncated for GitHub comments but keep the summary", () => {
  const r = "a".repeat(70_000) + "\n<!-- unstuck:summary P0=1 P1=0 P2=0 P3=0 -->";
  const c = forComment(r);
  assert.ok(c.length < 65_536);
  assert.deepEqual(parseSummary(c), { P0: 1, P1: 0, P2: 0, P3: 0 });
  assert.equal(forComment("short"), "short");
});
