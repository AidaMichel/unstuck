import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { CATALOG, defaultModel, catalogModel, sourceUrl } from "../dist/embedded/catalog.js";
import { chooseModel, validateModelFile, installedModels, ModelFileError } from "../dist/embedded/store.js";
import { remoteInfo, consentText, askConsent, downloadModel, DownloadError } from "../dist/embedded/download.js";
import { platformPackage, findRuntime } from "../dist/embedded/runtime.js";
import { fitPrompt, ANSWER_TOKENS } from "../dist/llm.js";
import { collectFacts } from "../dist/offline/facts.js";
import { runRules } from "../dist/offline/rules.js";
import { takeSnapshot, diffSnapshots, totalChanges } from "../dist/snapshot.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/fake-llama.mjs", import.meta.url));
const NONET = fileURLToPath(new URL("./fixtures/no-network.cjs", import.meta.url));
const tmp = (p = "unstuck-emb-") => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const KEY = "sk-ant-api03-" + "E".repeat(40);

function gguf(file, bytes = 2 * 1024 * 1024) {
  mkdirSync(path.dirname(file), { recursive: true });
  const b = Buffer.alloc(bytes, 7); b.write("GGUF", 0, "latin1"); writeFileSync(file, b); return file;
}
function installFake(dir, id, bytes = 2 * 1024 * 1024) {
  const m = catalogModel(id); const file = gguf(path.join(dir, m.file), bytes);
  writeFileSync(file + ".json", JSON.stringify({ id, bytes, sha256: "x", source: m.url, license: m.license }));
  return file;
}
function project() {
  const r = tmp("unstuck-emb-proj-");
  for (const [p, c] of Object.entries({
    "README.md": "# fx\nSplit bills in AED.\n", "package.json": "{\"name\":\"fx\",\"type\":\"module\"}",
    "src/split.js": "export const split = (t, p) => t / p;\n", "src/config.js": `export const k = "${KEY}";\n`, ".env": "REAL_SECRET=" + "S".repeat(30) + "\n",
  })) { mkdirSync(path.dirname(path.join(r, p)), { recursive: true }); writeFileSync(path.join(r, p), c); }
  return r;
}
function cli(args, env = {}) {
  const e = { ...process.env, ...env };
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) delete e[k];
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...e, ...env }, input: "" });
}
const readLog = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// ---------- catalog & selection ----------
test("catalog: one default, unique ids, https sources, licenses and sizes stated", () => {
  assert.equal(CATALOG.filter((m) => m.default).length, 1);
  assert.equal(new Set(CATALOG.map((m) => m.id)).size, CATALOG.length);
  for (const m of CATALOG) {
    assert.match(m.url, /^https:\/\/huggingface\.co\/.+\.gguf$/);
    assert.ok(m.license && m.licenseUrl.startsWith("https://") && m.approxBytes > 1e8 && m.minRamGB > 0, m.id);
  }
  assert.equal(sourceUrl(defaultModel(), { UNSTUCK_MODEL_MIRROR: "http://127.0.0.1:9/" }).startsWith("http://127.0.0.1:9/Qwen/"), true);
});

test("model selection: nothing installed, best installed, explicit id, unknown id, explicit file, partial downloads ignored", () => {
  const dir = tmp(); const env = { UNSTUCK_MODEL_DIR: dir };
  assert.equal(chooseModel({}, env), null);
  installFake(dir, "qwen2.5-coder-1.5b", 2 * 1024 * 1024);
  assert.equal(chooseModel({}, env).catalog.id, "qwen2.5-coder-1.5b");
  installFake(dir, "qwen2.5-coder-7b", 3 * 1024 * 1024);
  assert.equal(chooseModel({}, env).catalog.id, "qwen2.5-coder-7b", "prefers the larger model");
  assert.equal(chooseModel({ id: "qwen2.5-coder-1.5b" }, env).catalog.id, "qwen2.5-coder-1.5b");
  assert.throws(() => chooseModel({ id: "gpt-9" }, env), ModelFileError);
  assert.equal(chooseModel({ file: "/x/y.gguf" }, env).file, "/x/y.gguf");
  writeFileSync(path.join(dir, catalogModel("qwen2.5-coder-7b").file + ".part"), "x");
  assert.deepEqual(installedModels(env).map((m) => m.id), ["qwen2.5-coder-1.5b"], "a model still downloading isn't used");
});

