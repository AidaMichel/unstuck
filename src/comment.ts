// Used by the GitHub Action: turns a report into a PR comment body.
import { readFileSync, writeFileSync } from "node:fs";
import { forComment, redact } from "./report.js";

export const MARKER = "<!-- unstuck:comment -->";

const [, , input, output] = process.argv;
if (input && output) {
  const report = redact(readFileSync(input, "utf8"));
  writeFileSync(output, `${MARKER}\n## 🛟 UNSTUCK review\n\n${forComment(report)}\n`);
}
