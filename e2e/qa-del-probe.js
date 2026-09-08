const { chromium } = require("playwright");
const BASE = "https://app.ollasuper.com";
(async () => {
  const b = await chromium.launch({ headless: false, slowMo: 30 });
  const page = await (await b.newContext({viewport:{width:1440,height:900}})).newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 25000 });
  await page.locator('input[type="email"]').first().fill(process.env.E);
  await page.locator('input[type="password"]').first().fill(process.env.P);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(6000);
  await page.goto(BASE + "/en/settings", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const dump = () => page.evaluate(() => ({
    buttons: [...document.querySelectorAll("button")].map(b => ({
      label: (b.innerText||"").trim().slice(0,30), disabled: b.disabled })).filter(x=>x.label),
    inputs: [...document.querySelectorAll("input")].map(i => ({
      type: i.type, ph: i.placeholder })),
  }));
  console.log("BEFORE:", JSON.stringify(await dump()));
  const f = page.locator('input[placeholder="Your password"]').first();
  console.log("pw field count:", await f.count());
  if (await f.count()) { await f.fill("wrong-pass-probe"); await page.waitForTimeout(1200); }
  console.log("AFTER FILL:", JSON.stringify(await dump()));
  await b.close();
})();