// ---------- missing & corrupted files ----------
test("model file validation: missing, folder, too small, wrong header, size changed, good", () => {
  const d = tmp();
  assert.throws(() => validateModelFile(path.join(d, "nope.gguf")), /not found/);
  assert.throws(() => validateModelFile(d), /not a regular file/);
  writeFileSync(path.join(d, "tiny.gguf"), "GGUF");
  assert.throws(() => validateModelFile(path.join(d, "tiny.gguf")), /too small/);
  const bad = path.join(d, "bad.gguf"); writeFileSync(bad, Buffer.alloc(2 * 1024 * 1024, 1));
  assert.throws(() => validateModelFile(bad), /not a GGUF model file/);
  const good = gguf(path.join(d, "good.gguf"));
  assert.throws(() => validateModelFile(good, 123), /size changed since download/);
  assert.equal(validateModelFile(good).bytes, 2 * 1024 * 1024);
});

// ---------- download consent ----------
function modelServer({ body, sha, size, redirect = true }) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url.endsWith(".gguf") && redirect && req.method === "HEAD") {
      res.writeHead(302, { location: "/cdn/blob", ...(size !== undefined ? { "x-linked-size": String(size) } : {}), ...(sha ? { "x-linked-etag": `"${sha}"` } : {}) });
      return res.end();
    }
    if (req.url === "/cdn/blob" || req.url.endsWith(".gguf")) { res.writeHead(200, { "content-length": body.length }); return res.end(req.method === "HEAD" ? undefined : body); }
    res.writeHead(404); res.end();
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ base: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() })));
}
const model = (base) => ({ ...defaultModel(), url: `${base}/Qwen/x/resolve/main/${defaultModel().file}` });

test("consent text names the model, exact size, source, license, checksum and destination", async () => {
  const data = Buffer.alloc(2 * 1024 * 1024, 3); data.write("GGUF", 0, "latin1");
  const sha = createHash("sha256").update(data).digest("hex");
  const s = await modelServer({ body: data, sha, size: data.length });
  try {
    const m = model(s.base); const info = await remoteInfo(m.url);
    assert.equal(info.bytes, data.length); assert.equal(info.sha256, sha);
    const text = consentText(m, info, "/home/me/.unstuck/models/x.gguf");
    for (const want of [m.name, "2.1 MB", "2,097,152 bytes", m.source, m.url, m.license, m.licenseUrl, sha, "/home/me/.unstuck/models/x.gguf", "never uploaded"]) assert.ok(text.includes(want), want);
  } finally { s.close(); }
});

test("consent: --yes agrees; no terminal never agrees; a terminal answer is respected", async () => {
  assert.equal(await askConsent({ yes: true }), true);
  const noTty = new PassThrough(); noTty.isTTY = false;
  assert.equal(await askConsent({ input: noTty }), false);
  for (const [answer, want] of [["y\n", true], ["yes\n", true], ["\n", false], ["n\n", false]]) {
    const tty = new PassThrough(); tty.isTTY = true; const out = new PassThrough();
    const p = askConsent({ input: tty, output: out }); tty.write(answer);
    assert.equal(await p, want, JSON.stringify(answer));
  }
});

