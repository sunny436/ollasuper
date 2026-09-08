// Reports what a real browser can do with the current account state.
// Used either side of users:setAccountStatus to prove suspension BITES on
// production, which convex-test can only assert in-process.
const { chromium } = require("playwright");
const BASE = "https://app.ollasuper.com";
(async () => {
  const b = await chromium.launch({ headless: false, slowMo: 30 });
  const page = await (await b.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 25000 });
  await page.locator('input[type="email"]').first().fill(process.env.E);
  await page.locator('input[type="password"]').first().fill(process.env.P);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(6000);
  const afterLogin = page.url();
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const chatUrl = page.url();
  const loggedIn = !/login/.test(chatUrl);
  let filesOk = false;
  if (loggedIn) {
    await page.goto(BASE + "/en/files", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    filesOk = !/login/.test(page.url());
  }
  const visible = (await page.evaluate(() => document.body.innerText || "")).slice(0, 200);
  console.log(JSON.stringify({
    afterLoginUrl: afterLogin, chatUrl, LOGGED_IN: loggedIn, filesReachable: filesOk,
    firstText: visible.replace(/\s+/g, " ").slice(0, 160), consoleErrors: errs.length,
  }, null, 1));
  await b.close();
})();
