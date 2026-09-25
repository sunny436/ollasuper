// Post-deploy: warm Cloudflare's INDIAN edges with this build's first-visit files.
//
//   node warm-edge.js [credsFile]      # after every frontend deploy
//
// Why: the VM is in the US, and every deploy mints new content-hashed chunk
// URLs. Until an Indian colo has fetched a file once, an Indian visitor's first
// load pays a MISS for it — first byte ~0.8-1.1 s against 29-37 ms on a HIT
// (perf-geo.js). Tiered Cache would fix this at the source, but it is a
// ZONE-WIDE setting and ollasuper.com is shared with properties that are not
// ours, so it is not ours to flip. This does the next best thing: it fetches
// each file once from real Indian networks (Globalping's public probes), so the
// colos those networks use hold the file before a user asks for it.
//
// The file set is what a real first visit requests: /login, then the signed-in
// /en/chat, recorded in a headed browser when a creds file (qa-throwaway.js
// format) is given; without one, only what /login's HTML references.
// It measures a sample BEFORE and AFTER from different probes and prints the
// cf-cache-status and colo mix, so the effect is evidence rather than assumed.
// Only public static URLs are ever sent to Globalping. Anonymous quota is 250
// probe-tests/hour; the plan is sized from the live quota.
const fs = require("node:fs");

const BASE = "https://app.ollasuper.com";
const HOST = "app.ollasuper.com";
const CREDS = process.argv[2];
const SAMPLE = 8; //        paths measured before and after
const SAMPLE_PROBES = 3; // per sampled path
const MAX_PROBES = 5; //    per path during the warm-up
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function staticSetFromBrowser(creds) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: false });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const seen = new Set();
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.host === HOST && u.pathname.startsWith("/_next/static/")) seen.add(u.pathname);
  });
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => {
    const f = document.querySelector("form");
    return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber"));
  }, null, { timeout: 30000 });
  await page.locator('input[type="email"]').first().fill(creds.email);
  await page.locator('input[type="password"]').first().fill(creds.password);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await browser.close();
  return [...seen];
}

async function staticSetFromHtml() {
  const html = await (await fetch(`${BASE}/login`)).text();
  return [...new Set(html.match(/\/_next\/static\/[^"'\s\\)]+/g) || [])];
}

async function quota() {
  const j = await (await fetch("https://api.globalping.io/v1/limits")).json();
  return j.rateLimit.measurements.create.remaining;
}

/** One Globalping HTTP GET of `path` from `limit` Indian probes → per-probe {cache, colo, firstByte}. */
async function fromIndia(path, limit) {
  const r = await fetch("https://api.globalping.io/v1/measurements", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "http",
      target: HOST,
      locations: [{ country: "IN", limit }],
      measurementOptions: { protocol: "HTTPS", request: { method: "GET", path } },
    }),
  });
  const { id, message } = await r.json();
  if (!id) throw new Error(`globalping ${r.status}: ${message || "no id"}`);
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const m = await (await fetch(`https://api.globalping.io/v1/measurements/${id}`)).json();
    if (m.status === "in-progress") continue;
    return m.results
      .filter((x) => x.result.statusCode === 200)
      .map((x) => ({
        cache: (x.result.headers || {})["cf-cache-status"] || "-",
        colo: String((x.result.headers || {})["cf-ray"] || "").split("-").pop() || "?",
        firstByte: (x.result.timings || {}).firstByte,
      }));
  }
  throw new Error("globalping: timed out");
}

async function sample(label, paths) {
  const rows = (await Promise.all(paths.map((p) => fromIndia(p, SAMPLE_PROBES)))).flat();
  const by = (k) => rows.reduce((m, r) => ((m[r[k]] = (m[r[k]] || 0) + 1), m), {});
  const hits = rows.filter((r) => r.cache === "HIT").length;
  const med = (xs) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : "–");
  console.log(
    `${label}: HIT ${hits}/${rows.length} (${Math.round((100 * hits) / Math.max(1, rows.length))}%) · ` +
      `cache ${JSON.stringify(by("cache"))} · colos ${JSON.stringify(by("colo"))} · ` +
      `MISS by colo ${JSON.stringify(rows.filter((r) => r.cache !== "HIT").reduce((m, r) => ((m[r.colo] = (m[r.colo] || 0) + 1), m), {}))} · ` +
      `first byte p50 ${med(rows.map((r) => r.firstByte).filter(Number.isFinite))} ms`,
  );
}

(async () => {
  const creds = CREDS ? JSON.parse(fs.readFileSync(CREDS, "utf8")) : null;
  const paths = creds ? await staticSetFromBrowser(creds) : await staticSetFromHtml();
  if (!paths.length) throw new Error("no static paths found");
  // Deterministic sample: every k-th path, so before/after compare the same files.
  const step = Math.max(1, Math.floor(paths.length / SAMPLE));
  const sampled = paths.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  const left = await quota();
  const reserve = 2 * sampled.length * SAMPLE_PROBES;
  const perPath = Math.min(MAX_PROBES, Math.floor((left - reserve) / paths.length));
  if (process.env.VERIFY_ONLY && left < sampled.length * SAMPLE_PROBES) throw new Error(`quota ${left} too low to verify`);
  console.log(`first-visit static files: ${paths.length} · Globalping quota ${left} · warm-up ${perPath} Indian probes per file`);
  if (perPath < 1 && !process.env.VERIFY_ONLY) throw new Error(`not enough Globalping quota (${left}); retry within the hour`);

  // VERIFY_ONLY=1: just the sample, e.g. to re-check an earlier warm-up.
  if (process.env.VERIFY_ONLY) return sample("verify", sampled);
  await sample("before", sampled);
  let warmed = 0;
  const colos = {};
  for (let i = 0; i < paths.length; i += 6) {
    const batch = await Promise.all(paths.slice(i, i + 6).map((p) => fromIndia(p, perPath).catch(() => [])));
    for (const rows of batch) {
      if (rows.length) warmed++;
      for (const r of rows) colos[r.colo] = (colos[r.colo] || 0) + 1;
    }
  }
  console.log(`warmed ${warmed}/${paths.length} files · fetches per colo ${JSON.stringify(colos)}`);
  await sleep(3000);
  await sample("after ", sampled);
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
