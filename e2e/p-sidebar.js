const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
// Fallback is for the EPHEMERAL CI stack only (localhost, torn down after the
// run). Any deployment reachable from the internet must set ADMIN_PASSWORD.
const PASSWORD = require("./creds").adminPassword();
const errs = [], results = []; let cur = BASE;
// Wait for the rail to reach a visibility state, polling instead of sleeping.
// Fails in 8s if it genuinely never gets there, so a real break is still loud.
const railState = async (rail, want, what) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if ((await rail.isVisible()) === want) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`rail did not ${what}`);
};
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
    if (/login/.test(cur)) throw new Error("not logged in: " + cur);
  });
  await step("root redirects to /chat", async () => {
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/chat/, { timeout: 15000 }); cur = page.url();
  });
  await step("workspace chrome renders on /chat", async () => {
    // /chat is full-bleed: no dashboard aside, its own conversation rail.
    if (await page.locator("aside").count()) throw new Error("dashboard shell leaked into /chat");
    await page.waitForSelector('nav[aria-label="Conversations"]', { timeout: 12000 });
    await page.waitForSelector("#chat-composer", { timeout: 12000 });
  });
  await step("workspace rail collapses and restores", async () => {
    const rail = page.locator('nav[aria-label="Conversations"]').first();
    // Poll rather than sleep a fixed 600ms. The rail restores its persisted
    // state in an effect and then animates a 300ms width transition, so on a
    // cold CI runner the collapse can land AFTER a fixed wait. That produced a
    // 1-in-8 "rail did not collapse", and then cascaded: the rail collapsed a
    // moment later, taking the account-menu button (which lives inside it) out
    // of view, so the next step hung for its full 30s click timeout.
    await page.getByRole("button", { name: "Hide conversations" }).click();
    await railState(rail, false, "collapse");
    await page.getByRole("button", { name: "Open conversations" }).click();
    await railState(rail, true, "restore");
  });
  await step("account menu exposes the routes that kept the shell", async () => {
    // The account menu lives inside the rail, so make this step independent of
    // whatever state the previous one left behind.
    const rail = page.locator('nav[aria-label="Conversations"]').first();
    if (!(await rail.isVisible())) {
      await page.getByRole("button", { name: "Open conversations" }).click();
      await railState(rail, true, "restore before account menu");
    }
    await page.getByRole("button", { name: "Account menu" }).click();
    // Files + Billing were removed from the account menu; only Settings remains
    // there (Files/Billing stay in the dashboard aside, checked below).
    if (!(await page.getByRole("link", { name: "Settings" }).first().isVisible()))
      throw new Error("missing account-menu link: Settings");
    await page.keyboard.press("Escape");
  });
  await step("sidebar shows all nav links (left)", async () => {
    // The dashboard shell lives on the routes that kept it.
    await page.goto(BASE + "/en/files", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000); cur = page.url();
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
