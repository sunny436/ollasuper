// M8: the account-deletion password path must be rate limited. Pre-fix it
// verified a password with no attempt cap — a password oracle for anyone
// holding a session. Every attempt uses a WRONG password on purpose.
//
// The button is a useDoubleCheck control: the FIRST click only arms it and any
// blur (including re-focusing the password field) disarms it again, so the
// mutation only fires on a second click made without touching anything else.
const { chromium } = require("playwright");
const BASE = "https://app.ollasuper.com";
(async () => {
  const b = await chromium.launch({ headless: false, slowMo: 20 });
  const page = await (await b.newContext({viewport:{width:1440,height:900}})).newPage();
  const errs = [];
  page.on("console", m => { if (m.type()==="error") errs.push(m.text().replace(/\s+/g," ").slice(0,180)); });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 25000 });
  await page.locator('input[type="email"]').first().fill(process.env.E);
  await page.locator('input[type="password"]').first().fill(process.env.P);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(6000);
  await page.goto(BASE + "/en/settings", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);

  const field = page.locator('input[placeholder="Your password"]').first();
  await field.waitFor({ timeout: 15000 });
  // Same DOM node throughout: its LABEL changes between armed/disarmed.
  const btn = page.locator("button").filter({ hasText: /Delete Account|Confirm|sure|really/i }).last();

  for (let i = 1; i <= 13; i++) {
    await field.fill("wrong-password-attempt-" + i);
    await page.waitForTimeout(300);
    await btn.click({ timeout: 10000 }).catch(() => {});   // arms
    await page.waitForTimeout(400);
    await btn.click({ timeout: 10000 }).catch(() => {});   // fires
    await page.waitForTimeout(2200);
    const toast = page.locator("[data-sonner-toast]");
    const text = (await toast.count())
      ? (await toast.first().innerText()).replace(/\s+/g, " ").trim()
      : "(no toast)";
    console.log(`${i}: ${text.slice(0, 110)}`);
    if (/\/login/.test(page.url())) { console.log(`${i}: SIGNED OUT`); break; }
    if (/too many|rate|later|limit/i.test(text)) { console.log(`\n>>> RATE LIMIT HIT AT ATTEMPT ${i}`); break; }
    await page.waitForTimeout(900);
  }
  console.log("\n--- console errors ---");
  for (const e of [...new Set(errs)].slice(0, 5)) console.log("  " + e);
  await b.close();
})();
