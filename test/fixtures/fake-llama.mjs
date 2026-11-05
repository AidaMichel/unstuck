// Stand-in for node-llama-cpp in tests. Behaviour is set by FAKE_LLAMA_MODE; calls are logged to FAKE_LLAMA_LOG.
import { appendFileSync } from "node:fs";
const mode = process.env.FAKE_LLAMA_MODE ?? "good";
const logf = process.env.FAKE_LLAMA_LOG;
const log = (o) => { if (logf) appendFileSync(logf, JSON.stringify(o) + "\n"); };
export const LlamaLogLevel = { error: "error" };
export const GOOD = `### Goal
Split bills (README.md).
### Reality
Small project.
### Evidence
- src/split.js:1 — divides
### Verified Problems
- none beyond the rule checks
### Hypotheses
- rounding may be missing
### One Recommended Next Move
Add a test for 300 AED split 3 ways.`;
export async function getLlama(opts) {
  log({ call: "getLlama", opts });
  return {
    cpuMathCores: 3,
    async loadModel(o) {
      log({ call: "loadModel", modelPath: o.modelPath });
      if (mode === "throw-load") throw new Error("failed to load model: invalid GGUF tensor data");
      return {
        trainContextSize: Number(process.env.FAKE_LLAMA_CTX ?? 32768),
        tokenize: (t) => new Array(Math.ceil(t.length / 4)),
        async createContext(c) { log({ call: "createContext", ...c }); return { getSequence: () => ({}), dispose: async () => {} }; },
        dispose: async () => log({ call: "disposeModel" }),
      };
    },
    dispose: async () => log({ call: "disposeLlama" }),
  };
}
export class LlamaChatSession {
  constructor(o) { this.system = o.systemPrompt; }
  async prompt(text, o) {
    log({ call: "prompt", system: this.system, user: text, maxTokens: o.maxTokens });
    if (mode === "throw-prompt") throw new Error("llama_decode failed");
    if (mode === "garbage") return "FACTS (collected by code) uncommitted uncommitted uncommitted";
    return GOOD;
  }
}
