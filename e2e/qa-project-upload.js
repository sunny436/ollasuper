const { chromium } = require("playwright");
const BASE = "https://app.ollasuper.com";
(async () => {
  const b = await chromium.launch({ headless: false, slowMo: 45 });
  const page = await (await b.newContext({viewport:{width:1440,height:900}})).newPage();
  page.on("console", m => { if (m.type()==="error") console.log("CONSOLE ERR:", m.text().slice(0,150)); });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 25000 });
  await page.locator('input[type="email"]').first().fill(process.env.E);
  await page.locator('input[type="password"]').first().fill(process.env.P);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(6000);
  await page.goto(BASE + "/en/projects", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: /^New$/ }).first().click();
  await page.waitForTimeout(1500);
  const dlg = page.locator('[role="dialog"]');
  await dlg.locator('input[aria-label="Project name"]').fill("QA M10 Purge Probe");
  await page.waitForTimeout(500);
  await dlg.getByRole("button", { name: /create project/i }).click();
  await page.waitForTimeout(5000);
  console.log("after create URL:", page.url());

  let inputs = await page.locator('input[type="file"]').count();
  if (!inputs) {
    for (const label of [/add (files?|sources?)/i, /sources?/i, /upload/i, /\+/]) {
      const btn = page.getByRole("button", { name: label }).first();
      if (await btn.count()) { await btn.click().catch(()=>{}); await page.waitForTimeout(1500); }
      inputs = await page.locator('input[type="file"]').count();
      if (inputs) break;
    }
  }
  console.log("file inputs found:", inputs);
  if (!inputs) {
    console.log("PAGE:", (await page.evaluate(()=>document.body.innerText||"")).replace(/\s+/g," ").slice(0,500));
    await b.close(); return;
  }
  await page.setInputFiles('input[type="file"]', process.env.F);
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(3000);
    const t = await page.evaluate(() => document.body.innerText || "");
    if (/qa-m10-probe/i.test(t) && /ready|indexed/i.test(t)) { console.log("READY after", (i+1)*3, "s"); break; }
    if (/failed/i.test(t)) { console.log("INGEST FAILED"); break; }
  }
  console.log("FINAL:", (await page.evaluate(()=>document.body.innerText||"")).replace(/\s+/g," ").slice(0,350));
  await b.close();
})();
