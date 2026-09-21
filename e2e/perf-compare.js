// Before/after table for perf-india.js results, with the acceptance rule from
// the Phase 1 plan: a timing metric counts as improved only if the median moved
// by >= max(15 %, 100 ms) AND the after-p90 is <= the before-median; counters
// (requests, bytes, sequential RTTs) count on any strict decrease.
//
//   node perf-compare.js before after            # all three profiles
//   node perf-compare.js before after india      # one profile
const fs = require("node:fs");
const path = require("node:path");
const [A = "before", B = "after", ONLY] = process.argv.slice(2);
const PROFILES = ONLY ? [ONLY] : ["us", "india", "india-poor"];
const TIMING = [
  "login_dcl_ms",
  "signin_url_ms",
  "signin_composer_ms",
  "open_hover_first_row_ms",
  "open_nohover_first_row_ms",
  "newchat_echo_ms",
  "newchat_ack_ms",
  "newchat_first_token_ms",
  "send_echo_ms",
  "send_ack_ms",
  "send_first_token_ms",
];
const COUNTERS = ["login_requests", "login_bytes", "signin_sequential_dynamic", "newchat_ws_bytes", "send_ws_bytes", "sweep_ws_bytes"];
const load = (label, profile) => {
  const f = path.join(__dirname, ".perf", `${label}-${profile}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};
const r = (x) => (x === null || x === undefined ? "n/a" : String(Math.round(x)));
for (const p of PROFILES) {
  const a = load(A, p);
  const b = load(B, p);
  if (!a || !b) {
    console.log(`\n== ${p}: missing ${!a ? A : B}`);
    continue;
  }
  const okA = a.runs.filter((x) => !x.failed).length;
  const okB = b.runs.filter((x) => !x.failed).length;
  const errA = a.runs.reduce((s, x) => s + (x.errors?.length ?? 0), 0);
  const errB = b.runs.reduce((s, x) => s + (x.errors?.length ?? 0), 0);
  console.log(`\n== ${p} — ${A}: ${okA}/${a.runs.length} runs, ${errA} console errors · ${B}: ${okB}/${b.runs.length} runs, ${errB} console errors`);
  console.log(`${"metric".padEnd(28)} ${"before med".padStart(10)} ${"p90".padStart(7)} ${"after med".padStart(10)} ${"p90".padStart(7)} ${"Δ med".padStart(8)} ${"verdict".padStart(9)}`);
  for (const k of TIMING) {
    const x = a.summary[k];
    const y = b.summary[k];
    if (!x || !y || x.median === null || y.median === null) continue;
    const d = y.median - x.median;
    const pct = (-d / x.median) * 100;
    const improved = -d >= Math.max(0.15 * x.median, 100) && y.p90 <= x.median;
    const worse = d >= Math.max(0.15 * x.median, 100);
    const verdict = improved ? "IMPROVED" : worse ? "WORSE" : "same";
    console.log(`${k.padEnd(28)} ${r(x.median).padStart(10)} ${r(x.p90).padStart(7)} ${r(y.median).padStart(10)} ${r(y.p90).padStart(7)} ${(d <= 0 ? "-" : "+").padStart(1)}${r(Math.abs(d)).padStart(6)} ${verdict.padStart(9)}  (${pct >= 0 ? "-" : "+"}${Math.abs(pct).toFixed(0)}%)`);
  }
  for (const k of COUNTERS) {
    const x = a.summary[k];
    const y = b.summary[k];
    if (!x || !y || x.median === null || y.median === null) continue;
    const verdict = y.median < x.median ? "IMPROVED" : y.median > x.median ? "WORSE" : "same";
    console.log(`${k.padEnd(28)} ${r(x.median).padStart(10)} ${"".padStart(7)} ${r(y.median).padStart(10)} ${"".padStart(7)} ${(y.median - x.median <= 0 ? "-" : "+")}${r(Math.abs(y.median - x.median)).padStart(6)} ${verdict.padStart(9)}`);
  }
  const pb = a.summary.open_hover_painted_before_ws;
  const pa = b.summary.open_hover_painted_before_ws;
  console.log(`${"hover: painted before WS".padEnd(28)} ${(pb === null ? "n/a" : Math.round(pb * 100) + "%").padStart(10)} ${"".padStart(7)} ${(pa === null ? "n/a" : Math.round(pa * 100) + "%").padStart(10)}`);
}
