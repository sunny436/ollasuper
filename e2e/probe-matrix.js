const { chromium } = require("playwright");
const BASE = "https://app.ollasuper.com";
const gen = (p) => p.getByRole("button", { name: "Create task" });
(async () => {
  const b = await chromium.launch({ headless: false, slowMo: 20 });
  const page = await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 25000 });
  await page.locator('input[type="email"]').first().fill(process.env.E);
  await page.locator('input[type="password"]').first().fill(process.env.P);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);
  const c = page.getByPlaceholder("Schedule a task");
  await page.goto(`${BASE}/en/scheduled`, { waitUntil: "domcontentloaded" });
  await c.waitFor({ timeout: 30000 });
  await page.evaluate(() => { try { sessionStorage.clear(); } catch {} });
  await page.reload({ waitUntil: "domcontentloaded" });
  await c.waitFor({ timeout: 30000 });
  console.log("draft survived clear? count =", await gen(page).count());
  await c.fill("remind me to call the bank");
  await page.keyboard.press("Enter");
  try {
    await gen(page).waitFor({ timeout: 180000 });
    await page.waitForTimeout(1200);
    const title = await page.getByLabel("Task name").inputValue().catch(() => "__THREW__");
    const body = await page.evaluate(() => document.body.innerText || "");
    const unparseable = /couldn't read that as a schedule/i.test(body);
    const blocked = !(await gen(page).isEnabled().catch(() => false));
    console.log({ title, unparseable, blocked, ok: !unparseable && blocked });
  } catch (e) {
    console.log("THREW:", String(e.message).split("\n").slice(0,4).join(" | "));
  }
  await b.close();
})();
