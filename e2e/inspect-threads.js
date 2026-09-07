// Read the exact assistant answer from specific threads (QA-12 failure triage).
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const IDS = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 10 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]'); await page.waitForTimeout(3500);
  for (const id of IDS) {
    await page.goto(`${BASE}/en/chat/${id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const text = await page.evaluate(() => document.body.innerText || "");
    console.log(`\n===== THREAD ${id} =====\n` + text.slice(0, 2600));
  }
  await b.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
