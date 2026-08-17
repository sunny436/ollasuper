const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
// Fallback is for the EPHEMERAL CI stack only (localhost, torn down after the
// run). Any deployment reachable from the internet must set ADMIN_PASSWORD.
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const errs = [], results = []; let cur = BASE;
const step = async (n, f) => { try { const d = await f(); results.push([true, n, d || ""]); console.log("PASS  " + n + (d ? " — " + d : "")); } catch (e) { results.push([false, n, e.message.split("\n")[0]]); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); } };
(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: process.env.CI ? 0 : 120 });
  const page = await (await b.newContext({ viewport: { width: 1366, height: 850 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") errs.push(`[${cur}] ${m.text()}`); });

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500); cur = page.url();
    if (/login|onboarding/.test(cur)) throw new Error("not logged in: " + cur);
  });
  await step("root redirects to /chat", async () => {
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/chat/, { timeout: 15000 }); cur = page.url();
  });
  await step("sidebar shows all nav links (left)", async () => {
    const aside = page.locator("aside");
    for (const label of ["Chat", "Files", "Settings", "Billing"]) {
      if (!(await aside.getByRole("link", { name: label }).first().isVisible())) throw new Error("missing nav: " + label);
    }
    await page.screenshot({ path: "C:\\Users\\test\\pw-e2e\\shots-sidebar.png" });
  });
  await step("workspace switcher present in sidebar", async () => {
    if (!(await page.locator("aside select").first().isVisible())) throw new Error("no workspace switcher");
  });
  await step("navigate via sidebar → Files", async () => {
    await page.locator("aside").getByRole("link", { name: "Files" }).click();
    await page.waitForURL(/\/files/, { timeout: 10000 }); cur = page.url();
    await page.waitForSelector("text=Files", { timeout: 15000 });
  });
  await step("navigate via sidebar → Chat", async () => {
    await page.locator("aside").getByRole("link", { name: "Chat" }).click();
    await page.waitForURL(/\/chat/, { timeout: 10000 }); cur = page.url();
  });
  await b.close();
  const pass = results.filter((r) => r[0]).length;
  console.log(`\n===== SIDEBAR: ${pass}/${results.length} | console errors: ${errs.length} =====`);
  errs.forEach((e) => console.log("  - " + e));
  // Exit non-zero like p-chat does. Without this the workflow's `|| exit 1` was
  // a no-op gate: this suite loads /chat (the landing page) and a render crash
  // there shows up only as a console error, which used to pass silently.
  if (pass !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
