// score-humanizer.js — score every captured A/B output with the SAME
// deterministic detector the product uses, so the before/after claim is a
// measurement rather than an opinion.
//
//   node score-humanizer.js            # scores everything in e2e/out/
//
// Shells out to the Python detector in services/ai rather than reimplementing
// it: a second implementation could disagree with the one that shipped, and
// then neither number would mean anything.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "out");
const AI = path.join(__dirname, "..", "services", "ai");

const files = fs
  .readdirSync(OUT)
  .filter((f) => f.startsWith("humanizer-") && f.endsWith(".md"))
  .sort();

if (!files.length) {
  console.error("no captured outputs in e2e/out/");
  process.exit(1);
}

const script = `
import json, sys
from app.humanizer.patterns import analyze, human_voice_score
from app.humanizer.preserve import _numbers, _urls, _dates
# Read the FILE as UTF-8. Piping over stdin was decoded as cp1252 on Windows,
# which turned every em-dash and curly quote into mojibake: dashes scored 0 and
# the garbage bytes matched the curly-quote pattern (measured: D21x49, dash 0).
text = open(sys.argv[1], encoding="utf-8").read()
findings, prof = analyze(text)
counts = {}
for f in findings:
    counts[f.pattern] = counts.get(f.pattern, 0) + 1
print(json.dumps({
    "score": human_voice_score(text, findings=findings, prof=prof),
    "words": prof.words,
    "findings": len(findings),
    "per_1k": round(len(findings) * 1000 / max(prof.words, 1), 1),
    "counts": dict(sorted(counts.items(), key=lambda kv: -kv[1])),
    "numbers": len(_numbers(text)),
    "urls": len(_urls(text)),
    "dates": len(_dates(text)),
    "dashes_per_1k": round(prof.dashes_per_1k, 1),
}))
`;

const rows = [];
for (const f of files) {
  const text = fs.readFileSync(path.join(OUT, f), "utf8");
  const raw = execFileSync("uv", ["run", "python", "-c", script, path.join(OUT, f)], {
    cwd: AI,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  rows.push({ file: f.replace("humanizer-", "").replace(".md", ""), ...JSON.parse(raw) });
}

console.log(
  ["piece", "score", "words", "finds", "/1k", "dash/1k", "nums", "urls"]
    .map((h) => h.padEnd(h === "piece" ? 14 : 8))
    .join(""),
);
for (const r of rows) {
  console.log(
    [r.file, r.score, r.words, r.findings, r.per_1k, r.dashes_per_1k, r.numbers, r.urls]
      .map((v, i) => String(v).padEnd(i === 0 ? 14 : 8))
      .join(""),
  );
}
console.log("\ntop patterns per piece:");
for (const r of rows) {
  const top = Object.entries(r.counts)
    .slice(0, 8)
    .map(([k, v]) => `${k}×${v}`)
    .join(" ");
  console.log(`  ${r.file.padEnd(14)} ${top || "(none)"}`);
}
