// Prod acceptance for the readiness/bundle perf batch. Headed Chrome:
//  - three.js (the biggest JS chunk) must NOT load before the composer is enabled
//  - no Sentry request on a DSN-free deployment
//  - empty chat still sends, streams, and renders markdown (reveal 30Hz)
//  - existing threads render; Settings still works after the TooltipProvider removal
//  - zero console errors / failed responses anywhere
//   E2E_BASE_URL=https://app.ollasuper.com node qa-perf-verify.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";

const errs = [];
const results = [];
const step = async (n, f) => {
  try {
    await f();
    results.push(true);
    console.log("PASS  " + n);
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + n + " — " + e.message.split("\n")[0]);
  }
};
const need = (c, m) => {
  if (!c) throw new Error(m);
};

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 25 });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  const sentryHits = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    const u = r.url();
    if (/sentry|ingest\.sentry/i.test(u)) sentryHits.push(u);
    if (r.status() >= 400 && !u.includes("favicon")) errs.push("HTTP " + r.status() + " " + u);
  });

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
  });

  // Fresh /chat, cold: measure when the composer enables, then inspect resource
  // timing for the biggest JS chunk (three.js) — it must start AFTER ready.
  let bigJsBeforeReady = null;
  await step("open /chat cold, composer enables", async () => {
    const fresh = await b.newContext({
      viewport: { width: 1440, height: 950 },
      storageState: await ctx.storageState(),
    });
    const p2 = await fresh.newPage();
    p2.on("console", (m) => {
      if (m.type() === "error") errs.push("[/chat] " + m.text());
    });
    p2.on("response", (r) => {
      if (/sentry/i.test(r.url())) sentryHits.push(r.url());
    });
    await p2.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await p2.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
    const readyPerf = await p2.evaluate(() => performance.now());
    // Let post-ready lazy chunks land.
    await p2.waitForTimeout(3000);
    bigJsBeforeReady = await p2.evaluate((cut) => {
      const res = performance.getEntriesByType("resource");
      const js = res.filter(
        (r) => r.initiatorType === "script" || /\.js(\?|$)/.test(r.name),
      );
      // three.js is by far the largest chunk (~560KB decoded). Anything >400KB
      // decoded that STARTED before composer-ready is a readiness-window regression.
      const big = js
        .filter((r) => (r.decodedBodySize || 0) > 400000)
        .map((r) => ({
          kb: Math.round((r.decodedBodySize || 0) / 1024),
          start: Math.round(r.startTime),
          beforeReady: r.startTime <= cut,
          name: r.name.split("/").pop(),
        }));
      return { readyMs: Math.round(cut), big };
    }, readyPerf);
    console.log("    composer ready ~" + bigJsBeforeReady.readyMs + "ms; big JS chunks: " +
      JSON.stringify(bigJsBeforeReady.big));
    await fresh.close();
  });

  await step("three.js is NOT loaded before composer-ready", async () => {
    const early = (bigJsBeforeReady?.big || []).filter((c) => c.beforeReady);
    need(early.length === 0, "a >400KB JS chunk loaded before ready: " + JSON.stringify(early));
  });

  await step("no Sentry request (DSN-free deploy)", async () =>
    need(sentryHits.length === 0, "Sentry requested: " + sentryHits[0]),
  );

  // Empty chat still works end to end: send, stream, render markdown.
  await step("empty chat: send a message, reply streams + renders", async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
    await page.locator("#chat-composer").fill(
      "In one short sentence, what is a canonical URL? Then show a tiny ```html code block.",
    );
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 20000 });
    const stop = page.getByRole("button", { name: "Stop generating" });
    await stop.waitFor({ timeout: 30000 }).catch(() => {});
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && (await stop.count()) > 0)
      await page.waitForTimeout(500);
    // Messages render as `.group.my-5` rows (user rows add .items-end); the last
    // row after a send is the assistant reply.
    const txt = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("div.my-5")];
      const last = rows[rows.length - 1];
      return last ? last.innerText : "";
    });
    need(txt.length > 20, "assistant reply too short/empty: " + JSON.stringify(txt.slice(0, 40)));
    // markdown must have RENDERED the fenced code block into a <pre>, not left the
    // ``` as raw text — proof the lazy markdown chunk loaded and applied.
    const hasPre = await page.evaluate(
      () => !!document.querySelector("div.my-5 pre, div.my-5 code"),
    );
    need(hasPre, "markdown did not render the fenced code block");
  });

  await step("existing thread renders (rail nav)", async () => {
    const link = page.locator('a[href^="/chat/"]').first();
    if ((await link.count()) === 0) throw new Error("no thread in rail");
    await link.click();
    await page.waitForSelector("div.my-5", { timeout: 15000 });
  });

  await step("Settings still works after TooltipProvider removal", async () => {
    await page.goto(BASE + "/en/settings", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);
  });

  await ctx.close();
  await b.close();
  const passed = results.filter(Boolean).length;
  console.log("\n===== PERF-VERIFY: " + passed + "/" + results.length +
    " | console errors: " + errs.length + " | sentry hits: " + sentryHits.length + " =====");
  for (const e of [...new Set(errs)].slice(0, 10)) console.log("  ! " + e.slice(0, 160));
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
