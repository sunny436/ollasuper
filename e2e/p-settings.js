// Dedicated full-screen Settings — end-to-end, house style: standalone node
// script, hand-rolled step() harness, hard assertion of zero console errors.
//
//   E2E_BASE_URL=https://app.ollasuper.com  node p-settings.js
//
// Verifies the new (settings) route group on the LIVE stack: the black shell
// (sidebar with the five sections + close, theme slider, no dashboard chrome),
// and that Profile + Personalization actually PERSIST across a reload (proving
// they are backend-connected, not dummy UI). Leaves the admin display name as
// it was found.
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();

const errs = [];
const results = [];

const step = async (n, f) => {
  try {
    await f();
    results.push(true);
    console.log("PASS  " + n);
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + n + " — " + e.message.split("\n")[0]);
  }
};

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 50,
  });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) {
      errs.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
  });

  await step("Settings opens the full-screen black shell", async () => {
    await page.goto(BASE + "/en/settings", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("h1", { timeout: 15000 });
    // The sidebar: brand + close + the sections. The "Settings" label that used
    // to sit under the logo was removed on purpose, so it must stay gone.
    const aside = page.locator("aside");
    await aside.getByRole("link", { name: "Close settings" }).first().waitFor({ timeout: 8000 });
    if ((await aside.getByText("Settings", { exact: true }).count()) !== 0)
      throw new Error('the "Settings" label under the logo is back');
    for (const label of [
      "Profile",
      "Personalization",
      "Shared Links",
      "Archived Chats",
      "Files",
    ]) {
      if ((await aside.getByRole("link", { name: label }).count()) === 0)
        throw new Error(`sidebar missing "${label}"`);
    }
    if ((await page.getByLabel("Close settings").count()) === 0)
      throw new Error("no close button");
    // Theme control, top-right. NOT a slider any more: the monochrome system
    // (2026-09-18) removed the 0-100 ambience engine, and the frontend now
    // speaks only light/dark, so this is a two-state button.
    if (
      (await page.getByRole("button", { name: "Toggle dark and light theme" }).count()) === 0
    )
      throw new Error("no theme toggle");
    // The OLD white settings sub-nav had a "General" item; its absence proves
    // the new sidebar replaced it, not that it merely re-skinned.
    if ((await aside.getByRole("link", { name: "General" }).count()) > 0)
      throw new Error("old General sub-nav still present");
  });

  let original = "";
  const probe = `E2E ${Date.now()}`;
  await step("Profile: display name persists across reload", async () => {
    await page.goto(BASE + "/en/settings", { waitUntil: "domcontentloaded" });
    const field = page.locator("#display_name");
    await field.waitFor({ timeout: 10000 });
    original = await field.inputValue();
    await field.fill(probe);
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await field.waitFor({ timeout: 10000 });
    const got = await field.inputValue();
    if (got !== probe) throw new Error(`display name not persisted: "${got}"`);
  });

  await step("Personalization: widget selection persists (model-connected field)", async () => {
    await page.goto(BASE + "/en/settings/personalization", {
      waitUntil: "domcontentloaded",
    });
    // UPDATED for the canonical personalization UI. Base styles are now a
    // RADIOGROUP (exactly one) and characteristics stayed toggle buttons (many),
    // so the two need different roles — this used to select "Friendly" with
    // getByRole("button"), which no longer matches. State is also no longer
    // reconstructed by parsing a prose string; it round-trips as stored data.
    const emoji = page.getByRole("button", { name: "Emoji", pressed: false });
    await emoji.waitFor({ timeout: 15000 });
    await emoji.click(); // aria-pressed -> true
    await page.getByRole("radio", { name: "Friendly", exact: true }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForTimeout(2000);
    await page.reload({ waitUntil: "domcontentloaded" });
    const pressed = page.getByRole("button", { name: "Emoji", pressed: true });
    await pressed.waitFor({ timeout: 15000 });
    const friendly = page.getByRole("radio", { name: "Friendly", exact: true });
    if ((await friendly.getAttribute("aria-checked")) !== "true") {
      throw new Error("the base style did not persist");
    }
    // Leave the account as we found it.
    await page.getByRole("radio", { name: "Default", exact: true }).click();
    await page.getByRole("button", { name: "Emoji", pressed: true }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForTimeout(1500);
  });

  await step("Archived / Library / Shared / Billing all render", async () => {
    const checks = [
      ["/en/settings/archived", "Archived chats"],
      // Settings → Files is now the File Library (a redirect).
      ["/en/settings/files", "Library"],
      ["/en/settings/shared", "Shared Links"],
    ];
    for (const [path, heading] of checks) {
      await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
      await page
        .getByRole("heading", { name: heading })
        .first()
        .waitFor({ timeout: 10000 });
    }
    await page.goto(BASE + "/en/settings/billing", {
      waitUntil: "domcontentloaded",
    });
    await page.getByText(/Plan|Billing/).first().waitFor({ timeout: 10000 });
  });

  await step("Close returns to /chat", async () => {
    await page.goto(BASE + "/en/settings", { waitUntil: "domcontentloaded" });
    await page.getByLabel("Close settings").click();
    await page.waitForURL(/\/chat/, { timeout: 10000 });
  });

  // Restore the admin display name so prod data is left as found.
  await step("restore original display name", async () => {
    await page.goto(BASE + "/en/settings", { waitUntil: "domcontentloaded" });
    const field = page.locator("#display_name");
    await field.waitFor({ timeout: 10000 });
    await field.fill(original);
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForTimeout(1200);
  });

  await step("zero console errors / no HTTP 4xx-5xx", async () => {
    if (errs.length) throw new Error(errs.slice(0, 6).join(" | "));
  });

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} steps passed`);
  if (errs.length) {
    console.log("console/network errors:");
    for (const e of errs.slice(0, 10)) console.log("  - " + e);
  }
  await b.close();
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})();
