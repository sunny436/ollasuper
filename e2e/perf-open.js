// Thread-open micro-benchmark: the same thread, opened from /chat, hovered
// (intent prefetch) vs not hovered, alternating, under a profile of
// perf-india.js. Rows are counted only if they are NEW nodes (the App Router
// can commit the URL while the previous segment is still on screen).
//
//   node perf-open.js --profile india --runs 10
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const { email: EMAIL, password: PASSWORD } = require("./creds").account();
const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i === -1 ? d : process.argv[i + 1];
};
const PROFILE = arg("profile", "india");
const RUNS = Number(arg("runs", 10));
const mbps = (n) => (n * 1e6) / 8;
const P = { us: null, india: { latency: 260, down: mbps(20), up: mbps(8) }, "india-poor": { latency: 400, down: mbps(4), up: mbps(1) } }[PROFILE];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round((s.length - 1) * p))]; };
const ROW = '[aria-label="Conversation"] .group.my-5';

function delayQueue(oneWayMs, bytesPerSec, send) {
  const q = []; let due = 0; let draining = false;
  const drain = async () => { if (draining) return; draining = true; while (q.length) { const h = q[0]; const w = h.at - Date.now(); if (w > 0) await sleep(w); q.shift(); try { send(h.msg); } catch {} } draining = false; };
  return (msg) => { const bytes = typeof msg === "string" ? msg.length : msg.byteLength ?? 0; const at = Math.max(Date.now() + oneWayMs + (bytes / bytesPerSec) * 1000, due); due = at; q.push({ msg, at }); void drain(); };
}

(async () => {
  const b = await chromium.launch({ headless: false });
  const ctx = await b.newContext({ viewport: { width: 1360, height: 860 } });
  const wsIn = [];
  if (P) {
    await ctx.routeWebSocket(/\/__cvx\//, (ws) => {
      const server = ws.connectToServer();
      const up = delayQueue(P.latency / 2, P.up, (m) => server.send(m));
      const down = delayQueue(P.latency / 2, P.down, (m) => ws.send(m));
      ws.onMessage((m) => up(m));
      server.onMessage((m) => { wsIn.push({ t: now(), bytes: typeof m === "string" ? m.length : 0 }); down(m); });
      ws.onClose((c, r) => server.close({ code: c, reason: r }));
      server.onClose((c, r) => ws.close({ code: c, reason: r }));
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  if (P) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: P.latency, downloadThroughput: P.down, uploadThroughput: P.up });
  }
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  const links = page.locator('a[href^="/chat/"]').filter({ hasNotText: /^New chat$/ });
  await links.nth(1).waitFor({ timeout: 30000 });
  const href = await links.nth(1).getAttribute("href");
  const res = { hover: [], nohover: [], hoverBeforeWs: 0 };
  for (let i = 0; i < RUNS * 2; i++) {
    const hover = i % 2 === 0;
    // start from /chat every time, with the prefetch's 20 s TTL expired
    await page.getByRole("button", { name: "New chat" }).click();
    await page.waitForURL(/\/chat\/?$/, { timeout: 15000 }).catch(() => {});
    await page.mouse.move(700, 400);
    await sleep(hover ? 21000 : 3000);
    const link = page.locator(`a[href="${href}"]`).first();
    if (hover) { await link.hover(); await sleep(1200); }
    await page.evaluate((sel) => { for (const el of document.querySelectorAll(sel)) el.setAttribute("data-perf-old", "1"); }, ROW);
    const t0 = now();
    if (hover) await link.click(); else await page.evaluate((h) => document.querySelector(`a[href="${h}"]`).click(), href);
    await page.waitForURL((u) => u.pathname === href, { timeout: 30000 });
    const tUrl = now() - t0;
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel}:not([data-perf-old])`).length > 0, ROW, { polling: "raf", timeout: 30000 });
    const tRow = now() - t0;
    const big = wsIn.find((f) => f.t >= t0 && f.bytes >= 2000);
    const beforeWs = !big || tRow < big.t - t0 + (P ? P.latency / 2 : 0);
    if (hover && beforeWs) res.hoverBeforeWs++;
    res[hover ? "hover" : "nohover"].push(tRow);
    console.log(`${hover ? "hover  " : "nohover"} url=${Math.round(tUrl)} row=${Math.round(tRow)} ${hover ? (beforeWs ? "(seed)" : "(ws)") : ""}`);
    await sleep(1500);
  }
  await b.close();
  console.log(`\n== thread open (${PROFILE}, same thread, from /chat, N=${RUNS} each)`);
  console.log(`hovered   : median ${Math.round(pct(res.hover, 0.5))} ms  p90 ${Math.round(pct(res.hover, 0.9))} ms  painted from seed in ${res.hoverBeforeWs}/${RUNS}`);
  console.log(`not hovered: median ${Math.round(pct(res.nohover, 0.5))} ms  p90 ${Math.round(pct(res.nohover, 0.9))} ms`);
  console.log(`console errors: ${errors.length}`);
})();
