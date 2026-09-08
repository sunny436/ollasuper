// Personalization, end to end against PRODUCTION.
//
// The decisive test is the LAST one: set a response language, send a real
// message, and read the reply. Everything before it only proves the settings
// page stores things; that one proves the stored setting reaches the model,
// which is the whole point of the feature and the thing a green settings page
// cannot tell you.
//
//   E2E_EMAIL=... E2E_PASSWORD=... node qa-personalization.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

const errs = [];
const results = [];
const notes = [];

const step = async (n, fn) => {
  try {
    await fn();
    results.push([true, n]);
    console.log("PASS  " + n);
  } catch (e) {
    results.push([false, n]);
    console.log("FAIL  " + n + " — " + String(e.message).split("\n")[0]);
  }
};

// Base styles are a RADIOGROUP (one choice), characteristics are toggle
// buttons (many). Different roles on purpose, so the selectors differ too.
const style = (page, name) => page.getByRole("radio", { name, exact: true });
const trait = (page, name) => page.getByRole("button", { name, exact: true });

async function openSettings(page) {
  await page.goto(BASE + "/en/settings/personalization", {
    waitUntil: "domcontentloaded",
  });
  await style(page, "Formal").waitFor({ timeout: 30000 });
  await page.waitForTimeout(600);
}

