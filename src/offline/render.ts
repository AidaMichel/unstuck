import type { Facts } from "./facts.js";
import { counts, type Finding } from "./rules.js";

export function gitLine(f: Facts): string {
  if (!f.git.isRepo) return "Not a git repository.";
  const last = f.git.commits[0];
  return `Branch \`${f.git.branch}\`, ${f.git.modified.length} modified and ${f.git.untracked.length} untracked files, ${f.git.commits.length >= 50 ? "50+" : f.git.commits.length} recent commits${last ? `, last: ${last.hash} "${last.subject}" (${last.date})` : ""}.`;
}

/** The single next move: fix the worst verified problem, else confirm the strongest hypothesis. */
// When several proven problems tie, the one most likely to be keeping the project stuck goes first.
const STUCK_PRIORITY = ["secret-in-code", "secret-file-tracked", "no-git", "fix-loop", "no-tests", "competing-versions", "uncommitted-pile", "prompt-injection"];
const rank = (x: Finding) => { const i = STUCK_PRIORITY.indexOf(x.rule); return i < 0 ? 99 : i; };

export function nextMove(findings: Finding[]): string {
  const sev = (x: Finding) => Number(x.severity[1]);
  const v = findings.filter((x) => x.verified).sort((a, b) => sev(a) - sev(b) || rank(a) - rank(b))[0];
  if (v) return `**You (or your AI tool) should:** ${v.next}\n\n**Why this first:** it's the most serious problem the evidence proves (${v.id}: ${v.title.toLowerCase()}).\n\n**You'll know it worked when:** a re-run of \`unstuck rescue\` no longer lists ${v.id}'s problem.`;
  const h = findings[0];
  if (h) return `**You should:** ${h.next}\n\n**Why this first:** it's the most likely cause UNSTUCK couldn't prove on its own (${h.id}).\n\n**You'll know it worked when:** you can say whether ${h.id} is real or not.`;
  return "**You should:** run your app's main user flow once by hand and note exactly where it fails. The automatic checks found nothing, so the problem is likely in behaviour UNSTUCK can't see without running the app.\n\n**You'll know it worked when:** you can describe the failure as \"I did X, expected Y, got Z\".";
}

export function summaryLine(findings: Finding[]): string {
  const c = counts(findings.filter((x) => x.verified)); // only proven problems count toward --fail-on
  return `<!-- unstuck:summary P0=${c.P0} P1=${c.P1} P2=${c.P2} P3=${c.P3} -->`;
}

export function renderReport(f: Facts, findings: Finding[], userNote?: string, notice?: string): string {
  const verified = findings.filter((x) => x.verified);
  const hyps = findings.filter((x) => !x.verified);
  const out: string[] = [];
  // A notice (e.g. why an AI engine wasn't used) goes first so nobody mistakes this for the AI's answer.
  if (notice) out.push(`> ⚠️ **${notice}**\n`);

  out.push("### Goal");
  out.push(f.intent ? `${f.intent.text} _(${f.intent.source})_` : "Not stated anywhere in the project (no README summary, GUARDIAN.md or package.json description).");
  if (userNote) out.push(`\nWhat feels stuck, in your words: _${userNote}_`);

  out.push("\n### Reality");
  const testsLine = f.files.tests.length ? `${f.files.tests.length} test file(s)` : "no test files";
  out.push(`${f.stack.length ? f.stack.join(", ") : "Unknown stack"} project with ${f.files.source.length} source files and ${testsLine}${f.files.truncated ? " (very large; only the first 20,000 files were scanned)" : ""}.`);
  out.push(gitLine(f));

  out.push("\n### Evidence");
  const ev = findings.flatMap((x) => x.evidence.slice(0, 2).map((e) => `- ${e} _(${x.id})_`));
  out.push(ev.length ? ev.slice(0, 12).join("\n") : "- No problems detected by the automatic checks.");

  out.push("\n### Verified Problems");
  out.push(verified.length
    ? verified.map((x) => `- **${x.id} · ${x.severity} · ${x.title}.** ${x.why}\n  - Fix: ${x.next}`).join("\n")
    : "None verified yet.");

  out.push("\n### Hypotheses");
  out.push(hyps.length
    ? hyps.map((x) => `- **${x.id} · ${x.title}.** ${x.why}\n  - To confirm: ${x.next}`).join("\n")
    : "None from the automatic checks. Problems in how the app *behaves* need someone to run it.");

  out.push("\n### One Recommended Next Move");
  out.push(nextMove(findings));

  out.push(`\n---\n_Diagnosed by UNSTUCK's free offline engine: rule-based checks of your files and git history. Nothing was changed, nothing was run, nothing left your computer._`);
  out.push(summaryLine(findings));
  return out.join("\n");
}
