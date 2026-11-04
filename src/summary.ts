export function parseSummary(report: string): Record<string, number> | null {
  const m = report.match(/<!--\s*unstuck:summary\s+P0=(\d+)\s+P1=(\d+)\s+P2=(\d+)\s+P3=(\d+)\s*-->/);
  if (!m) return null;
  return { P0: +m[1], P1: +m[2], P2: +m[3], P3: +m[4] };
}

/** Exit code for CI: 1 if there are findings at `failOn` severity or worse. */
export function gate(report: string, failOn?: string): number {
  if (!failOn) return 0;
  const s = parseSummary(report);
  if (!s) {
    console.error("Could not read the summary line; not failing the build.");
    return 0;
  }
  const levels = ["P0", "P1", "P2", "P3"];
  const upto = levels.indexOf(failOn.toUpperCase());
  if (upto < 0) return 0;
  const hits = levels.slice(0, upto + 1).reduce((n, l) => n + s[l], 0);
  if (hits > 0) {
    console.error(`Failing: ${hits} finding(s) at ${failOn.toUpperCase()} or worse.`);
    return 1;
  }
  return 0;
}
