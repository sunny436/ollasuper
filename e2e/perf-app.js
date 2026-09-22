// Whole-app journey: every surface a signed-in user moves between, measured as
// click → URL committed → content painted → data landed, with the RSC round
// trips, JS chunks and WebSocket bytes each step cost. Headed Chrome, QA
// account, zero console errors. Profiles as in perf-india.js (us / india /
// india-poor): RTT on HTTP (CDP), on the Convex WebSocket (strict-FIFO delay
// queue) and on document navigations (route delay).
//
//   node perf-app.js --profile india --runs 3 --label before
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const { email: EMAIL, password: PASSWORD } = require("./creds").account();
const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i === -1 ? d : process.argv[i + 1];
};
const PROFILE = arg("profile", "india");
const RUNS = Number(arg("runs", 3));
const LABEL = arg("label", "run");
const mbps = (n) => (n * 1e6) / 8;
const PROFILES = {
  us: null,
  india: { latency: 260, down: mbps(20), up: mbps(8), geo: { latitude: 19.076, longitude: 72.8777, accuracy: 50 }, tz: "Asia/Kolkata", locale: "en-IN" },
  "india-poor": { latency: 400, down: mbps(4), up: mbps(1), geo: { latitude: 28.6139, longitude: 77.209, accuracy: 50 }, tz: "Asia/Kolkata", locale: "en-IN" },
};
const P = PROFILES[PROFILE];
if (P === undefined) { console.error("unknown --profile"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.round((s.length - 1) * p))] : NaN; };

const CONVO = '[aria-label="Conversation"]';
const ROW = `${CONVO} .group.my-5`;

function delayQueue(oneWayMs, bytesPerSec, send) {
  const q = []; let due = 0; let draining = false;
  const drain = async () => { if (draining) return; draining = true; while (q.length) { const h = q[0]; const w = h.at - Date.now(); if (w > 0) await sleep(w); q.shift(); try { send(h.msg); } catch {} } draining = false; };
  return (msg) => { const bytes = typeof msg === "string" ? msg.length : msg.byteLength ?? 0; const at = Math.max(Date.now() + oneWayMs + (bytes / bytesPerSec) * 1000, due); due = at; q.push({ msg, at }); void drain(); };
}

