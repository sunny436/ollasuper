// Routine dependency audit (audit D-05). Reads `bun audit --json` on stdin and
// fails on any advisory that is not in security/advisory-backlog.json — the
// reviewed, exposure-based list of advisories that cannot reach the deployed
// runtime. A new advisory, or one on a runtime dependency, therefore stops CI
// until it is fixed or explicitly reviewed into the backlog with a reason.
import { readFileSync } from "node:fs";

const backlog = JSON.parse(
  readFileSync(new URL("../security/advisory-backlog.json", import.meta.url), "utf8"),
).packages;
const raw = readFileSync(0, "utf8").trim();
const report = raw ? JSON.parse(raw) : {};

const unreviewed = [];
for (const [pkg, advisories] of Object.entries(report)) {
  const known = new Set(backlog[pkg]?.advisories ?? []);
  for (const a of advisories) {
    if (!known.has(a.url)) unreviewed.push(`${a.severity.padEnd(8)} ${pkg}  ${a.url}  ${a.title}`);
  }
}
if (unreviewed.length > 0) {
  console.error(`${unreviewed.length} unreviewed advisory(ies):\n${unreviewed.join("\n")}`);
  console.error("Fix the dependency, or review it into security/advisory-backlog.json with a reason.");
  process.exit(1);
}
console.log(`dependency audit clean: every advisory is in the reviewed backlog (${Object.keys(report).length} packages)`);
