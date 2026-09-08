const { chromium } = require("playwright");
const BASE = "https://app.ollasuper.com";
(async () => {
  const b = await chromium.launch({ headless: false, slowMo: 40 });
  const page = await (await b.newContext({viewport:{width:1440,height:900}})).newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 25000 });
  await page.locator('input[type="email"]').first().fill(process.env.E);
  await page.locator('input[type="password"]').first().fill(process.env.P);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(6000);
  await page.goto(BASE + "/en/projects", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: /^New$/ }).first().click();
  await page.waitForTimeout(2000);
  const dlg = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]') || document.body;
    return {
      inputs: [...d.querySelectorAll("input,textarea")].map(i => ({
        tag: i.tagName, id: i.id, name: i.name, type: i.type,
        ph: i.placeholder, aria: i.getAttribute("aria-label"),
      })),
      buttons: [...d.querySelectorAll("button")].map(b => ({
        label: (b.innerText||"").trim().slice(0,24), disabled: b.disabled,
      })),
    };
  });
  console.log(JSON.stringify(dlg, null, 1).slice(0, 1600));
  await b.close();
})();