(async () => {
  const b = await chromium.launch({ headless: false });
  const ctx = await b.newContext({
    viewport: { width: 1360, height: 860 },
    ...(P ? { locale: P.locale, timezoneId: P.tz, geolocation: P.geo, permissions: ["geolocation"] } : {}),
  });
  let wsIn = 0; // bytes received on the Convex socket (server → browser)
  if (P) {
    await ctx.routeWebSocket(/\/__cvx\//, (ws) => {
      const server = ws.connectToServer();
      const up = delayQueue(P.latency / 2, P.up, (m) => server.send(m));
      const down = delayQueue(P.latency / 2, P.down, (m) => ws.send(m));
      ws.onMessage((m) => up(m));
      server.onMessage((m) => { wsIn += typeof m === "string" ? m.length : m.byteLength ?? 0; down(m); });
      ws.onClose((c, r) => server.close({ code: c, reason: r }));
      server.onClose((c, r) => ws.close({ code: c, reason: r }));
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e).slice(0, 200)));
  const reqs = [];
  page.on("request", (r) => reqs.push({ t: now(), url: r.url().replace(BASE, ""), type: r.resourceType() }));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  // main-thread attribution: deltas of Chrome's cumulative durations (seconds)
  const perfNow = async () => { const { metrics } = await cdp.send("Performance.getMetrics"); const m = Object.fromEntries(metrics.map((x) => [x.name, x.value])); return { script: m.ScriptDuration, layout: m.LayoutDuration, style: m.RecalcStyleDuration, task: m.TaskDuration, nodes: m.Nodes }; };
  if (!P) cdp.on("Network.webSocketFrameReceived", (e) => { wsIn += (e.response.payloadData || "").length; });
  if (P) {
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: P.latency, downloadThroughput: P.down, uploadThroughput: P.up });
    await page.route((u) => u.origin === BASE && !u.pathname.startsWith("/_next/") && !u.pathname.startsWith("/__cvx"), async (route) => {
      const r = route.request();
      if (r.isNavigationRequest() && r.resourceType() === "document") await sleep(P.latency);
      await route.continue();
    });
  }

  const results = {}; // step → [{url, paint, data, rsc, chunks, ws}]
  const record = (step, m) => { (results[step] ||= []).push(m); console.log(`  ${step.padEnd(18)} url=${Math.round(m.url)} paint=${Math.round(m.paint)} data=${Math.round(m.data)} rsc=${m.rsc} chunks=${m.chunks} ws=${(m.ws / 1024).toFixed(1)}K${m.cpu ? ` cpu(script ${m.cpu.script} layout ${m.cpu.layout} style ${m.cpu.style} task ${m.cpu.task} nodes ${m.cpu.nodes})` : ""}`); };

  const markOld = () => page.evaluate((sel) => { for (const el of document.querySelectorAll(sel)) el.setAttribute("data-perf-old", "1"); }, ROW);
  const waitRows = (n) => page.waitForFunction(([sel, k]) => document.querySelectorAll(`${sel}:not([data-perf-old])`).length >= k, [ROW, n], { timeout: 30000, polling: "raf" });
  const noPulse = async () => { const t = Date.now(); while (Date.now() - t < 30000) { const n = await page.locator("main .animate-pulse, #workspace-main .animate-pulse, [aria-label='Loading connectors']").count(); if (n === 0) return; await sleep(30); } };
  const noText = async (re) => { const t = Date.now(); while (Date.now() - t < 30000) { const txt = await page.locator("main, #workspace-main, body").first().innerText().catch(() => ""); if (!re.test(txt)) return; await sleep(30); } };
  const composer = () => page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });

  /**
   * One navigation step. `go` performs the click; `url` matches the committed
   * pathname; `paint` waits for the new segment's first meaningful node;
   * `data` waits for its queries (optional).
   */
  async function step(name, { pre, go, url, paint, data }) {
    await page.mouse.move(700, 430);
    await sleep(500);
    if (pre) await pre();
    const before = reqs.length; const ws0 = wsIn; const pm0 = await perfNow();
    const t0 = now();
    await go();
    await page.waitForURL((u) => url(u.pathname.replace(/^\/en(?=\/|$)/, "")), { timeout: 30000 });
    const tUrl = now() - t0;
    await paint();
    const tPaint = now() - t0;
    if (data) await data();
    const tData = now() - t0;
    await sleep(700); // let trailing requests land before counting
    const pm1 = await perfNow();
    const cpu = { script: Math.round((pm1.script - pm0.script) * 1000), layout: Math.round((pm1.layout - pm0.layout) * 1000), style: Math.round((pm1.style - pm0.style) * 1000), task: Math.round((pm1.task - pm0.task) * 1000), nodes: pm1.nodes };
    const slice = reqs.slice(before);
    record(name, { url: tUrl, paint: tPaint, data: tData, rsc: slice.filter((x) => /_rsc=/.test(x.url)).length, chunks: slice.filter((x) => /_next\/static\/chunks/.test(x.url)).length, ws: wsIn - ws0, cpu, timeline: slice.map((x) => `${Math.round(x.t - t0)} ${x.url.replace(/^\/_next\/static\/chunks\//, "chunk:").slice(0, 90)}`) });
  }

  // ---- login (cold) ------------------------------------------------------
  {
    const t0 = now(); const before = reqs.length;
    await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
    const dcl = now() - t0;
    await page.locator('input[type="email"]').first().waitFor({ timeout: 30000 });
    const form = now() - t0;
    // Type only once React has attached its handlers: before that, Enter is a
    // native (GET) submit of the form — not the sign-in a user gets.
    await page.waitForFunction(() => { const f = document.querySelector("form"); return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber")); }, null, { timeout: 30000 });
    const hydrated = now() - t0;
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    const t1 = now(); const ws0 = wsIn; const b1 = reqs.length;
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat/, { timeout: 30000 });
    const url = now() - t1;
    await composer();
    const comp = now() - t1;
    await page.locator('a[href^="/chat/"]').first().waitFor({ timeout: 30000 });
    const rail = now() - t1;
    await sleep(700);
    record("login-page", { url: dcl, paint: form, data: hydrated, rsc: 0, chunks: reqs.slice(before, b1).filter((x) => /_next\/static\/chunks/.test(x.url)).length, ws: 0 });
    record("signin", { url, paint: comp, data: rail, rsc: reqs.slice(b1).filter((x) => /_rsc=/.test(x.url)).length, chunks: reqs.slice(b1).filter((x) => /_next\/static\/chunks/.test(x.url)).length, ws: wsIn - ws0, timeline: reqs.slice(b1).map((x) => `${Math.round(x.t - t1)} ${x.url.replace(/^\/_next\/static\/chunks\//, "chunk:").slice(0, 90)}`) });
  }
  await sleep(4000);

  const threadLinks = () => page.locator('nav[aria-label="Conversations"] a[href^="/chat/"]').filter({ hasNotText: /^New chat$/ });
  const acctMenu = async () => { await page.getByRole("button", { name: "Account menu" }).click(); await page.getByRole("link", { name: "Settings" }).first().hover(); await sleep(400); };

  for (let r = 0; r < RUNS; r++) {
    console.log(`run ${r + 1}/${RUNS}`);
    // thread open, hovered (real users dwell ~300 ms before the click)
    const links = threadLinks();
    const idx = [1 + (r % 3), 4 + (r % 3)];
    for (const [name, i, dwell] of [["thread-hover", idx[0], 350], ["thread-nohover", idx[1], 0]]) {
      const href = await links.nth(i).getAttribute("href");
      await markOld();
      await step(name, {
        pre: async () => { if (dwell) { await links.nth(i).hover(); await sleep(dwell); } },
        go: () => links.nth(i).click(),
        url: (p) => p === href,
        paint: () => waitRows(1),
      });
    }
    await step("new-chat", { go: () => page.getByRole("button", { name: "New chat" }).click(), url: (p) => p === "/chat", paint: composer });
    await step("projects", { go: () => page.getByRole("link", { name: "Projects", exact: true }).click(), url: (p) => p === "/projects", paint: () => page.getByRole("heading", { name: "Projects" }).first().waitFor({ timeout: 30000 }), data: noPulse });
    const proj = page.locator('a[href^="/projects/"]').first();
    if (await proj.count()) {
      const phref = await proj.getAttribute("href");
      await step("project-open", { pre: async () => { await proj.hover(); await sleep(350); }, go: () => proj.click(), url: (p) => p === phref, paint: () => noText(/Loading…/), data: noPulse });
      await step("project-back", { go: () => page.getByRole("link", { name: /Projects/ }).first().click(), url: (p) => p === "/projects", paint: () => page.getByRole("heading", { name: "Projects" }).first().waitFor({ timeout: 30000 }), data: noPulse });
    }
    await step("scheduled", { go: () => page.getByRole("link", { name: "Scheduled", exact: true }).click(), url: (p) => p === "/scheduled", paint: () => page.getByRole("heading", { name: /Scheduled/ }).first().waitFor({ timeout: 30000 }), data: noPulse });
    await step("back-to-chat", { go: () => page.getByRole("button", { name: "New chat" }).click(), url: (p) => p === "/chat", paint: composer });
    await step("settings", { pre: acctMenu, go: () => page.getByRole("link", { name: "Settings" }).first().click(), url: (p) => p === "/settings", paint: () => page.getByRole("heading", { name: "Profile" }).first().waitFor({ timeout: 30000 }), data: () => noText(/Loading/) });
    await step("settings-files", { go: () => page.getByRole("link", { name: "Files", exact: true }).first().click(), url: (p) => p === "/settings/files", paint: () => page.getByRole("heading", { name: "Files" }).first().waitFor({ timeout: 30000 }), data: () => noText(/Loading…/) });
    await step("connectors", { go: () => page.getByRole("link", { name: "Connectors", exact: true }).first().click(), url: (p) => p === "/settings/connectors", paint: () => page.getByRole("heading", { name: /Connectors/ }).first().waitFor({ timeout: 30000 }), data: noPulse });
    await step("personalization", { go: () => page.getByRole("link", { name: "Personalization", exact: true }).first().click(), url: (p) => p === "/settings/personalization", paint: () => page.getByRole("heading", { name: /Personalization/ }).first().waitFor({ timeout: 30000 }), data: () => noText(/Loading your preferences/) });
    await step("settings-close", { go: () => page.locator('a[href="/chat"]').first().click(), url: (p) => p === "/chat", paint: composer });
    await sleep(1500);
    await step("billing", { pre: acctMenu, go: () => page.getByRole("link", { name: "Billing" }).first().click(), url: (p) => p === "/settings/billing", paint: () => page.getByRole("heading", { name: "Plan" }).first().waitFor({ timeout: 30000 }), data: () => noText(/Loading/) });
    await step("billing-close", { go: () => page.locator('a[href="/chat"]').first().click(), url: (p) => p === "/chat", paint: composer });
    await sleep(1500);
  }

  await b.close();
  console.log(`\n== whole-app (${PROFILE}, N=${RUNS}) median ms: url / paint / data   [rsc, chunks, ws KB]`);
  const summary = {};
  for (const [k, v] of Object.entries(results)) {
    const m = { url: pct(v.map((x) => x.url), .5), paint: pct(v.map((x) => x.paint), .5), data: pct(v.map((x) => x.data), .5), p90: pct(v.map((x) => x.data), .9), rsc: pct(v.map((x) => x.rsc), .5), chunks: pct(v.map((x) => x.chunks), .5), ws: pct(v.map((x) => x.ws), .5), script: pct(v.map((x) => x.cpu?.script ?? 0), .5), task: pct(v.map((x) => x.cpu?.task ?? 0), .5) };
    summary[k] = { ...m, samples: v };
    console.log(`  ${k.padEnd(18)} ${String(Math.round(m.url)).padStart(5)} / ${String(Math.round(m.paint)).padStart(5)} / ${String(Math.round(m.data)).padStart(5)}  p90 ${String(Math.round(m.p90)).padStart(5)}   [${m.rsc}, ${m.chunks}, ${(m.ws / 1024).toFixed(1)}]  cpu script ${Math.round(m.script)} task ${Math.round(m.task)}`);
  }
  console.log(`console errors: ${errors.length}`);
  for (const e of errors.slice(0, 8)) console.log("  ", e);
  fs.mkdirSync(path.join(__dirname, ".perf"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, ".perf", `app-${LABEL}-${PROFILE}.json`), JSON.stringify({ profile: PROFILE, runs: RUNS, at: new Date().toISOString(), summary, errors }, null, 2));
})();
