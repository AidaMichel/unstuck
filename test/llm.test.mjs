import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectFacts } from "../dist/offline/facts.js";
import { runRules } from "../dist/offline/rules.js";
import { detectLocalModel, pickModel, checkAnswer, cleanAnswer, isLocalUrl, localDiagnosis, buildPrompt } from "../dist/llm.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const KEY = "sk-ant-api03-" + "K".repeat(40);
function project() {
  const r = realpathSync(mkdtempSync(path.join(tmpdir(), "unstuck-llm-")));
  for (const [p, c] of Object.entries({
    "README.md": "# fx\nSplit bills in AED.\n", "package.json": "{\"name\":\"fx\",\"type\":\"module\"}",
    "src/split.js": "export function split(t, p) {\n  return t / p;\n}\n", "src/config.js": `export const key = "${KEY}";\n`,
  })) { mkdirSync(path.dirname(path.join(r, p)), { recursive: true }); writeFileSync(path.join(r, p), c); }
  return r;
}
const GOOD = `<think>let me think</think>
### Goal
Split bills in AED (README.md).
### Reality
Small JS project.
### Evidence
- src/split.js:2 — divides without rounding
### Verified Problems
- F1 secret in src/config.js:1
### Hypotheses
- Rounding may be missing.
### One Recommended Next Move
Revoke the key.`;

function mockServer(kind, reply) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, body });
      const json = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
      if (kind === "ollama" && req.url === "/api/tags") return json({ models: [{ name: "nomic-embed-text" }, { name: "llama3.2:3b" }, { name: "qwen2.5-coder:7b" }] });
      if (kind === "ollama" && req.url === "/api/chat") return json({ message: { content: reply } });
      if (kind === "openai" && req.url === "/v1/models") return json({ data: [{ id: "lmstudio-community/gemma-3-4b" }] });
      if (kind === "openai" && req.url === "/v1/chat/completions") return json({ choices: [{ message: { content: reply } }] });
      res.statusCode = 404; res.end();
    });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() })));
}

test("model picking prefers coding models and skips embedding models", () => {
  assert.equal(pickModel(["nomic-embed-text", "llama3.2:3b", "qwen2.5-coder:7b"]), "qwen2.5-coder:7b");
  assert.equal(pickModel(["nomic-embed-text", "mystery-model"]), "mystery-model");
  assert.equal(pickModel(["llama3.2:3b"], "qwen2.5-coder"), null);
  assert.equal(pickModel([], "qwen2.5-coder"), null);
});

test("local vs remote URLs", () => {
  for (const u of ["http://localhost:11434", "http://127.0.0.1:1234", "http://[::1]:8080"]) assert.ok(isLocalUrl(u), u);
  for (const u of ["https://example.com", "http://192.168.1.5:11434", "nonsense"]) assert.ok(!isLocalUrl(u), u);
});

test("Ollama: detected, asked with a large context, answer accepted and secrets never sent", async () => {
  const s = await mockServer("ollama", GOOD);
  try {
    const m = await detectLocalModel({ url: s.url });
    assert.deepEqual(m, { kind: "ollama", base: s.url, model: "qwen2.5-coder:7b" });
    const r = project(); const f = collectFacts(r); const findings = runRules(f);
    const out = await localDiagnosis(m, f, findings, "totals wrong");
    assert.ok(out.usedModel);
    assert.ok(!out.report.includes("<think>"));
    assert.match(out.report, /open model \*\*qwen2\.5-coder:7b\*\*/);
    assert.match(out.report, /unstuck:summary P0=1/);
    const chat = s.seen.find((x) => x.url === "/api/chat");
    const body = JSON.parse(chat.body);
    assert.equal(body.options.num_ctx, 16384);
    assert.ok(!chat.body.includes(KEY), "secret value not sent to the model");
    assert.match(chat.body, /split\.js/);
  } finally { s.close(); }
});

test("LM Studio / OpenAI-compatible servers work too", async () => {
  const s = await mockServer("openai", GOOD);
  try {
    const m = await detectLocalModel({ url: s.url });
    assert.equal(m.kind, "openai");
    const r = project(); const f = collectFacts(r);
    assert.ok((await localDiagnosis(m, f, runRules(f))).usedModel);
  } finally { s.close(); }
});

test("a bad or hallucinating model answer falls back to the free report", async () => {
  for (const bad of ["I think it's fine.", GOOD.replace("src/split.js:2", "src/split.js:99"), GOOD.replace("src/split.js:2", "src/invented.js:3")]) {
    const s = await mockServer("ollama", bad);
    try {
      const m = await detectLocalModel({ url: s.url });
      const r = project(); const f = collectFacts(r);
      const out = await localDiagnosis(m, f, runRules(f));
      assert.equal(out.usedModel, false, bad.slice(0, 40));
      assert.match(out.report, /failed UNSTUCK's checks/);
      assert.match(out.report, /### One Recommended Next Move/);
    } finally { s.close(); }
  }
});

test("server down: falls back to the free report", async () => {
  const r = project(); const f = collectFacts(r);
  const out = await localDiagnosis({ kind: "ollama", base: "http://127.0.0.1:9", model: "x" }, f, runRules(f));
  assert.equal(out.usedModel, false);
  assert.match(out.report, /### Goal/);
});

test("answer checks and cleanup", () => {
  const f = collectFacts(project());
  assert.ok(checkAnswer(cleanAnswer(GOOD), f).ok);
  assert.match(checkAnswer("### Goal\nx", f).problems.join(), /missing section "Reality"/);
  assert.equal(cleanAnswer("Sure! Here it is:\n### Goal\nx").startsWith("### Goal"), true);
});

test("prompt asks for --lang and never contains the secret", () => {
  const r = project(); const f = collectFacts(r);
  const p = buildPrompt(f, runRules(f), undefined, "Arabic");
  assert.match(p.system, /in Arabic/);
  assert.ok(!p.user.includes(KEY) && !p.system.includes(KEY));
});

test("CLI end to end with a local model server and no API key", async () => {
  const s = await mockServer("ollama", GOOD);
  try {
    const reports = realpathSync(mkdtempSync(path.join(tmpdir(), "unstuck-rep-")));
    const env = { ...process.env, UNSTUCK_REPORT_DIR: reports }; delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const child = spawn(process.execPath, [CLI, "rescue", project(), "--llm-url", s.url], { env });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
    const code = await new Promise((ok) => child.on("close", ok));
    assert.equal(code, 0, err);
    assert.match(err, /engine: local model qwen2\.5-coder:7b/);
    assert.match(out, /Revoke the key/);
  } finally { s.close(); }
});
