const { chromium } = require("playwright");
const BASE = "https://app.ollasuper.com";
(async () => {
  const b = await chromium.launch({ headless: false, slowMo: 25 });
  const page = await (await b.newContext()).newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 25000 });
  await page.locator('input[type="email"]').first().fill(process.env.E);
  await page.locator('input[type="password"]').first().fill(process.env.P);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(6000);
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  const found = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k) || "";
      const ids = [...new Set((v.match(/\b[a-z0-9]{32}\b/g) || []))].slice(0, 6);
      if (ids.length) out[k] = ids;
    }
    return out;
  });
  console.log(JSON.stringify(found, null, 1).slice(0, 1500));
  await b.close();
})();
