// Settings section switching: click → URL committed → section heading painted
// → section data painted (its Convex query landed), under a perf-india.js
// profile. Headed Chrome, QA account, zero console errors.
//
//   node perf-settings.js --profile india --runs 3
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const { email: EMAIL, password: PASSWORD } = require("./creds").account();
const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i === -1 ? d : process.argv[i + 1];
};
const PROFILE = arg("profile", "india");
const RUNS = Number(arg("runs", 3));
const mbps = (n) => (n * 1e6) / 8;
const P = { us: null, india: { latency: 260, down: mbps(20), up: mbps(8) }, "india-poor": { latency: 400, down: mbps(4), up: mbps(1) } }[PROFILE];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round((s.length - 1) * p))]; };

// heading = painted when the route segment mounted; data = its query landed.
const SECTIONS = [
  { label: "Appearance", href: "/settings/appearance", heading: "Appearance", data: null },
  { label: "Shared Links", href: "/settings/shared", heading: "Shared Links", data: /Loading…/ },
  { label: "Memories", href: "/settings/memories", heading: "Memories", data: /Loading/ },
  { label: "My Skills", href: "/settings/skills", heading: "My Skills", data: /Loading your skills/ },
  { label: "Archived Chats", href: "/settings/archived", heading: "Archived", data: /Loading/ },
  { label: "Profile", href: "/settings", heading: "Profile", data: null },
];

function delayQueue(oneWayMs, bytesPerSec, send) {
  const q = []; let due = 0; let draining = false;
  const drain = async () => { if (draining) return; draining = true; while (q.length) { const h = q[0]; const w = h.at - Date.now(); if (w > 0) await sleep(w); q.shift(); try { send(h.msg); } catch {} } draining = false; };
  return (msg) => { const bytes = typeof msg === "string" ? msg.length : msg.byteLength ?? 0; const at = Math.max(Date.now() + oneWayMs + (bytes / bytesPerSec) * 1000, due); due = at; q.push({ msg, at }); void drain(); };
}

(async () => {
  const b = await chromium.launch({ headless: false });
  const ctx = await b.newContext({ viewport: { width: 1360, height: 860 } });
  if (P) {
    await ctx.routeWebSocket(/\/__cvx\//, (ws) => {
      const server = ws.connectToServer();
      const up = delayQueue(P.latency / 2, P.up, (m) => server.send(m));
      const down = delayQueue(P.latency / 2, P.down, (m) => ws.send(m));
      ws.onMessage((m) => up(m));
      server.onMessage((m) => down(m));
      ws.onClose((c, r) => server.close({ code: c, reason: r }));
      server.onClose((c, r) => ws.close({ code: c, reason: r }));
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  const reqs = [];
  page.on("request", (r) => reqs.push({ t: now(), url: r.url().replace(BASE, ""), nav: r.isNavigationRequest() }));
  if (P) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: P.latency, downloadThroughput: P.down, uploadThroughput: P.up });
    await page.route((u) => u.origin === BASE && !u.pathname.startsWith("/_next/") && !u.pathname.startsWith("/__cvx"), async (route) => {
      const r = route.request();
      if (r.isNavigationRequest() && r.resourceType() === "document") await sleep(P.latency);
      await route.continue();
    });
  }
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  // enter settings the way a user does: account menu → Settings
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("link", { name: "Settings" }).first().click();
  await page.waitForURL(/\/settings/, { timeout: 30000 });
  await page.getByText("Search settings").first().waitFor({ timeout: 30000 }).catch(() => {});
  await sleep(6000);

  const res = {};
  for (let r = 0; r < RUNS; r++) {
    for (const s of SECTIONS) {
      const link = page.getByRole("link", { name: s.label, exact: true }).first();
      await page.mouse.move(700, 400);
      await sleep(600);
      const t0 = now();
      const before = reqs.length;
      await link.click();
      await page.waitForURL((u) => u.pathname === s.href || u.pathname === "/en" + s.href, { timeout: 30000 });
      const tUrl = now() - t0;
      await page.getByRole("heading", { name: s.heading }).first().waitFor({ timeout: 30000 });
      const tHead = now() - t0;
      let tData = tHead;
      if (s.data) {
        // wait until the loading placeholder is gone (query landed)
        const t1 = Date.now();
        while (Date.now() - t1 < 30000) {
          const txt = await page.locator("main, body").first().innerText().catch(() => "");
          if (!s.data.test(txt)) break;
          await sleep(30);
        }
        tData = now() - t0;
      }
      const rscs = reqs.slice(before).filter((x) => /_rsc/.test(x.url)).length;
      const chunks = reqs.slice(before).filter((x) => /_next\/static/.test(x.url)).length;
      (res[s.label] ||= []).push({ url: tUrl, head: tHead, data: tData, rscs, chunks });
      console.log(`run ${r + 1} ${s.label.padEnd(15)} url=${Math.round(tUrl)} heading=${Math.round(tHead)} data=${Math.round(tData)} rsc=${rscs} chunks=${chunks}`);
      await sleep(800);
    }
  }
  await b.close();
  console.log(`\n== settings switching (${PROFILE}, N=${RUNS}) median ms: url / heading / data`);
  for (const [k, v] of Object.entries(res)) console.log(`  ${k.padEnd(15)} ${Math.round(pct(v.map((x) => x.url), .5))} / ${Math.round(pct(v.map((x) => x.head), .5))} / ${Math.round(pct(v.map((x) => x.data), .5))}   (rsc ${pct(v.map((x) => x.rscs), .5)}, chunks ${pct(v.map((x) => x.chunks), .5)})`);
  console.log(`console errors: ${errors.length}`);
})();
