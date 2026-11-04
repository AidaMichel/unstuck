export type Counts = { P0: number; P1: number; P2: number; P3: number };
const LEVELS = ["P0", "P1", "P2", "P3"] as const;

/** Read the machine summary line; fall back to counting rows of the findings table. */
export function parseSummary(report: string): Counts | null {
  const m = report.match(/<!--\s*unstuck:summary\s+P0=(\d+)\s+P1=(\d+)\s+P2=(\d+)\s+P3=(\d+)\s*-->/);
  if (m) return { P0: +m[1], P1: +m[2], P2: +m[3], P3: +m[4] };
  const counts: Counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  let rows = 0;
  for (const line of report.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim().replace(/[*_`]/g, ""));
    const sev = cells.find((c) => /^P[0-3]$/.test(c)) as keyof Counts | undefined;
    if (sev) { counts[sev]++; rows++; }
  }
  return rows ? counts : null;
}

/** Exit code for CI: 1 if there are findings at `failOn` severity or worse. */
export function gate(report: string, failOn?: string, warn: (m: string) => void = console.error): number {
  if (!failOn) return 0;
  const upto = LEVELS.indexOf(failOn.toUpperCase() as (typeof LEVELS)[number]);
  if (upto < 0) {
    warn(`Unknown --fail-on level "${failOn}" (use P0, P1, P2 or P3); not failing.`);
    return 0;
  }
  const s = parseSummary(report);
  if (!s) {
    if (/\bDo not ship\b/i.test(report)) {
      warn("No findings table found, but the verdict is 'Do not ship'. Failing.");
      return 1;
    }
    warn("Could not find a findings summary in the report; not failing.");
    return 0;
  }
  const hits = LEVELS.slice(0, upto + 1).reduce((n, l) => n + s[l], 0);
  if (hits > 0) {
    warn(`Failing: ${hits} finding(s) at ${failOn.toUpperCase()} or worse.`);
    return 1;
  }
  return 0;
}

// Keys and tokens must never reach a report or a PR comment, even if the agent quotes one.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-(proj-|live_|test_)?[A-Za-z0-9_-]{20,}/g,
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}/g,
  /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs (e.g. Supabase service keys)
  /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^:\s/]+:[^@\s]+@/g, // URLs with passwords
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED SECRET]");
  return out;
}

/** GitHub comments are capped at 65,536 characters. */
export function forComment(report: string, max = 60_000): string {
  if (report.length <= max) return report;
  const summary = report.match(/<!--\s*unstuck:summary[^>]*-->/)?.[0] ?? "";
  return report.slice(0, max) + "\n\n…_Report truncated. The full report is in the workflow summary and artifact._\n" + summary;
}
