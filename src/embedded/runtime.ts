import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelBackend } from "../llm.js";
import { validateModelFile, type ModelChoice } from "./store.js";

// The embedded engine runs a GGUF model inside the UNSTUCK process with node-llama-cpp.
// node-llama-cpp is NOT a dependency of UNSTUCK (it would add ~90-750 MB to every install);
// it's installed only on request with `unstuck model runtime`. It's always loaded with
// build: "never", so it never downloads or compiles anything at run time.

export const RUNTIME_VERSION = "3.22.2";

export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.UNSTUCK_RUNTIME_DIR ? path.resolve(env.UNSTUCK_RUNTIME_DIR) : path.join(os.homedir(), ".unstuck", "runtime");
}

/** The prebuilt binary package for this computer (CPU, or Metal on Apple Silicon). */
export function platformPackage(platform = process.platform, arch = process.arch): string | null {
  const map: Record<string, string> = {
    "darwin-arm64": "mac-arm64-metal", "darwin-x64": "mac-x64",
    "linux-x64": "linux-x64", "linux-arm64": "linux-arm64",
    "win32-x64": "win-x64", "win32-arm64": "win-arm64",
  };
  const p = map[`${platform}-${arch}`];
  return p ? `@node-llama-cpp/${p}` : null;
}

// Minimal shape of the parts of node-llama-cpp we use (kept small so tests can provide a fake).
interface Runtime {
  getLlama(opts: Record<string, unknown>): Promise<{
    cpuMathCores?: number;
    loadModel(o: { modelPath: string; loadSignal?: AbortSignal }): Promise<{
      trainContextSize: number;
      tokenize(t: string): unknown[];
      createContext(o: { contextSize: number; threads?: number }): Promise<{ getSequence(): unknown; dispose(): Promise<void> }>;
      dispose(): Promise<void>;
    }>;
    dispose(): Promise<void>;
  }>;
  LlamaChatSession: new (o: { contextSequence: unknown; systemPrompt?: string }) => {
    prompt(text: string, o: { maxTokens?: number; temperature?: number; signal?: AbortSignal }): Promise<string>;
  };
  LlamaLogLevel?: Record<string, unknown>;
}

/** Where the runtime would be loaded from, or null if it isn't installed. */
export function findRuntime(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.UNSTUCK_RUNTIME_MODULE) return existsSync(env.UNSTUCK_RUNTIME_MODULE) ? path.resolve(env.UNSTUCK_RUNTIME_MODULE) : null;
  const local = path.join(runtimeDir(env), "node_modules", "node-llama-cpp", "dist", "index.js");
  if (existsSync(local)) return local;
  return null;
}

async function loadRuntime(env: NodeJS.ProcessEnv): Promise<Runtime> {
  const where = findRuntime(env);
  if (!where) throw new Error("the embedded AI runtime isn't installed (run `unstuck model runtime`)");
  return (await import(pathToFileURL(where).href)) as Runtime;
}

export interface EmbeddedStats { loadMs: number; contextTokens: number; answerMs?: number; peakRssMB?: number }

/**
 * Load the model and return a backend for the shared diagnosis pipeline.
 * Throws (and the caller falls back to a labelled offline report) on any problem.
 */
export async function embeddedBackend(
  choice: ModelChoice,
  opts: { env?: NodeJS.ProcessEnv; maxContext?: number; timeoutMs?: number } = {},
): Promise<{ backend: ModelBackend; stats: EmbeddedStats }> {
  const env = opts.env ?? process.env;
  validateModelFile(choice.file, choice.expectedBytes);
  const rt = await loadRuntime(env);
  const started = performance.now();
  let peak = process.memoryUsage().rss;
  const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 200);
  sample.unref();
  const llama = await rt.getLlama({
    build: "never", skipDownload: true, usePrebuiltBinaries: true, progressLogs: false,
    gpu: env.UNSTUCK_EMBEDDED_GPU === "off" ? false : "auto",
    ...(rt.LlamaLogLevel ? { logLevel: rt.LlamaLogLevel.error } : {}),
  });
  let model: Awaited<ReturnType<typeof llama.loadModel>> | undefined;
  let context: Awaited<ReturnType<NonNullable<typeof model>["createContext"]>> | undefined;
  const dispose = async () => {
    clearInterval(sample);
    await context?.dispose().catch(() => {});
    await model?.dispose().catch(() => {});
    await llama.dispose().catch(() => {});
  };
  try {
    model = await llama.loadModel({ modelPath: choice.file });
    const contextTokens = Math.min(model.trainContextSize || 4096, choice.contextTokens ?? 8192, opts.maxContext ?? 8192);
    // Set threads explicitly to the physical math cores. Leaving it unset was 25x slower on a 2-core test VM
    // (0.47 vs 12.2 tokens/s generating), apparently from oversubscribed threads.
    const threads = Math.max(1, Number(env.UNSTUCK_EMBEDDED_THREADS) || llama.cpuMathCores || os.availableParallelism());
    context = await model.createContext({ contextSize: contextTokens, threads });
    const stats: EmbeddedStats = { loadMs: Math.round(performance.now() - started), contextTokens };
    const m = model, c = context;
    const backend: ModelBackend = {
      model: choice.label,
      engine: "embedded model",
      where: "inside UNSTUCK on this computer",
      contextTokens,
      countTokens: (t) => m.tokenize(t).length,
      async ask(system, user, maxAnswerTokens) {
        const t0 = performance.now();
        const session = new rt.LlamaChatSession({ contextSequence: c.getSequence(), systemPrompt: system });
        const answer = await session.prompt(user, { maxTokens: maxAnswerTokens, temperature: 0.2, signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000) });
        stats.answerMs = Math.round(performance.now() - t0);
        peak = Math.max(peak, process.memoryUsage().rss);
        stats.peakRssMB = Math.round(peak / 1e6);
        return answer;
      },
      dispose,
    };
    return { backend, stats };
  } catch (err) {
    await dispose();
    throw err;
  }
}
