const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
// Fallback is for the EPHEMERAL CI stack only (localhost, torn down after the
// run). Any deployment reachable from the internet must set ADMIN_PASSWORD.
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const errs = [], results = [];
const step = async (n, f) => { try { await f(); results.push(true); console.log("PASS  " + n); } catch (e) { results.push(false); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); } };
(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: process.env.CI ? 0 : 120 });
  const page = await (await b.newContext({ viewport: { width: 1366, height: 850 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
  });
  await step("Ctrl+K opens palette", async () => {
    await page.keyboard.press("Control+k");
    await page.waitForSelector('input[placeholder="Jump to…"]', { timeout: 5000 });
  });
  await step("filter + Enter navigates to Files", async () => {
    await page.fill('input[placeholder="Jump to…"]', "file");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/files/, { timeout: 8000 });
  });
  await b.close();
  console.log(`\n===== CMDK: ${results.filter(Boolean).length}/${results.length} | console errors: ${errs.length} =====`);
  errs.forEach((e) => console.log("  - " + e));
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
