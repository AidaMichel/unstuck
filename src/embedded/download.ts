import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { formatBytes, type CatalogModel } from "./catalog.js";
import { modelDir, sidecarPath } from "./store.js";

// Model weights are downloaded ONLY by `unstuck model download`, after the user has seen
// what will be downloaded and agreed. Never during install, build, tests or a diagnosis run.

export interface RemoteInfo { bytes?: number; sha256?: string; finalUrl: string; requestedUrl?: string }

export class DownloadError extends Error {}

function allowedUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return true;
    // Plain HTTP only for a server on this computer (a local mirror, or tests).
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

/** Ask the source for the exact size and SHA-256 (Hugging Face sends x-linked-size / x-linked-etag). */
export async function remoteInfo(url: string, timeoutMs = 15_000): Promise<RemoteInfo> {
  if (!allowedUrl(url)) throw new DownloadError(`refusing to download from ${url}: only https (or a server on this computer) is allowed`);
  const res = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  let bytes = Number(res.headers.get("x-linked-size") ?? NaN);
  let sha = res.headers.get("x-linked-etag")?.replace(/^W\//, "").replace(/"/g, "");
  let finalUrl = url;
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    finalUrl = new URL(res.headers.get("location")!, url).toString();
  } else if (!res.ok) {
    throw new DownloadError(`the source answered ${res.status} for ${url}`);
  }
  if (!Number.isFinite(bytes)) {
    const len = Number(res.headers.get("content-length") ?? NaN);
    bytes = Number.isFinite(len) ? len : NaN;
  }
  if (sha && !/^[a-f0-9]{64}$/.test(sha)) sha = undefined; // only trust a real SHA-256
  return { bytes: Number.isFinite(bytes) ? bytes : undefined, sha256: sha, finalUrl, requestedUrl: url };
}

export function consentText(m: CatalogModel, info: RemoteInfo, dest: string): string {
  return [
    "UNSTUCK would like to download an open-source AI model so it can run on this computer.",
    "",
    `  Model:        ${m.name}`,
    `  Size:         ${info.bytes ? formatBytes(info.bytes) + ` (${info.bytes.toLocaleString("en-US")} bytes)` : `about ${formatBytes(m.approxBytes)} (the source did not state an exact size)`}`,
    `  Source:       ${m.source}`,
    `                ${info.requestedUrl ?? m.url}`,
    `  License:      ${m.license} — ${m.licenseUrl}`,
    `  Saved to:     ${dest}`,
    `  Checksum:     ${info.sha256 ? `SHA-256 ${info.sha256} (published by the source; the download is verified against it)` : "the source did not publish a SHA-256; the file can't be verified"}`,
    `  Memory:       needs about ${m.minRamGB} GB of free RAM to run`,
    "",
    "Only the model file is downloaded. Your project's files are never uploaded anywhere.",
  ].join("\n");
}

/** Consent: --yes, or an interactive "y". Never assumed when there's no terminal to ask. */
export async function askConsent(opts: { yes?: boolean; input?: NodeJS.ReadableStream & { isTTY?: boolean }; output?: NodeJS.WritableStream }): Promise<boolean> {
  if (opts.yes) return true;
  const input = opts.input ?? process.stdin;
  if (!input.isTTY) return false;
  const rl = createInterface({ input, output: opts.output ?? process.stderr });
  try {
    const answer = (await rl.question("Download it now? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally { rl.close(); }
}

export interface DownloadResult { file: string; bytes: number; sha256: string; verified: boolean }

export async function downloadModel(
  m: CatalogModel, info: RemoteInfo,
  opts: { env?: NodeJS.ProcessEnv; progress?: (done: number, total?: number) => void; allowUnverified?: boolean } = {},
): Promise<DownloadResult> {
  if (!info.sha256 && !opts.allowUnverified) {
    throw new DownloadError("the source did not publish a SHA-256 for this file, so it can't be verified. Re-run with --allow-unverified to download anyway.");
  }
  const dir = modelDir(opts.env);
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, m.file);
  const part = dest + ".part";
  if (info.bytes) {
    try {
      const fsInfo = statfsSync(dir);
      const free = Number(fsInfo.bavail) * Number(fsInfo.bsize);
      if (free < info.bytes * 1.05) throw new DownloadError(`not enough free disk space in ${dir}: ${formatBytes(free)} free, ${formatBytes(info.bytes)} needed`);
    } catch (e) { if (e instanceof DownloadError) throw e; /* statfs unsupported: continue */ }
  }
  if (!allowedUrl(info.finalUrl)) throw new DownloadError(`refusing to follow a redirect to ${info.finalUrl}`);
  const res = await fetch(info.finalUrl, { redirect: "follow" });
  if (!res.ok || !res.body) throw new DownloadError(`download failed: the source answered ${res.status}`);
  if (!allowedUrl(res.url || info.finalUrl)) throw new DownloadError(`refusing a redirect to ${res.url}`);

  const hash = createHash("sha256");
  let done = 0;
  const out = createWriteStream(part);
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      done += chunk.length;
      if (info.bytes && done > info.bytes) throw new DownloadError(`the source sent more data than announced (${done} > ${info.bytes} bytes)`);
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      opts.progress?.(done, info.bytes);
    }
    await new Promise<void>((ok, bad) => out.end((err?: Error | null) => (err ? bad(err) : ok())));
  } catch (err) {
    out.destroy();
    rmSync(part, { force: true });
    throw err;
  }
  const sha256 = hash.digest("hex");
  if (info.bytes && done !== info.bytes) { rmSync(part, { force: true }); throw new DownloadError(`download incomplete: got ${done} of ${info.bytes} bytes`); }
  if (info.sha256 && sha256 !== info.sha256) { rmSync(part, { force: true }); throw new DownloadError(`checksum mismatch: expected ${info.sha256}, got ${sha256}. The file was deleted.`); }
  if (existsSync(dest)) rmSync(dest, { force: true });
  renameSync(part, dest);
  writeFileSync(sidecarPath(dest), JSON.stringify({
    id: m.id, bytes: done, sha256, verified: Boolean(info.sha256), source: info.requestedUrl ?? m.url, license: m.license, downloadedAt: new Date().toISOString(),
  }, null, 2) + "\n");
  return { file: dest, bytes: done, sha256, verified: Boolean(info.sha256) };
}
