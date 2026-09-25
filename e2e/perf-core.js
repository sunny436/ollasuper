// The latencies a user feels, measured in a real browser on the real network.
//
//   node perf-core.js <account.json> [runs=3]
//
// Wherever this machine is, that is the region measured — check it with
// https://app.ollasuper.com/cdn-cgi/trace (loc=, colo=). Each metric is timed
// from the user's action to the thing appearing on screen; data-arrival times
// come from the Convex WebSocket frames themselves (CDP), not from guesses.
//
//   initial load      Enter on /login → composer usable
//   chat list         hard reload of /chat → first conversation row painted
//   notifications     hard reload of /chat → the newest-page subscription answered
//   next page         rail's end scrolled into view → page-2 rows painted
//   search            last keystroke → results painted (includes the 200 ms debounce)
//   first token       Enter in the composer → first stream push carrying reply text
//   reply done        Enter → Stop button gone
const fs = require("node:fs");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const [FILE, RUNS_ARG] = process.argv.slice(2);
if (!FILE) {
  console.error("usage: node perf-core.js <account.json> [runs=3]");
  process.exit(2);
}
const ACCT = JSON.parse(fs.readFileSync(FILE, "utf8"));
const RUNS = Number(RUNS_ARG || 3);
const RAIL = 'nav[aria-label="Conversations"]';
const ROWS = `${RAIL} a[href^="/chat/"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

async function answerTimes(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  const names = new Map();
  const firstAnswer = new Map();
  const textPushes = []; // times of chat/stream:active pushes that carried reply text
  cdp.on("Network.webSocketCreated", () => { names.clear(); firstAnswer.clear(); });
  cdp.on("Network.webSocketFrameSent", (e) => {
    try {
      const m = JSON.parse(e.response.payloadData);
      if (m.type === "ModifyQuerySet") for (const x of m.modifications || []) if (x.type === "Add") names.set(x.queryId, x.udfPath);
    } catch {}
  });
  cdp.on("Network.webSocketFrameReceived", (e) => {
    try {
      const m = JSON.parse(e.response.payloadData || "");
      if (m.type !== "Transition") return;
      for (const x of m.modifications || []) {
        const p = names.get(x.queryId);
        if (p && !firstAnswer.has(p)) firstAnswer.set(p, Date.now());
        if (p === "chat/stream:active" && /"text":"[^"]/.test(JSON.stringify(x.value ?? null))) textPushes.push(Date.now());
      }
    } catch {}
  });
  const fn = (path) => firstAnswer.get(path);
  fn.firstTextAfter = (t) => textPushes.find((x) => x >= t);
  return fn;
}

(async () => {
  const trace = await (await fetch(`${BASE}/cdn-cgi/trace`)).text();
  const where = Object.fromEntries(trace.trim().split("\n").map((l) => l.split("=")));
  console.log(`perf-core · ${new Date().toISOString()} · measured from loc=${where.loc} (Cloudflare edge ${where.colo}) · N=${RUNS}`);
  const out = { initial: [], chatList: [], notifications: [], nextPage: [], search: [], firstToken: [], replyDone: [] };
  const browser = await chromium.launch({ headless: false });
  for (let run = 0; run < RUNS; run++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const answered = await answerTimes(ctx, page);

    await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => { const f = document.querySelector("form"); return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber")); }, null, { timeout: 30000 });
    await page.locator('input[type="email"]').first().fill(ACCT.email);
    await page.locator('input[type="password"]').first().fill(ACCT.password);
    let t = Date.now();
    await page.keyboard.press("Enter");
    await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
    out.initial.push(Date.now() - t);
    await sleep(2000);

    // Cold reload: the rail and the notification centre from nothing.
    t = Date.now();
    await page.reload({ waitUntil: "commit" });
    await page.locator(ROWS).first().waitFor({ timeout: 30000 });
    out.chatList.push(Date.now() - t);
    for (let i = 0; i < 40 && !answered("notifications:myNotifications"); i++) await sleep(100);
    if (answered("notifications:myNotifications")) out.notifications.push(answered("notifications:myNotifications") - t);
    await sleep(1500);

    // Next page of the rail.
    const before = await page.locator(ROWS).count();
    t = Date.now();
    await page.evaluate((rail) => {
      const s = document.querySelector(`${rail} div.h-px[aria-hidden="true"]`);
      s?.scrollIntoView({ block: "end" });
    }, RAIL);
    await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length > n, [ROWS, before], { timeout: 15000 })
      .catch(() => { throw new Error("next page: no new rows"); });
    out.nextPage.push(Date.now() - t);

    // Search.
    await page.locator(`${RAIL} button[aria-label="Search chats"]`).first().click();
    const box = page.locator('input[role="combobox"][aria-label="Search chats"]');
    await box.waitFor();
    await box.pressSequentially(`seed 0${run + 1}`, { delay: 30 });
    t = Date.now();
    // The RESULTS listbox, not "Recent chats" — that one is on screen until the
    // debounce fires and would make any wait pass instantly.
    await page.waitForFunction(
      () => !!document.querySelector('[role="listbox"][aria-label="Search results"] [role="option"]'),
      null,
      { timeout: 15000 },
    ).catch(() => { throw new Error("search: no results"); });
    out.search.push(Date.now() - t);
    await page.keyboard.press("Escape");
    await sleep(500);

    // A chat reply in an existing conversation. Hard signals only: the Stop
    // button appearing is the send accepted; the first stream push carrying
    // reply text is the first token; the Stop button leaving is done.
    await page.locator(ROWS).nth(run + 2).click();
    await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
    await sleep(1500);
    await page.locator("#chat-composer").click();
    await page.locator("#chat-composer").fill("Reply with one short sentence about the sea.");
    t = Date.now();
    await page.keyboard.press("Enter");
    const stop = page.locator('button[aria-label="Stop generating"]');
    await stop.waitFor({ timeout: 20000 }).catch(() => { throw new Error("chat: the send was not accepted"); });
    await stop.waitFor({ state: "detached", timeout: 180000 });
    out.replyDone.push(Date.now() - t);
    const first = answered.firstTextAfter(t);
    if (first) out.firstToken.push(first - t);
    await ctx.close();
    console.log(`  run ${run + 1}: ${JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v[v.length - 1]])))}`);
  }
  await browser.close();
  console.log("\nmedian ms:");
  for (const [k, v] of Object.entries(out)) console.log(`  ${k.padEnd(14)} ${v.length ? med(v) : "–"}   [${v.join(", ")}]`);
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
