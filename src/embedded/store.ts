import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CATALOG, catalogModel, type CatalogModel } from "./catalog.js";

// Where downloaded models live, and how a model file is checked before it is handed to the runtime.

export interface InstalledModel {
  id: string;
  file: string;
  bytes: number;
  sha256?: string;
  source?: string;
  license?: string;
  downloadedAt?: string;
}

export function modelDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.UNSTUCK_MODEL_DIR ? path.resolve(env.UNSTUCK_MODEL_DIR) : path.join(os.homedir(), ".unstuck", "models");
}

export function sidecarPath(file: string): string {
  return file + ".json";
}

export class ModelFileError extends Error {}

/**
 * Cheap checks before loading: the file exists, is a regular file of plausible size,
 * starts with the GGUF magic bytes, and (for downloaded models) still has the size recorded at download.
 * Deep corruption is caught when the runtime loads it, which also falls back cleanly.
 */
export function validateModelFile(file: string, expectedBytes?: number): { bytes: number } {
  if (!existsSync(file)) throw new ModelFileError(`model file not found: ${file}`);
  const lst = lstatSync(file);
  const st = lst.isSymbolicLink() ? statSync(file) : lst;
  if (!st.isFile()) throw new ModelFileError(`not a regular file: ${file}`);
  if (st.size < 1024 * 1024) throw new ModelFileError(`file is too small to be a model (${st.size} bytes): ${file}`);
  if (expectedBytes !== undefined && st.size !== expectedBytes) {
    throw new ModelFileError(`file size changed since download (${st.size} bytes, expected ${expectedBytes}); it may be incomplete or corrupted: ${file}`);
  }
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    if (head.toString("latin1") !== "GGUF") throw new ModelFileError(`not a GGUF model file (wrong header): ${file}`);
  } finally { closeSync(fd); }
  return { bytes: st.size };
}

function readSidecar(file: string): Partial<InstalledModel> | null {
  try { return JSON.parse(readFileSync(sidecarPath(file), "utf8")); } catch { return null; }
}

/** Models downloaded by `unstuck model download` (catalog models with a sidecar record). */
export function installedModels(env: NodeJS.ProcessEnv = process.env): InstalledModel[] {
  const dir = modelDir(env);
  if (!existsSync(dir)) return [];
  const out: InstalledModel[] = [];
  for (const m of CATALOG) {
    const file = path.join(dir, m.file);
    if (!existsSync(file) || existsSync(file + ".part")) continue;
    const meta = readSidecar(file);
    if (!meta) continue; // not downloaded by UNSTUCK; ignore
    out.push({ id: m.id, file, bytes: meta.bytes ?? 0, sha256: meta.sha256, source: meta.source, license: meta.license, downloadedAt: meta.downloadedAt });
  }
  return out;
}

export function strayFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = modelDir(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".part"));
}

export interface ModelChoice { label: string; file: string; expectedBytes?: number; contextTokens?: number; catalog?: CatalogModel }

/**
 * Pick the model to run. Explicit file > explicit catalog id > best installed catalog model.
 * Returns null when nothing is installed (never downloads).
 */
export function chooseModel(opts: { file?: string; id?: string }, env: NodeJS.ProcessEnv = process.env): ModelChoice | null {
  if (opts.file) return { label: path.basename(opts.file), file: path.resolve(opts.file) };
  const installed = installedModels(env);
  if (opts.id) {
    const cat = catalogModel(opts.id);
    if (!cat) throw new ModelFileError(`unknown model "${opts.id}". Run \`unstuck model list\` to see the options.`);
    const inst = installed.find((m) => m.id === opts.id);
    if (!inst) return null;
    return { label: cat.name, file: inst.file, expectedBytes: inst.bytes || undefined, contextTokens: cat.contextTokens, catalog: cat };
  }
  // Prefer the largest installed model (better diagnoses), in catalog order otherwise.
  const best = [...installed].sort((a, b) => b.bytes - a.bytes)[0];
  if (!best) return null;
  const cat = catalogModel(best.id)!;
  return { label: cat.name, file: best.file, expectedBytes: best.bytes || undefined, contextTokens: cat.contextTokens, catalog: cat };
}
