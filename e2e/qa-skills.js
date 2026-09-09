// My Skills — the management surface, end to end.
//
// WRITTEN IN PHASE 3, RUN IN PHASE 8. Nothing is deployed until then, and the
// Convex functions this drives do not exist on production yet, so running it
// now would fail for a reason that has nothing to do with the UI. It is
// committed with the phase it tests so the two cannot drift.
//
// This covers MANAGEMENT only. Whether a saved skill reaches the model is a
// runtime question and belongs to a later phase's test — a green run here means
// the user can manage skills, not that the assistant uses them.
//
//   E2E_EMAIL=... E2E_PASSWORD=... node qa-skills.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

const errs = [];
const results = [];
const notes = [];
const TAG = `QA Skill ${Date.now().toString().slice(-6)}`;

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

async function openSkills(page) {
  await page.goto(BASE + "/en/settings/skills", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "My Skills" }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(700);
}

/** The card for one skill, matched by its name. */
const card = (page, name) => page.locator("li").filter({ hasText: name }).first();

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

  await step("the sidebar has a My Skills entry that navigates", async () => {
    await page.goto(BASE + "/en/settings", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.getByRole("link", { name: "My Skills" }).click();
    await page.waitForURL(/\/settings\/skills/, { timeout: 15000 });
    await page.getByRole("heading", { name: "My Skills" }).waitFor({ timeout: 20000 });
  });

  await step("the list loads (empty state OR existing skills, never a crash)", async () => {
    await openSkills(page);
    const body = await page.evaluate(() => document.body.innerText || "");
    const empty = /You have no skills yet/i.test(body);
    const hasRows = (await page.locator("li").count()) > 0;
    if (!empty && !hasRows) throw new Error("neither an empty state nor a list");
    notes.push(empty ? "started from the empty state" : "started with existing skills");
  });

  await step("validation: Create stays disabled until name AND instructions exist", async () => {
    await page.getByRole("button", { name: /^New skill$/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 15000 });
    const submit = dialog.getByRole("button", { name: /^Create skill$/ });
    if (!(await submit.isDisabled()))
      throw new Error("Create enabled on an empty form");
    await dialog.getByLabel("Name").fill(TAG);
    await page.waitForTimeout(300);
    if (!(await submit.isDisabled()))
      throw new Error("Create enabled with a name but no instructions");
    // Whitespace is not content.
    await dialog.getByLabel("Instructions").fill("   ");
    await page.waitForTimeout(300);
    if (!(await submit.isDisabled()))
      throw new Error("Create enabled on whitespace-only instructions");
  });

  await step("the server refuses a secret, and says why, without closing", async () => {
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Instructions")
      .fill("Use this key: sk-ABCDEFGHIJKLMNOPQRSTUV when you call the API.");
    await page.waitForTimeout(300);
    await dialog.getByRole("button", { name: /^Create skill$/ }).click();
    await page.waitForTimeout(2500);
    const shown = await dialog.innerText();
    if (!/secret/i.test(shown))
      throw new Error("no server reason shown: " + shown.slice(0, 160));
    // The dialog must stay open with the text intact — losing it would be worse
    // than the error.
    const kept = await dialog.getByLabel("Instructions").inputValue();
    if (!kept.includes("sk-")) throw new Error("the user's text was discarded");
    notes.push("secret refused in place, text preserved");
  });

  await step("create succeeds and the skill appears", async () => {
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Instructions")
      .fill("Read the contract end to end. Flag every ambiguous clause.");
    await dialog.getByLabel("Description").fill("For supplier contracts.");
    await page.waitForTimeout(300);
    await dialog.getByRole("button", { name: /^Create skill$/ }).click();
    await page.waitForTimeout(3000);
    await openSkills(page);
    await card(page, TAG).waitFor({ timeout: 15000 });
  });

  await step("it survives a full reload", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "My Skills" }).waitFor({ timeout: 25000 });
    await card(page, TAG).waitFor({ timeout: 15000 });
  });

  await step("edit changes it and persists", async () => {
    await card(page, TAG).getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    // The form must open PRE-FILLED, not blank.
    if ((await dialog.getByLabel("Name").inputValue()) !== TAG)
      throw new Error("edit did not pre-fill the existing skill");
    await dialog.getByLabel("Description").fill("Edited description.");
    await page.waitForTimeout(300);
    await dialog.getByRole("button", { name: /^Save changes$/ }).click();
    await page.waitForTimeout(3000);
    await openSkills(page);
    const text = await card(page, TAG).innerText();
    if (!/Edited description/i.test(text))
      throw new Error("the edit did not persist: " + text.slice(0, 120));
  });

  await step("disable then enable, and the body is never lost", async () => {
    const row = card(page, TAG);
    await row.getByRole("switch").click();
    await page.waitForTimeout(2500);
    await openSkills(page);
    if (!/Off/i.test(await card(page, TAG).innerText()))
      throw new Error("disabling did not persist");

    await card(page, TAG).getByRole("switch").click();
    await page.waitForTimeout(2500);
    await openSkills(page);
    if (/\bOff\b/i.test(await card(page, TAG).innerText()))
      throw new Error("re-enabling did not persist");

    // Disabled means IGNORED, not erased — the instructions must still be there.
    await card(page, TAG).getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    const body = await dialog.getByLabel("Instructions").inputValue();
    if (!body.includes("ambiguous")) throw new Error("the skill body was lost");
    await dialog.getByRole("button", { name: /^Cancel$/ }).click();
    await page.waitForTimeout(500);
  });

  await step("delete asks first, and says what deleting means", async () => {
    await openSkills(page);
    await card(page, TAG).getByRole("button", { name: "Delete" }).click();
    const confirm = page.getByRole("dialog");
    await confirm.waitFor({ timeout: 15000 });
    const copy = await confirm.innerText();
    if (!/cannot be undone/i.test(copy))
      throw new Error("the confirmation does not say it is permanent");
    if (!/next message/i.test(copy))
      throw new Error("the confirmation does not say when it stops being used");
    await confirm.getByRole("button", { name: /^Delete$/ }).click();
    await page.waitForTimeout(3000);
    await openSkills(page);
    if ((await card(page, TAG).count()) > 0)
      throw new Error("the skill is still listed after deletion");
  });

  await step("the composer's Skills menu points at My Skills", async () => {
    // The two surfaces share a word; this is the line that stops someone
    // hunting the capability menu for a skill they wrote.
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 25000 });
    await page.getByRole("button", { name: "Skills" }).first().click();
    await page.waitForTimeout(1200);
    const link = page.getByRole("menuitem", { name: /My Skills/i });
    if ((await link.count()) === 0)
      throw new Error("no link from the capability menu to My Skills");
    await page.keyboard.press("Escape");
  });

  await step("signed out, the page does not expose skills", async () => {
    const anon = await b.newContext();
    const p2 = await anon.newPage();
    await p2.goto(BASE + "/en/settings/skills", { waitUntil: "domcontentloaded" });
    await p2.waitForTimeout(3000);
    if (!/login/.test(p2.url()))
      throw new Error("the skills page rendered for a signed-out visitor");
    await anon.close();
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
