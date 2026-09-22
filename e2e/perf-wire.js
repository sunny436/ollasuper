// Which query is eating the WebSocket during one long answer. Maps queryIds
// from the client's ModifyQuerySet frames to udf paths and attributes every
// Transition's bytes to them. Headed Chrome, QA account.
//
//   node perf-wire.js
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const { email: EMAIL, password: PASSWORD } = require("./creds").account();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROW = '[aria-label="Conversation"] .group.my-5';
const PROMPT = process.argv[2] || "Write a detailed 700-word essay about the history of the Indian railways, in plain prose paragraphs, no headings, no lists. Do not use any tools.";

(async () => {
  const b = await chromium.launch({ headless: false });
  const ctx = await b.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  const names = new Map(); // queryId -> udfPath
  const bytesBy = new Map(); // udfPath -> {bytes, pushes, max}
  let measuring = false;
  let totalIn = 0;
  cdp.on("Network.webSocketFrameSent", (e) => {
    try {
      const m = JSON.parse(e.response.payloadData);
      if (m.type === "ModifyQuerySet") for (const mod of m.modifications || []) if (mod.type === "Add") names.set(mod.queryId, mod.udfPath);
    } catch {}
  });
  cdp.on("Network.webSocketFrameReceived", (e) => {
    const data = e.response.payloadData || "";
    if (!measuring) return;
    totalIn += data.length;
    try {
      const m = JSON.parse(data);
      if (m.type !== "Transition") return;
      for (const mod of m.modifications || []) {
        const name = names.get(mod.queryId) || `q${mod.queryId}`;
        const size = JSON.stringify(mod.value ?? mod).length;
        const cur = bytesBy.get(name) || { bytes: 0, pushes: 0, max: 0 };
        cur.bytes += size; cur.pushes += 1; cur.max = Math.max(cur.max, size);
        bytesBy.set(name, cur);
      }
    } catch {}
  });

  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "New chat" }).click();
  await page.waitForURL(/\/chat\/?$/, { timeout: 15000 }).catch(() => {});
  await page.locator("#chat-composer").fill(PROMPT);
  measuring = true;
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 30000 });
  const href = new URL(page.url()).pathname;
  const stop = page.getByRole("button", { name: "Stop generating" });
  const t0 = Date.now();
  let seenStop = false;
  while (Date.now() - t0 < 240000) {
    if ((await stop.count()) > 0) seenStop = true;
    else if (seenStop) break;
    else if (Date.now() - t0 > 90000) break;
    await sleep(250);
    const toast = await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
    if (toast.length) { console.log("TOAST:", toast.join(" | ").slice(0, 200)); break; }
  }
  await sleep(2000);
  measuring = false;
  const text = await page.evaluate((sel) => { const rows = [...document.querySelectorAll(sel)].filter((r) => !r.classList.contains("items-end")); const l = rows[rows.length - 1]; return l ? l.innerText.trim().split(/\r?\n/).slice(2).join("\n").trim() : ""; }, ROW);
  console.log(`answer ${text.length} chars, WS in ${totalIn} bytes (${(totalIn / Math.max(1, text.length)).toFixed(1)} B/char), console errors ${errors.length}`);
  for (const [k, v] of [...bytesBy.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) console.log(`  ${k.padEnd(34)} ${String(v.bytes).padStart(8)} B  pushes=${String(v.pushes).padStart(3)}  max=${v.max}`);
  for (const e of errors.slice(0, 5)) console.log("  console.error:", e);
  // cleanup
  await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded" });
  const link = page.locator(`a[href="${href}"]`).first();
  await link.waitFor({ timeout: 15000 }).catch(() => {});
  if (await link.count()) { await link.hover(); await link.locator("xpath=..").getByRole("button", { name: "Conversation actions" }).click(); page.once("dialog", (d) => d.accept()); await page.getByRole("button", { name: "Delete" }).click(); await sleep(500); }
  await b.close();
})();
