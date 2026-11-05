// Models UNSTUCK knows how to download. Nothing here is downloaded automatically.
// Exact size and SHA-256 are read from the source at download time (Hugging Face publishes both
// for every file) and shown to the user before they consent; the download is verified against them.
// Sizes below are approximate and only used for the list view.

export interface CatalogModel {
  id: string;
  name: string;
  file: string;
  url: string;
  source: string;
  license: string;
  licenseUrl: string;
  approxBytes: number;
  minRamGB: number;
  contextTokens: number;
  note: string;
  default?: boolean;
}

export const CATALOG: CatalogModel[] = [
  {
    id: "qwen2.5-coder-1.5b",
    name: "Qwen2.5-Coder 1.5B Instruct (Q4_K_M)",
    file: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
    url: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
    source: "Hugging Face · Qwen (Alibaba Cloud), official repository",
    license: "Apache-2.0",
    licenseUrl: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/blob/main/LICENSE",
    approxBytes: 1.1e9,
    minRamGB: 4,
    contextTokens: 8192,
    note: "Small and fast; runs on most laptops.",
    default: true,
  },
  {
    id: "qwen2.5-coder-7b",
    name: "Qwen2.5-Coder 7B Instruct (Q4_K_M)",
    file: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
    url: "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
    source: "Hugging Face · bartowski (community quantization of Qwen's official model)",
    license: "Apache-2.0",
    licenseUrl: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct/blob/main/LICENSE",
    approxBytes: 4.7e9,
    minRamGB: 10,
    contextTokens: 16384,
    note: "Noticeably better diagnoses; needs a recent laptop with 16 GB RAM.",
  },
];

/** The URL to download from: the catalog URL, or the same path on a mirror (UNSTUCK_MODEL_MIRROR). */
export function sourceUrl(m: CatalogModel, env: NodeJS.ProcessEnv = process.env): string {
  const mirror = env.UNSTUCK_MODEL_MIRROR?.replace(/\/+$/, "");
  return mirror ? m.url.replace(/^https:\/\/huggingface\.co/, mirror) : m.url;
}

export function catalogModel(id: string): CatalogModel | undefined {
  return CATALOG.find((m) => m.id === id);
}

export function defaultModel(): CatalogModel {
  return CATALOG.find((m) => m.default) ?? CATALOG[0];
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}
