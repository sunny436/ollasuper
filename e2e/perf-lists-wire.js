// What the chat list and the notification centre cost on the wire — measured,
// not estimated. Maps queryIds from the client's ModifyQuerySet frames to udf
// paths and attributes every Transition to them.
//
//   node perf-lists-wire.js <account.json> [label]
//
// Three scenarios, headed Chrome:
//   1. TURN  — one normal reply in an existing chat: every chat-list and
//              notification push, with its size and time after the send.
//   2. NAV   — chat → Scheduled → Projects → a chat → New chat, by clicking:
//              notification subscriptions added/removed and bytes per step.
//   3. PHONE — 390x844: chat-list first-page subscriptions on load, on opening
//              the drawer, on reopening it, and across a resize to desktop.
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const [FILE, LABEL = "run"] = process.argv.slice(2);
if (!FILE) {
  console.error("usage: node perf-lists-wire.js <account.json> [label]");
  process.exit(2);
}
const ACCT = JSON.parse(fs.readFileSync(FILE, "utf8"));
const OUT = process.env.OUT_DIR || path.join(__dirname, "out", "perf-lists-wire");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RAIL = 'nav[aria-label="Conversations"]';
const errors = [];

const LIST = "chat/threads:list";
const NOTIF = ["notifications:myNotifications", "notifications:unreadCount"];

/** Wire recorder for one page: adds/removes per path, pushes with bytes. */
async function recorder(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  const names = new Map();
  const ev = [];
  cdp.on("Network.webSocketFrameSent", (e) => {
    try {
      const m = JSON.parse(e.response.payloadData);
      if (m.type !== "ModifyQuerySet") return;
      for (const mod of m.modifications || []) {
        if (mod.type === "Add") {
          names.set(mod.queryId, mod.udfPath);
          ev.push({ t: Date.now(), kind: "add", path: mod.udfPath, args: mod.args?.[0] ?? {} });
        } else if (mod.type === "Remove") {
          ev.push({ t: Date.now(), kind: "remove", path: names.get(mod.queryId) || `q${mod.queryId}` });
        }
      }
    } catch {}
  });
  cdp.on("Network.webSocketFrameReceived", (e) => {
    try {
      const m = JSON.parse(e.response.payloadData || "");
      if (m.type !== "Transition") return;
      for (const mod of m.modifications || []) {
        if (mod.type !== "QueryUpdated") continue;
        const p = names.get(mod.queryId) || `q${mod.queryId}`;
        ev.push({ t: Date.now(), kind: "push", path: p, bytes: JSON.stringify(mod.value ?? null).length });
      }
    } catch {}
  });
  const pick = (t0, t1, fn) => ev.filter((x) => x.t >= t0 && x.t <= t1 && fn(x));
  return {
    ev,
    pushes: (t0, t1, p) => pick(t0, t1, (x) => x.kind === "push" && x.path === p),
    adds: (t0, t1, p, argFn = () => true) => pick(t0, t1, (x) => x.kind === "add" && x.path === p && argFn(x.args)),
    removes: (t0, t1, p) => pick(t0, t1, (x) => x.kind === "remove" && x.path === p),
  };
}

async function signIn(page) {
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const f = document.querySelector("form");
      return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber"));
    },
    null,
    { timeout: 30000 },
  );
  await page.locator('input[type="email"]').first().fill(ACCT.email);
  await page.locator('input[type="password"]').first().fill(ACCT.password);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
}

