// Focused: STOP + immediate SEND race, in isolation, twice, for consistency.
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const gen = (page) => page.getByRole("button", { name: "Stop generating" });
const settle = async (page, ms = 120000) => { const dl = Date.now() + ms; while (Date.now() < dl) { if ((await gen(page).count()) === 0) return true; await page.waitForTimeout(300); } return false; };

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 20 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = []; page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]'); await page.waitForTimeout(3500);
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 15000 });

  for (const round of [1, 2]) {
    await settle(page);
    await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
    await page.waitForTimeout(1200);
    await page.locator("#chat-composer").fill("Write a very long essay about mountains, at least 800 words.");
    await page.keyboard.press("Enter");
    const started = await gen(page).waitFor({ timeout: 25000 }).then(() => true).catch(() => false);
    console.log(`round ${round}: initial gen started=${started}`);
    if (!started) { console.log("  (initial send never started — investigating that, not stop+send)"); continue; }
    await page.waitForTimeout(1500);
    await gen(page).click(); // STOP
    await page.waitForTimeout(500);
    const marker = `RESUMED${round}`;
    await page.locator("#chat-composer").fill(`Reply with exactly the word: ${marker}`);
    await page.keyboard.press("Enter");
    const restarted = await gen(page).waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    await settle(page, 90000);
    const got = await page.evaluate((m) => (document.body.innerText || "").includes(m), marker);
    console.log(`round ${round}: post-STOP send started=${restarted} answer_present=${got}`);
  }
  console.log(`console errors: ${errs.length}`);
  for (const e of errs) console.log("  - " + e);
  await b.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