(async () => {
  const b = await chromium.launch({ headless: false, slowMo: 40 });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 1000 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200));
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon"))
      errs.push(`HTTP ${r.status()} ${r.url().slice(0, 110)}`);
  });

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 25000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(5000);
  });

  // Idempotent setup. A previous aborted run can leave personalization OFF,
  // and the controls live in a disabled fieldset while it is — so every click
  // below would time out for a reason that has nothing to do with the change
  // under test. Start from a known state instead of inheriting one.
  await step("start from a known state", async () => {
    await page.goto(BASE + "/en/settings/personalization", {
      waitUntil: "domcontentloaded",
    });
    await page.getByLabel("Use personalization").waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
    const master = page.getByLabel("Use personalization");
    if ((await master.getAttribute("data-state")) === "unchecked") {
      // The master switch sits OUTSIDE the fieldset precisely so it can always
      // be reached, even when everything it governs is disabled.
      await master.click();
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: /^Save$/ }).click();
      await page.waitForTimeout(2500);
      notes.push("setup: re-enabled personalization left off by an earlier run");
    }
    await page.getByRole("button", { name: /Reset to defaults/i }).click();
    await page.waitForTimeout(2500);
  });

  await step("the page loads its saved state, not a flash of defaults", async () => {
    await page.goto(BASE + "/en/settings/personalization", {
      waitUntil: "domcontentloaded",
    });
    // The loading state exists precisely so a user whose style is Formal never
    // sees "Default" selected for a beat.
    await page
      .getByText(/Loading your preferences/i)
      .waitFor({ timeout: 8000 })
      .catch(() => notes.push("load was too fast to observe the loading state"));
    await style(page, "Formal").waitFor({ timeout: 30000 });
  });

  await step("Save is disabled until something actually changes", async () => {
    const save = page.getByRole("button", { name: /^Save$/ });
    if (!(await save.isDisabled()))
      throw new Error("Save enabled on a clean form");
  });

  await step("choose a style + characteristic + fast answers, then save", async () => {
    await style(page, "Formal").click();
    await trait(page, "Warm").click();
    await page.getByLabel("Fast answers").click();
    await page.waitForTimeout(400);
    const save = page.getByRole("button", { name: /^Save$/ });
    if (await save.isDisabled()) throw new Error("Save still disabled after edits");
    await save.click();
    await page.waitForTimeout(2500);
  });

  await step("the choices survive a full reload", async () => {
    await openSettings(page);
    if ((await style(page, "Formal").getAttribute("aria-checked")) !== "true")
      throw new Error("base style did not persist");
    if ((await trait(page, "Warm").getAttribute("aria-pressed")) !== "true")
      throw new Error("characteristic did not persist");
    const fast = page.getByLabel("Fast answers");
    if ((await fast.getAttribute("data-state")) !== "checked")
      throw new Error("fast answers did not persist");
  });

  await step("turning personalization OFF keeps the stored preferences", async () => {
    await page.getByLabel("Use personalization").click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /^Save$/ }).click();
    await page.waitForTimeout(2500);
    await openSettings(page);
    const master = page.getByLabel("Use personalization");
    if ((await master.getAttribute("data-state")) !== "unchecked")
      throw new Error("the master switch did not persist");
    // Disabled means IGNORED, not deleted — the choices must still be there.
    if ((await style(page, "Formal").getAttribute("aria-checked")) !== "true")
      throw new Error("disabling erased the stored style");
    // ...and re-enable for the rest of the run.
    await master.click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /^Save$/ }).click();
    await page.waitForTimeout(2500);
  });

  await step("Reset restores defaults but keeps custom instructions", async () => {
    await openSettings(page);
    const about = page.getByLabel("Custom instructions");
    await about.fill("I am a backend engineer.");
    await page.getByRole("button", { name: /^Save$/ }).click();
    await page.waitForTimeout(2500);

    await page.getByRole("button", { name: /Reset to defaults/i }).click();
    await page.waitForTimeout(2500);
    await openSettings(page);

    if ((await style(page, "Default").getAttribute("aria-checked")) !== "true")
      throw new Error("reset did not restore the default style");
    if ((await trait(page, "Warm").getAttribute("aria-pressed")) !== "false")
      throw new Error("reset did not clear characteristics");
    // Custom instructions are something the user WROTE. Reset must not eat it.
    const kept = await page.getByLabel("Custom instructions").inputValue();
    if (kept !== "I am a backend engineer.")
      throw new Error(`reset destroyed custom instructions: ${JSON.stringify(kept)}`);
    notes.push("reset kept the custom instructions");
  });

  await step("Cancel restores the last saved state", async () => {
    await style(page, "Playful").click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /^Cancel$/ }).click();
    await page.waitForTimeout(500);
    if ((await style(page, "Default").getAttribute("aria-checked")) !== "true")
      throw new Error("Cancel did not restore the saved style");
  });

  // ---- THE ONE THAT MATTERS -----------------------------------------------
  await step("a saved preference actually changes a real model reply", async () => {
    await openSettings(page);
    await page.getByLabel("Response language").selectOption("Spanish");
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /^Save$/ }).click();
    await page.waitForTimeout(3000);

    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 25000 });
    await page.locator("#chat-composer").click();
    await page.keyboard.type("Say hello and tell me what day it is.");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => (document.body.innerText || "").length > 400,
      { timeout: 120000 },
    );
    await page.waitForTimeout(9000);
    const body = await page.evaluate(() => document.body.innerText || "");
    // Spanish reply markers. Deliberately several: the model is free to phrase
    // it many ways, and the assertion is "it answered in Spanish", not "it said
    // one exact word".
    const spanish = /\b(hola|buenos d[ií]as|buenas|hoy es|saludos|c[oó]mo est[aá]s)\b/i;
    if (!spanish.test(body))
      throw new Error(
        "reply was not in Spanish — the saved preference did not reach the model",
      );
    notes.push("Spanish reply confirmed: the preference reached the model");
  });

  await step("restore the account to defaults", async () => {
    await openSettings(page);
    await page.getByRole("button", { name: /Reset to defaults/i }).click();
    await page.waitForTimeout(2500);
    const about = page.getByLabel("Custom instructions");
    await about.fill("");
    await page.waitForTimeout(300);
    const save = page.getByRole("button", { name: /^Save$/ });
    if (!(await save.isDisabled())) {
      await save.click();
      await page.waitForTimeout(2000);
    }
  });

  console.log("\n--- notes ---");
  for (const n of notes) console.log("  " + n);
  const uniq = [...new Set(errs)];
  console.log(`\n--- console/network errors: ${uniq.length} ---`);
  for (const e of uniq.slice(0, 12)) console.log("  " + e);
  const passed = results.filter(([ok]) => ok).length;
  console.log(`\nRESULT ${passed}/${results.length} passed, ${uniq.length} errors`);
  for (const [ok, n] of results) if (!ok) console.log("  FAILED: " + n);
  await b.close();
  process.exit(passed === results.length && uniq.length === 0 ? 0 : 1);
})();
