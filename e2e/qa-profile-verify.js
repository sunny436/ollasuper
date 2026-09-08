// Profile photo sync + Save button, verified against PRODUCTION.
//
//   E2E_EMAIL=... E2E_PASSWORD=... node qa-profile-verify.js
//
// Two reported defects, two different causes:
//   * the photo "did not sync" because the chat rail never rendered one — it
//     painted the initial unconditionally while Settings and the dashboard
//     rail both showed avatarUrl;
//   * Save "sometimes did nothing" because `dirty` compared the raw field and
//     onSave compared `.trim()`, so a whitespace-only edit enabled the button,
//     sent nothing, and still reported success.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

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

// A tiny, valid PNG (1x1 red) written to disk for the upload input.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

(async () => {
  const shot = path.join(require("node:os").tmpdir(), `qa-avatar-${Date.now()}.png`);
  fs.writeFileSync(shot, PNG);

  const b = await chromium.launch({ headless: false, slowMo: 45 });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200));
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon"))
      errs.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`);
  });

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 25000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(5000);
    await page.goto(BASE + "/en/settings", { waitUntil: "domcontentloaded" });
    await page.locator("#display_name").waitFor({ timeout: 25000 });
  });

  let original = "";
  await step("capture the current display name", async () => {
    original = await page.locator("#display_name").inputValue();
    notes.push(`display name at start: ${JSON.stringify(original)}`);
  });

  // ---- Save button -------------------------------------------------------
  await step("SAVE: a whitespace-only edit does NOT enable Save", async () => {
    const field = page.locator("#display_name");
    await field.fill(`${original}   `);
    await page.waitForTimeout(700);
    const save = page.getByRole("button", { name: /^Save$/ });
    if (!(await save.isDisabled()))
      throw new Error(
        "Save is enabled for a change that would send nothing — the exact " +
          "state that produced a fake 'Profile updated'",
      );
  });

  await step("SAVE: a real edit saves and survives a reload", async () => {
    const wanted = `QA Name ${Date.now().toString().slice(-6)}`;
    await page.locator("#display_name").fill(wanted);
    await page.waitForTimeout(500);
    const save = page.getByRole("button", { name: /^Save$/ });
    if (await save.isDisabled()) throw new Error("Save disabled for a real change");
    await save.click();
    await page.waitForTimeout(3000);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#display_name").waitFor({ timeout: 20000 });
    await page.waitForTimeout(2500);
    const got = await page.locator("#display_name").inputValue();
    if (got !== wanted) throw new Error(`after reload: ${got} != ${wanted}`);
    notes.push(`saved and reloaded as ${JSON.stringify(got)}`);
  });

  await step("SAVE: Save is disabled again immediately after a save", async () => {
    // It used to stay enabled forever when the stored value differed only by
    // whitespace from what was typed.
    const save = page.getByRole("button", { name: /^Save$/ });
    if (!(await save.isDisabled()))
      throw new Error("Save still enabled with nothing left to save");
  });

  // ---- Avatar sync -------------------------------------------------------
  let avatarSrc = "";
  await step("AVATAR: upload a photo in Settings", async () => {
    await page.setInputFiles("#avatar_field", shot);
    await page.waitForFunction(
      () => {
        const img = document.querySelector('img[alt][class*="rounded-full"]');
        return img && /^https?:/.test(img.getAttribute("src") || "");
      },
      { timeout: 40000 },
    );
    avatarSrc = await page.evaluate(() => {
      const img = document.querySelector('img[alt][class*="rounded-full"]');
      return img ? img.getAttribute("src") : "";
    });
    if (!avatarSrc) throw new Error("no avatar rendered in Settings");
    notes.push(`settings avatar: ${avatarSrc.slice(0, 70)}…`);
  });

  await step("AVATAR: the chat rail shows the SAME photo", async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 25000 });
    await page.waitForTimeout(3500);
    const railSrc = await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Account menu"]');
      const img = btn?.querySelector("img");
      return img ? img.getAttribute("src") : null;
    });
    if (!railSrc)
      throw new Error("the account rail still renders no photo (initial only)");
    if (railSrc !== avatarSrc)
      throw new Error(`rail photo differs: ${railSrc} != ${avatarSrc}`);
    notes.push("rail photo matches Settings");
  });

  await step("AVATAR: it survives a full reload (cache is not stale)", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 25000 });
    // Read straight after paint: the cached copy is what renders first, and a
    // stale one is exactly how the old photo used to come back.
    await page.waitForTimeout(1200);
    const early = await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Account menu"]');
      const img = btn?.querySelector("img");
      return img ? img.getAttribute("src") : null;
    });
    if (early && early !== avatarSrc)
      throw new Error(`stale cached photo on reload: ${early}`);
    await page.waitForTimeout(4000);
    const late = await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Account menu"]');
      const img = btn?.querySelector("img");
      return img ? img.getAttribute("src") : null;
    });
    if (late !== avatarSrc) throw new Error(`after reload: ${late} != ${avatarSrc}`);
  });

  await step("restore the original display name", async () => {
    await page.goto(BASE + "/en/settings", { waitUntil: "domcontentloaded" });
    await page.locator("#display_name").waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.locator("#display_name").fill(original);
    await page.waitForTimeout(500);
    const save = page.getByRole("button", { name: /^Save$/ });
    if (!(await save.isDisabled())) {
      await save.click();
      await page.waitForTimeout(2500);
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
  fs.unlinkSync(shot);
  await b.close();
  process.exit(passed === results.length && uniq.length === 0 ? 0 : 1);
})();
