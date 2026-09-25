// Real round trips to production FROM INDIA (and the US, for comparison),
// measured by Globalping's public probe network — this office machine sits
// behind Cloudflare's Chicago edge (cdn-cgi/trace: colo=ORD, loc=US), so it
// cannot stand in for an Indian user.
//
//   node perf-geo.js [probesPerRegion=10]
//
// Only public URLs are sent (the app's own login page, one static chunk, and
// the Convex version endpoint). Per target and region it reports the median
// and p90 of DNS, TCP, TLS, time-to-first-byte and total, from HTTP GETs made
// on real networks in real cities.
const LIMIT = Number(process.argv[2] || 10);
const HOST = "app.ollasuper.com";
const TARGETS = [
  ["/login", "sign-in page (server-rendered HTML)"],
  ["/_next/static/chunks/webpack-e836e93572ec88a1.js", "static JS chunk (Cloudflare edge)"],
  ["/__cvx/version", "Convex round trip (edge → tunnel → VM → Convex)"],
];
const ONLY = process.env.ONLY_PATH || "";
const REGIONS = [
  ["India", [{ country: "IN", limit: LIMIT }]],
  ["United States", [{ country: "US", limit: Math.max(4, Math.round(LIMIT / 2)) }]],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measure(path, locations) {
  const r = await fetch("https://api.globalping.io/v1/measurements", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "http",
      target: HOST,
      locations,
      measurementOptions: { protocol: "HTTPS", request: { method: "GET", path } },
    }),
  });
  const { id, message } = await r.json();
  if (!id) throw new Error(`globalping: ${message || r.status}`);
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const m = await (await fetch(`https://api.globalping.io/v1/measurements/${id}`)).json();
    if (m.status !== "in-progress") return m;
  }
  throw new Error("globalping: timed out");
}

const q = (xs, p) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] : null;
};

(async () => {
  const at = new Date().toISOString();
  console.log(`perf-geo · ${at} · target https://${HOST}\n`);
  for (const [region, locations] of REGIONS) {
    for (const [path, what] of TARGETS.filter(([pth]) => !ONLY || pth.includes(ONLY))) {
      const m = await measure(path, locations);
      const rows = m.results.map((x) => ({
        city: x.probe.city,
        asn: x.probe.network,
        status: x.result.statusCode,
        t: x.result.timings || {},
        cache: (x.result.headers || {})["cf-cache-status"] || "-",
      }));
      const ok = rows.filter((x) => x.status === 200);
      const col = (k) => ok.map((x) => x.t[k]);
      const fmt = (k) => `${q(col(k), 0.5) ?? "–"}/${q(col(k), 0.9) ?? "–"}`;
      console.log(`${region.padEnd(14)} ${what}`);
      console.log(`  probes ${ok.length}/${rows.length} ok · cities: ${[...new Set(ok.map((x) => x.city))].join(", ")}`);
      const caches = ok.reduce((m, x) => ((m[x.cache] = (m[x.cache] || 0) + 1), m), {});
      if (path.includes("/_next/static/")) console.log(`  cf-cache-status: ${JSON.stringify(caches)} · first byte by status: ${["HIT", "MISS"].map((k) => `${k} ${q(ok.filter((x) => x.cache === k).map((x) => x.t.firstByte), 0.5) ?? "–"}ms`).join(", ")}`);
      console.log(`  ms p50/p90 — dns ${fmt("dns")} · tcp ${fmt("tcp")} · tls ${fmt("tls")} · first byte ${fmt("firstByte")} · total ${fmt("total")}\n`);
    }
  }
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
