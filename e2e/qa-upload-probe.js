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
  await page.goto(BASE + "/en/files", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.setInputFiles('input[type="file"]', process.env.F);
  // Ingest is async: Convex row first, then Python writes Postgres rows.
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(3000);
    const t = await page.evaluate(() => document.body.innerText || "");
    if (/ready/i.test(t) && /qa-m10-probe/i.test(t)) { console.log("READY after", (i+1)*3, "s"); break; }
    if (/failed/i.test(t)) { console.log("INGEST FAILED"); break; }
  }
  const txt = await page.evaluate(() => document.body.innerText || "");
  console.log("page mentions probe:", /qa-m10-probe/i.test(txt));
  console.log(txt.replace(/\s+/g," ").slice(0, 260));
  await b.close();
})();