test("download: verified file and record saved; checksum mismatch, short download and missing checksum are refused", async () => {
  const data = Buffer.alloc(2 * 1024 * 1024, 5); data.write("GGUF", 0, "latin1");
  const sha = createHash("sha256").update(data).digest("hex");
  // good
  let s = await modelServer({ body: data, sha, size: data.length });
  try {
    const dir = tmp(); const m = model(s.base);
    const r = await downloadModel(m, await remoteInfo(m.url), { env: { UNSTUCK_MODEL_DIR: dir } });
    assert.equal(r.verified, true); assert.equal(r.sha256, sha);
    assert.equal(createHash("sha256").update(readFileSync(r.file)).digest("hex"), sha);
    assert.equal(JSON.parse(readFileSync(r.file + ".json", "utf8")).sha256, sha);
    assert.equal(chooseModel({}, { UNSTUCK_MODEL_DIR: dir }).file, r.file);
  } finally { s.close(); }
  // checksum mismatch
  s = await modelServer({ body: data, sha: "0".repeat(64), size: data.length });
  try {
    const dir = tmp(); const m = model(s.base);
    await assert.rejects(downloadModel(m, await remoteInfo(m.url), { env: { UNSTUCK_MODEL_DIR: dir } }), /checksum mismatch/);
    assert.deepEqual(readdirSync(dir), [], "nothing left behind");
  } finally { s.close(); }
  // short download (server sends less than announced)
  s = await modelServer({ body: data.subarray(0, 1000), sha, size: data.length });
  try {
    const dir = tmp(); const m = model(s.base);
    await assert.rejects(downloadModel(m, { ...(await remoteInfo(m.url)), bytes: data.length }, { env: { UNSTUCK_MODEL_DIR: dir } }), /incomplete/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { s.close(); }
  // no checksum published: refused before downloading anything
  s = await modelServer({ body: data, size: data.length });
  try {
    const dir = tmp(); const m = model(s.base);
    const info = await remoteInfo(m.url);
    await assert.rejects(downloadModel(m, info, { env: { UNSTUCK_MODEL_DIR: dir } }), DownloadError);
    assert.ok(!s.seen.some((x) => x.startsWith("GET")), "no GET request was made");
  } finally { s.close(); }
});

test("download: only https or this computer", async () => {
  await assert.rejects(remoteInfo("http://example.com/m.gguf"), /only https/);
  await assert.rejects(remoteInfo("ftp://example.com/m.gguf"), /only https/);
});

test("CLI model download: refuses without consent and downloads nothing", async () => {
  const data = Buffer.alloc(2 * 1024 * 1024, 9); data.write("GGUF", 0, "latin1");
  const s = await modelServer({ body: data, sha: createHash("sha256").update(data).digest("hex"), size: data.length });
  try {
    const dir = tmp();
    const child = spawn(process.execPath, [CLI, "model", "download"], { env: { ...process.env, UNSTUCK_MODEL_DIR: dir, UNSTUCK_MODEL_MIRROR: s.base }, stdio: ["ignore", "pipe", "pipe"] });
    let err = ""; child.stderr.on("data", (d) => (err += d));
    const code = await new Promise((ok) => child.on("close", ok));
    assert.equal(code, 3);
    assert.match(err, /Qwen2\.5-Coder 1\.5B/); assert.match(err, /Apache-2\.0/); assert.match(err, /Saved to:/);
    assert.match(err, /Not downloaded: no terminal/);
    assert.ok(!existsSync(dir) || readdirSync(dir).length === 0);
    assert.ok(!s.seen.some((x) => x.startsWith("GET")), "weights were not requested");
    // with --yes it downloads
    const child2 = spawn(process.execPath, [CLI, "model", "download", "--yes"], { env: { ...process.env, UNSTUCK_MODEL_DIR: dir, UNSTUCK_MODEL_MIRROR: s.base }, stdio: ["ignore", "pipe", "pipe"] });
    let err2 = ""; child2.stderr.on("data", (d) => (err2 += d));
    assert.equal(await new Promise((ok) => child2.on("close", ok)), 0, err2);
    assert.match(err2, /SHA-256 verified/);
    assert.equal(installedModels({ UNSTUCK_MODEL_DIR: dir }).length, 1);
  } finally { s.close(); }
});

test("CLI model runtime: refuses without consent, installs nothing", () => {
  const dir = path.join(tmp(), "rt");
  const r = cli(["model", "runtime"], { UNSTUCK_RUNTIME_DIR: dir });
  assert.equal(r.status, 3); assert.match(r.stderr, /node-llama-cpp@3\.22\.2/); assert.match(r.stderr, /registry\.npmjs\.org/);
  assert.ok(!existsSync(dir));
  assert.ok(platformPackage("darwin", "arm64").endsWith("mac-arm64-metal"));
  assert.equal(platformPackage("aix", "ppc64"), null);
});

// ---------- prompt fitting ----------
test("prompt is shrunk to fit small context windows, and refused when it can't fit", () => {
  const f = collectFacts(project()); const findings = runRules(f);
  const big = fitPrompt({ contextTokens: 32768 }, f, findings);
  const small = fitPrompt({ contextTokens: 2048 }, f, findings);
  assert.ok(big && small && small.tokens <= 2048 - ANSWER_TOKENS);
  assert.equal(fitPrompt({ contextTokens: 1000 }, f, findings), null);
});

// ---------- runtime behaviour, fallback, privacy (fake runtime: no real model needed) ----------
function runEmbedded(mode, extraArgs = [], extraEnv = {}) {
  const repo = project(), models = tmp(), reports = tmp(), logf = path.join(tmp(), "llama.log"), netlog = path.join(tmp(), "net.log");
  const before = takeSnapshot(repo);
  installFake(models, "qwen2.5-coder-1.5b");
  const r = cli(["rescue", repo, "--engine", "embedded", ...extraArgs], {
    UNSTUCK_MODEL_DIR: models, UNSTUCK_REPORT_DIR: reports, UNSTUCK_RUNTIME_MODULE: FAKE,
    FAKE_LLAMA_MODE: mode, FAKE_LLAMA_LOG: logf, NET_LOG: netlog, NODE_OPTIONS: `--require ${NONET}`, ...extraEnv,
  });
  return { r, calls: readLog(logf), net: existsSync(netlog) ? readFileSync(netlog, "utf8").trim() : "", changed: totalChanges(diffSnapshots(before, takeSnapshot(repo))) };
}

test("embedded engine: runs in-process with build/download off, threads set, no network, secrets filtered, project untouched", () => {
  const { r, calls, net, changed } = runEmbedded("good");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /engine: embedded model Qwen2\.5-Coder 1\.5B/);
  assert.match(r.stdout, /Add a test for 300 AED/);
  assert.match(r.stdout, /\(embedded model\) running inside UNSTUCK on this computer/);
  const g = calls.find((c) => c.call === "getLlama").opts;
  assert.equal(g.build, "never"); assert.equal(g.skipDownload, true);
  assert.equal(calls.find((c) => c.call === "createContext").threads, 3);
  const prompt = JSON.stringify(calls.filter((c) => c.call === "prompt"));
  assert.ok(!prompt.includes(KEY), "API key not sent to the model");
  assert.ok(!prompt.includes("S".repeat(30)), ".env contents never read");
  assert.equal(net, "", "no network attempts at all");
  assert.equal(changed, 0, "project unchanged");
  assert.ok(calls.some((c) => c.call === "disposeLlama"), "runtime released");
});

for (const [mode, why] of [["throw-load", /could not load the model/], ["throw-prompt", /failed while answering \(llama_decode failed\)/], ["garbage", /failed UNSTUCK's checks/]]) {
  test(`embedded engine: ${mode} gives a clearly labelled offline diagnosis`, () => {
    const { r, net, changed } = runEmbedded(mode);
    assert.equal(r.status, 0, r.stderr);
    const top = r.stdout.trim().split("\n")[0];
    assert.match(top, /^> ⚠️ \*\*The embedded/, "label is the first line");
    assert.match(r.stdout, why);
    assert.match(r.stdout, /### One Recommended Next Move/);
    assert.match(r.stderr, /engine: offline \(fallback/);
    assert.equal(net, ""); assert.equal(changed, 0);
  });
}

test("embedded engine: missing model file, corrupted file, no model, no runtime — all labelled offline, nothing downloaded", () => {
  const d = tmp();
  const bad = path.join(d, "bad.gguf"); writeFileSync(bad, Buffer.alloc(2 * 1024 * 1024, 1));
  const cases = [
    [["--model-file", path.join(d, "missing.gguf")], {}, /model file not found/],
    [["--model-file", bad], {}, /not a GGUF model file/],
    [[], { UNSTUCK_MODEL_DIR: tmp() }, /no embedded model is installed.*asks before downloading/],
    [[], { UNSTUCK_RUNTIME_MODULE: path.join(d, "no-runtime.mjs") }, /runtime isn't installed/],
  ];
  for (const [args, env, want] of cases) {
    const { r, net } = runEmbedded("good", args, env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout.trim().split("\n")[0], /^> ⚠️ \*\*The embedded AI model was not used/);
    assert.match(r.stdout, want);
    assert.equal(net, "", "no network attempts");
  }
});

test("model context smaller than the prompt: shrunk to fit", () => {
  const { r, calls } = runEmbedded("good", [], { FAKE_LLAMA_CTX: "2048" });
  assert.equal(r.status, 0);
  assert.equal(calls.find((c) => c.call === "createContext").contextSize, 2048);
  const p = calls.find((c) => c.call === "prompt");
  assert.ok(Math.ceil(p.system.length / 4) + Math.ceil(p.user.length / 4) <= 2048 - ANSWER_TOKENS, "what was sent fits the window with room to answer");
});

test("offline engine: no model, no runtime, no network attempts", () => {
  const repo = project(), netlog = path.join(tmp(), "net.log");
  const r = cli(["rescue", repo, "--engine", "offline"], { UNSTUCK_REPORT_DIR: tmp(), UNSTUCK_MODEL_DIR: tmp(), UNSTUCK_RUNTIME_DIR: tmp(), NET_LOG: netlog, NODE_OPTIONS: `--require ${NONET}` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /engine: offline \(free, no AI\)/);
  assert.ok(!existsSync(netlog) || readFileSync(netlog, "utf8").trim() === "");
});

test("auto: uses an installed embedded model when no server is running, never downloads", () => {
  const repo = project(), models = tmp(), netlog = path.join(tmp(), "net.log");
  const env = { UNSTUCK_REPORT_DIR: tmp(), UNSTUCK_RUNTIME_MODULE: FAKE, NET_LOG: netlog, NODE_OPTIONS: `--require ${NONET}` };
  let r = cli(["rescue", repo, "--llm-url", "http://127.0.0.1:9"], { ...env, UNSTUCK_MODEL_DIR: models });
  assert.match(r.stderr, /engine: offline \(free, no AI\)/, "nothing installed: offline, no download");
  installFake(models, "qwen2.5-coder-1.5b");
  r = cli(["rescue", repo, "--llm-url", "http://127.0.0.1:9"], { ...env, UNSTUCK_MODEL_DIR: models });
  assert.match(r.stderr, /engine: embedded model/);
  const net = existsSync(netlog) ? readFileSync(netlog, "utf8") : "";
  assert.ok(!/huggingface|https/.test(net), `no external network: ${net}`);
  assert.equal(findRuntime({ UNSTUCK_RUNTIME_MODULE: FAKE }), FAKE);
});
