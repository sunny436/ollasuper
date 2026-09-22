// One thread open, fully traced: WebSocket frames (query set changes and
// transitions, by udf path), the RSC request, the URL commit and the first
// painted row — relative to the click. `--hover` dwells 350 ms first.
//
//   node perf-probe-open.js --profile india [--hover] [--idx 4]
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const { email: EMAIL, password: PASSWORD } = require("./creds").account();
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i === -1 ? d : process.argv[i + 1]; };
const PROFILE = arg("profile", "india");
const HOVER = process.argv.includes("--hover");
const IDX = Number(arg("idx", 4));
const mbps = (n) => (n * 1e6) / 8;
const P = { us: null, india: { latency: 260, down: mbps(20), up: mbps(8) } }[PROFILE];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const ROW = '[aria-label="Conversation"] .group.my-5';
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
      ws.onMessage((m) => up(m)); server.onMessage((m) => down(m));
      ws.onClose((c, r) => server.close({ code: c, reason: r })); server.onClose((c, r) => ws.close({ code: c, reason: r }));
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  if (P) await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: P.latency, downloadThroughput: P.down, uploadThroughput: P.up });
  const names = new Map();
  const log = [];
  let t0 = null;
  const rel = () => (t0 === null ? null : Math.round(now() - t0));
  cdp.on("Network.webSocketFrameSent", (e) => {
    try { const m = JSON.parse(e.response.payloadData); if (m.type === "ModifyQuerySet") { const mods = (m.modifications || []).map((x) => { if (x.type === "Add") names.set(x.queryId, x.udfPath); return `${x.type}:${x.type === "Add" ? x.udfPath : names.get(x.queryId) || x.queryId}`; }); if (t0 !== null) log.push(`${rel()} ws→ ModifyQuerySet ${mods.join(", ")}`); } } catch {}
  });
  cdp.on("Network.webSocketFrameReceived", (e) => {
    try { const m = JSON.parse(e.response.payloadData); if (m.type === "Transition" && t0 !== null) log.push(`${rel()} ws← Transition ${(m.modifications || []).map((x) => `${names.get(x.queryId) || x.queryId}(${JSON.stringify(x.value ?? "").length}B)`).join(", ")}`); } catch {}
  });
  page.on("request", (r) => { if (t0 !== null && /_rsc=|chunks/.test(r.url())) log.push(`${rel()} http ${r.url().replace(BASE, "").replace(/^\/_next\/static\/chunks\//, "chunk:").slice(0, 80)}`); });
  page.on("framenavigated", (f) => { if (f === page.mainFrame() && t0 !== null) log.push(`${rel()} URL ${new URL(f.url()).pathname}`); });

  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const f = document.querySelector("form"); return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber")); }, null, { timeout: 30000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  await sleep(5000);
  const links = page.locator('nav[aria-label="Conversations"] a[href^="/chat/"]').filter({ hasNotText: /^New chat$/ });
  if (process.argv.includes("--warm")) { // a first open, so the session's one-time chunks are cached
    await links.nth(1).click(); await page.waitForFunction((sel) => document.querySelectorAll(sel).length >= 1, ROW, { timeout: 30000 }); await sleep(3000);
  }
  const href = await links.nth(IDX).getAttribute("href");
  await page.mouse.move(700, 430); await sleep(500);
  await page.evaluate((sel) => { for (const el of document.querySelectorAll(sel)) el.setAttribute("data-perf-old", "1"); }, ROW);
  if (HOVER) { await links.nth(IDX).hover(); t0 = now(); log.push("0 hover"); await sleep(350); log.push(`${rel()} click`); await links.nth(IDX).click(); }
  else { t0 = now(); log.push("0 click (no hover)"); await page.evaluate((h) => document.querySelector(`a[href="${h}"]`).click(), href); }
  await page.waitForFunction((sel) => document.querySelectorAll(`${sel}:not([data-perf-old])`).length >= 1, ROW, { timeout: 30000, polling: "raf" });
  log.push(`${rel()} FIRST ROW`);
  await sleep(1500);
  console.log(log.join("\n"));
  console.log(`console errors: ${errors.length}`);
  await b.close();
})();
