// One research query to re-verify record-before-synthesis + deterministic finalize.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-research-one.js
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const errs = [];
(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 20 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
  await page
    .locator("#chat-composer")
    .fill(
      "Research and compare the current pricing and standout features of Fathom " +
        "Analytics, Plausible, and Simple Analytics for a small startup. Cite sources.",
    );
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
  const threadId = page.url().split("/chat/")[1];
  console.log("THREAD: " + threadId);
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ timeout: 40000 }).catch(() => {});
  const d = Date.now() + 420000;
  while (Date.now() < d && (await stop.count()) > 0) await page.waitForTimeout(800);
  await page.waitForTimeout(2000);
  const text = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    return rows[rows.length - 1]?.innerText || "";
  });
  console.log("\n---- ANSWER (first 1200) ----\n" + text.slice(0, 1200) + "\n----\n");
  console.log("RESEARCH-ONE: thread=" + threadId + " consoleErrors=" + errs.length);
  await b.close();
  process.exit(errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