const sum = (xs) => xs.reduce((a, x) => a + (x.bytes || 0), 0);

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  const rec = await recorder(ctx, page);
  await signIn(page);
  await page.locator(`${RAIL} a[href^="/chat/"]`).first().waitFor({ timeout: 30000 });
  await sleep(2500);
  const result = { label: LABEL, at: new Date().toISOString() };

  // ── 1. TURN ─────────────────────────────────────────────────────────────
  const thread = page.locator(`${RAIL} a[href^="/chat/"]`).nth(3);
  const href = await thread.getAttribute("href");
  await thread.click();
  await page.waitForURL((u) => u.pathname.endsWith(href), { timeout: 15000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  await sleep(2500);
  await page.locator("#chat-composer").fill("Reply with one short sentence about tea.");
  const tSend = Date.now();
  await page.keyboard.press("Enter");
  await page.locator('button[aria-label="Stop generating"]').waitFor({ timeout: 20000 }).catch(() => {});
  await page.locator('button[aria-label="Stop generating"]').waitFor({ state: "detached", timeout: 90000 }).catch(() => {});
  const tDone = Date.now();
  await sleep(12000); // title / summary / suggestion writes land after the reply
  const tEnd = Date.now();
  const listPushes = rec.pushes(tSend, tEnd, LIST);
  const notifPushes = NOTIF.flatMap((p) => rec.pushes(tSend, tEnd, p));
  result.turn = {
    replyMs: tDone - tSend,
    list: { pushes: listPushes.length, bytes: sum(listPushes), each: listPushes.map((x) => ({ atMs: x.t - tSend, bytes: x.bytes })) },
    notifications: { pushes: notifPushes.length, bytes: sum(notifPushes), each: notifPushes.map((x) => ({ path: x.path.split(":")[1], atMs: x.t - tSend, bytes: x.bytes })) },
  };
  console.log(`\n[turn] reply ${result.turn.replyMs} ms`);
  console.log(`  chat list:     ${listPushes.length} push(es), ${sum(listPushes)} B  ${JSON.stringify(result.turn.list.each)}`);
  console.log(`  notifications: ${notifPushes.length} push(es), ${sum(notifPushes)} B`);

  // ── 1b. TURN 2 — the steady state: a second reply in the SAME chat, so no
  // first-message naming and no auto-title; only real per-turn changes remain.
  await page.locator("#chat-composer").fill("And one more short sentence about tea.");
  const tSend2 = Date.now();
  await page.keyboard.press("Enter");
  await page.locator('button[aria-label="Stop generating"]').waitFor({ timeout: 20000 }).catch(() => {});
  await page.locator('button[aria-label="Stop generating"]').waitFor({ state: "detached", timeout: 90000 }).catch(() => {});
  const tDone2 = Date.now();
  await sleep(12000);
  const tEnd2 = Date.now();
  const list2 = rec.pushes(tSend2, tEnd2, LIST);
  const stream2 = rec.pushes(tSend2, tEnd2, "chat/threads:streaming");
  result.turn2 = {
    replyMs: tDone2 - tSend2,
    list: { pushes: list2.length, bytes: sum(list2), each: list2.map((x) => ({ atMs: x.t - tSend2, bytes: x.bytes })) },
    streamingDot: { pushes: stream2.length, bytes: sum(stream2) },
  };
  console.log(`[turn 2, same chat] reply ${result.turn2.replyMs} ms`);
  console.log(`  chat list:     ${list2.length} push(es), ${sum(list2)} B  ${JSON.stringify(result.turn2.list.each)}`);
  console.log(`  streaming dot: ${stream2.length} push(es), ${sum(stream2)} B`);

  // ── 2. NAV ──────────────────────────────────────────────────────────────
  const steps = [
    ["→ Scheduled", async () => { await page.locator(`${RAIL} a[href="/scheduled"]`).first().click(); await page.waitForURL(/\/scheduled/, { timeout: 15000 }); }],
    ["→ Projects", async () => { await page.locator(`${RAIL} a[href="/projects"]`).first().click(); await page.waitForURL(/\/projects/, { timeout: 15000 }); }],
    ["→ a chat", async () => { await page.locator(`${RAIL} a[href^="/chat/"]`).nth(5).click(); await page.waitForURL(/\/chat\/[a-z0-9]+/, { timeout: 15000 }); }],
    ["→ another chat", async () => { await page.locator(`${RAIL} a[href^="/chat/"]`).nth(6).click(); await sleep(300); }],
    ["→ New chat", async () => { await page.getByRole("button", { name: "New chat" }).first().click(); await page.waitForURL((u) => /\/chat\/?$/.test(u.pathname), { timeout: 15000 }); }],
  ];
  result.nav = [];
  console.log("\n[nav]");
  for (const [name, go] of steps) {
    const t0 = Date.now();
    await go();
    await sleep(3000);
    const t1 = Date.now();
    const row = {
      step: name,
      notifAdds: NOTIF.reduce((n, p) => n + rec.adds(t0, t1, p).length, 0),
      notifRemoves: NOTIF.reduce((n, p) => n + rec.removes(t0, t1, p).length, 0),
      notifBytes: NOTIF.reduce((n, p) => n + sum(rec.pushes(t0, t1, p)), 0),
      listAdds: rec.adds(t0, t1, LIST).length,
      listBytes: sum(rec.pushes(t0, t1, LIST)),
    };
    result.nav.push(row);
    console.log(`  ${name.padEnd(16)} notifications: +${row.notifAdds} −${row.notifRemoves} ${row.notifBytes} B | chat list: +${row.listAdds} ${row.listBytes} B`);
  }

  // ── 3. PHONE ────────────────────────────────────────────────────────────
  const state = await ctx.storageState();
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: state });
  const m = await mctx.newPage();
  m.on("console", (x) => { if (x.type() === "error") errors.push(x.text().slice(0, 160)); });
  const mrec = await recorder(mctx, m);
  const railFirst = (a) => a.unassignedOnly === true && (a.paginationOpts?.cursor ?? null) === null;
  const t0 = Date.now();
  await m.goto(BASE + "/chat", { waitUntil: "domcontentloaded" });
  await m.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  await sleep(3000);
  const onLoad = mrec.adds(t0, Date.now(), LIST, railFirst).length;
  const t1 = Date.now();
  await m.locator('button[aria-label="Open conversations"]:visible').first().click();
  await m.locator(`${RAIL} a[href^="/chat/"]:visible`).first().waitFor({ timeout: 15000 });
  await sleep(2000);
  const onOpen = mrec.adds(t1, Date.now(), LIST, railFirst).length;
  await m.keyboard.press("Escape");
  await sleep(800);
  const t2 = Date.now();
  await m.locator('button[aria-label="Open conversations"]:visible').first().click();
  await m.locator(`${RAIL} a[href^="/chat/"]:visible`).first().waitFor({ timeout: 15000 });
  await sleep(2000);
  const onReopen = mrec.adds(t2, Date.now(), LIST, railFirst).length;
  await m.keyboard.press("Escape");
  await sleep(500);
  const t3 = Date.now();
  await m.setViewportSize({ width: 1280, height: 800 });
  await sleep(1500);
  await m.setViewportSize({ width: 390, height: 844 });
  await sleep(1500);
  const onResize = mrec.adds(t3, Date.now(), LIST, railFirst).length;
  const live = await m.evaluate((rail) => {
    const navs = [...document.querySelectorAll(rail)];
    return { navs: navs.length, visible: navs.filter((n) => n.getClientRects().length).length };
  }, RAIL);
  result.phone = { firstPageAdds: { onLoad, onOpen, onReopen, onResize }, total: onLoad + onOpen + onReopen + onResize, railNavsInDom: live.navs };
  console.log(`\n[phone] chat-list first-page subscriptions — load ${onLoad}, open drawer ${onOpen}, reopen ${onReopen}, resize ${onResize} (total ${result.phone.total}); rail <nav>s in DOM: ${live.navs}`);

  await browser.close();
  result.consoleErrors = errors.length;
  const file = path.join(OUT, `${LABEL}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  for (const e of errors.slice(0, 5)) console.log("CONSOLE", e);
  console.log(`\nsaved ${file} | console errors: ${errors.length}`);
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
