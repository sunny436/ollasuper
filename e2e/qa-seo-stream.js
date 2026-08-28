// Verify the SEO audit now STREAMS a markdown report into chat (no report card).
//   E2E_BASE_URL=https://app.ollasuper.com node qa-seo-stream.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const TARGET = process.env.QA_TARGET || "https://www.networkershome.com/";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 420000);

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
const settle = async (page, ms) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const deadline = Date.now() + ms;
  // Let it start, then wait for the stop button to disappear (generation done).
  await stop.waitFor({ timeout: 30000 }).catch(() => {});
  while (Date.now() < deadline) {
    if ((await stop.count()) === 0) return true;
    await page.waitForTimeout(500);
  }
  return false;
};

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 40,
  });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 950 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon"))
      errs.push(`HTTP ${r.status()} ${r.url()}`);
  });

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 15000 });
  });

  await step("send an SEO audit request", async () => {
    await page
      .locator("#chat-composer")
      .fill(
        `Do a full technical SEO audit of the single page ${TARGET} — check ` +
          `title, meta, headings, canonical, indexability, robots, sitemap, ` +
          `response headers, redirects, mixed content, broken links and structured ` +
          `data, then give me the report.`,
      );
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 20000 });
  });

  await step("the audit streams to completion", async () => {
    if (!(await settle(page, WAIT_MS)))
      throw new Error("generation did not finish within the wait window");
  });

  let report = "";
  await step("NO report card renders (it was removed)", async () => {
    const card = page.locator('[aria-label="SEO audit report"]');
    if ((await card.count()) > 0) throw new Error("a SEO report card still rendered");
  });

  await step("a streamed markdown report is present", async () => {
    // The last assistant message text is the report. Grab the largest markdown block.
    report = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("[data-message-role='assistant'], .prose, article")];
      let best = "";
      for (const n of nodes) {
        const t = n.innerText || "";
        if (t.length > best.length) best = t;
      }
      return best || document.body.innerText;
    });
    console.log("\n----- STREAMED REPORT (first 3500 chars) -----\n" + report.slice(0, 3500) + "\n----- END -----\n");
    const low = report.toLowerCase();
    const hits = ["seo audit", "summary", "finding"].filter((k) => low.includes(k));
    if (hits.length < 2)
      throw new Error("report missing expected sections; hits=" + hits.join(","));
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(
    `\n===== SEO STREAM QA: ${passed}/${results.length} | console errors: ${errs.length} =====`,
  );
  for (const e of errs) console.log("  - " + e);
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
