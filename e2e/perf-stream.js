// Streaming wire cost: WebSocket bytes for ONE long answer, plus the
// mid-stream reload path (a second subscriber that must fetch the compacted
// prefix). Headed Chrome, QA account, zero console errors.
//
//   node perf-stream.js --runs 3
//
// Prints per run: answer length, WS bytes received during the turn, the
// largest single frame, frames ≥ 4 KB, and whether a reload mid-stream shows
// the text already streamed (not a blank row) and ends with the full answer.
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const { email: EMAIL, password: PASSWORD } = require("./creds").account();
const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i === -1 ? d : process.argv[i + 1];
};
const RUNS = Number(arg("runs", 3));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROW = '[aria-label="Conversation"] .group.my-5';
const PROMPT =
  "Write a detailed 700-word essay about the history of the Indian railways, in plain prose paragraphs, no headings, no lists.";

async function lastAssistantText(page) {
  return page.evaluate((sel) => {
    const rows = [...document.querySelectorAll(sel)].filter((r) => !r.classList.contains("items-end"));
    const last = rows[rows.length - 1];
    return last ? last.innerText.trim().split(/\r?\n/).slice(2).join("\n").trim() : "";
  }, ROW);
}
async function settle(page, timeout = 240000) {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await stop.count()) === 0) return true;
    await sleep(200);
  }
  return false;
}

(async () => {
  const b = await chromium.launch({ headless: false });
  const ctx = await b.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  const frames = [];
  cdp.on("Network.webSocketFrameReceived", (e) => frames.push({ t: performance.now(), bytes: (e.response.payloadData || "").length }));

  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });

  const results = [];
  for (let i = 1; i <= RUNS; i++) {
    await page.getByRole("button", { name: "New chat" }).click();
    await page.waitForURL(/\/chat\/?$/, { timeout: 15000 }).catch(() => {});
    await page.locator("#chat-composer").fill(PROMPT);
    const t0 = performance.now();
    frames.length = 0;
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 30000 });
    const href = new URL(page.url()).pathname;
    await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 90000 }).catch(async () => { console.log("DEBUG no Stop within 90 s; rows:", await page.locator(ROW).count()); await page.screenshot({ path: ".perf/stream-nostop.png" }); throw new Error("no stop"); });
    // Let the stream run for a while, then reload mid-stream (a fresh
    // subscriber that must fetch the compacted prefix, if any).
    // wait until the answer is genuinely mid-stream (>= 300 chars), max 60 s
    let before = 0;
    const tW = Date.now();
    while (Date.now() - tW < 60000) {
      before = (await lastAssistantText(page)).length;
      if (before >= 300) break;
      if ((await page.getByRole("button", { name: "Stop generating" }).count()) === 0) break;
      await sleep(250);
    }
    const bytesBeforeReload = frames.reduce((s, f) => s + f.bytes, 0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#chat-composer").waitFor({ timeout: 30000 });
    // The re-mounted subscriber must show the text streamed so far promptly.
    let shownAfterReload = 0;
    const tR = Date.now();
    while (Date.now() - tR < 15000) {
      shownAfterReload = (await lastAssistantText(page)).length;
      if (shownAfterReload >= Math.min(before, 200)) break;
      await sleep(200);
    }
    const reloadPaintMs = Date.now() - tR;
    if (!(await settle(page))) throw new Error("did not finish");
    await sleep(1500);
    const final = await lastAssistantText(page);
    if (final.length < 50) { const raw = await page.locator(ROW).last().innerText().catch(() => ""); console.log("DEBUG last row:", JSON.stringify(raw.slice(0, 300)), "rows:", await page.locator(ROW).count()); await page.screenshot({ path: ".perf/stream-debug.png" }); }
    const total = frames.reduce((s, f) => s + f.bytes, 0);
    const biggest = Math.max(0, ...frames.map((f) => f.bytes));
    const big = frames.filter((f) => f.bytes >= 4096).length;
    const r = {
      run: i,
      answer_chars: final.length,
      ws_bytes_turn: total,
      ws_bytes_before_reload: bytesBeforeReload,
      biggest_frame: biggest,
      frames_ge_4k: big,
      frames: frames.length,
      streamed_before_reload: before,
      shown_after_reload: shownAfterReload,
      reload_paint_ms: reloadPaintMs,
      bytes_per_answer_char: +(total / Math.max(1, final.length)).toFixed(1),
    };
    results.push(r);
    console.log(JSON.stringify(r));
    // cleanup
    await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded" });
    const link = page.locator(`a[href="${href}"]`).first();
    await link.waitFor({ timeout: 15000 }).catch(() => {});
    if (await link.count()) {
      await link.hover();
      await link.locator("xpath=..").getByRole("button", { name: "Conversation actions" }).click();
      page.once("dialog", (d) => d.accept());
      await page.getByRole("button", { name: "Delete" }).click();
      await sleep(500);
    }
  }
  await b.close();
  const med = (k) => { const v = results.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  console.log(`\n== streaming (N=${results.length}) median: answer ${med("answer_chars")} chars, WS ${med("ws_bytes_turn")} bytes/turn (${med("bytes_per_answer_char")} B per answer char), biggest frame ${med("biggest_frame")} B, frames>=4KB ${med("frames_ge_4k")}, reload repaint ${med("reload_paint_ms")} ms showing ${med("shown_after_reload")} chars`);
  console.log(`console errors: ${errors.length}`);
  for (const e of errors.slice(0, 5)) console.log("  ", e);
})();
