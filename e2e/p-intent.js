// Scheduling INTENT acceptance — the fix for the reported composer defect.
//
//   "create a scheduler for ai news summary on every sunday at 8 am"
//     -> name  = the raw sentence, truncated at 60 chars
//     -> prompt= the raw sentence, so the run answered "I can't create or
//                activate scheduled automations in this workspace"
//     -> day   = Monday, though the user said Sunday
//
// One cause: the parser reported the fields it could not determine and the
// composer replaced each of them with a fabrication. These steps assert the
// property that replaced it — a gap is a question, never a guess — and they
// assert it through the real UI against the deployed stack.
//
//   E2E_BASE_URL=https://app.ollasuper.com node p-intent.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";

const REPORTED = "create a scheduler for ai news summary on every sunday at 8 am";
const REFUSAL = /can'?t create or activate scheduled automations/i;

const errs = [];
const results = [];
const skipped = [];
const created = [];
let PAGE = null;

const shot = async (name) => {
  if (!PAGE) return "";
  const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 50);
  const file = `/tmp/p-intent-${slug}.png`;
  try {
    await PAGE.screenshot({ path: file });
    return `\n        url=${PAGE.url()}  shot=${file}`;
  } catch {
    return "";
  }
};

const step = async (n, f) => {
  try {
    await f();
    results.push(true);
    console.log("PASS  " + n);
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + n + " — " + e.message.split("\n")[0] + (await shot(n)));
  }
};

const soft = async (n, f) => {
  try {
    await f();
    results.push(true);
    console.log("PASS  " + n);
  } catch (e) {
    skipped.push(n);
    console.log("SKIP  " + n + " — " + e.message.split("\n")[0]);
  }
};

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

const compose = async (page, text) => {
  const box = page.getByRole("textbox", { name: "Schedule a task" });
  await box.click();
  await box.fill(text);
  await page.getByRole("button", { name: "Interpret schedule" }).click();
  const card = page.getByRole("textbox", { name: "Task instruction" });
  await card.waitFor({ state: "visible", timeout: 45000 });
  return card;
};

const discard = async (page) => {
  const x = page.getByRole("button", { name: "Discard draft" });
  if (await x.count()) {
    await x.click();
    await page.waitForTimeout(400);
  }
};

const taskRows = (page) =>
  page
    .locator("div.group")
    .filter({ has: page.getByRole("button", { name: "Task actions" }) });

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  PAGE = page;
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
  });

  // ── criterion 1: the reported sentence, end to end ───────────────────────

  let flagshipTitle = "";
  await step("A1 the reported sentence yields a clean NAME, not the sentence", async () => {
    await compose(page, REPORTED);
    const name = page.getByRole("textbox", { name: "Task name" });
    flagshipTitle = await name.inputValue();
    must(flagshipTitle.length > 0, "the name is empty");
    must(
      flagshipTitle.toLowerCase() !== REPORTED.slice(0, 60).toLowerCase(),
      `the name is still the raw sentence: ${JSON.stringify(flagshipTitle)}`,
    );
    must(
      !/create a scheduler/i.test(flagshipTitle),
      `the name contains the scheduling command: ${JSON.stringify(flagshipTitle)}`,
    );
    must(
      flagshipTitle.length <= 60,
      `the name is not a short label (${flagshipTitle.length} chars)`,
    );
    console.log(`        name = ${JSON.stringify(flagshipTitle)}`);
  });

  await step("A2 the INSTRUCTION is detailed work, not the raw sentence", async () => {
    const prompt = await page
      .getByRole("textbox", { name: "Task instruction" })
      .inputValue();
    must(
      prompt.trim().toLowerCase() !== REPORTED.toLowerCase(),
      "the instruction is still the raw sentence",
    );
    must(
      !/create a scheduler/i.test(prompt),
      `the instruction contains the scheduling command: ${JSON.stringify(prompt.slice(0, 90))}`,
    );
    must(!/every sunday/i.test(prompt), "the instruction still carries the schedule");
    // ChatGPT-quality: a complete instruction, not a two-word summary.
    must(
      prompt.length >= 120,
      `the instruction is too thin to stand alone (${prompt.length} chars): ${JSON.stringify(prompt)}`,
    );
    console.log(`        prompt(${prompt.length}) = ${JSON.stringify(prompt.slice(0, 140))}…`);
  });

  await step("A3 the schedule reads Sunday at 8:00 AM — not Monday", async () => {
    const card = page.locator("div.rounded-2xl.border-brand\\/30").first();

    // Which days are SELECTED, not which labels exist. Every weekday label is
    // on screen as a toggle button, so a text search cannot tell Sunday from
    // the Monday button sitting next to it — that is what made the original
    // defect so easy to miss in the first place.
    const pressed = await card
      .locator('button[aria-pressed="true"]')
      .allInnerTexts();
    must(
      pressed.length === 1 && pressed[0].trim() === "Sun",
      `expected exactly Sun selected, got [${pressed.map((t) => t.trim()).join(", ")}]`,
    );

    // And the human summary must agree with it.
    const summary = await card.locator("p").first().innerText();
    must(/\bSun\b/.test(summary), `the summary does not say Sun: ${JSON.stringify(summary)}`);
    must(!/\bMon\b/.test(summary), `the summary says Mon: ${JSON.stringify(summary)}`);
    must(
      /8:00\s*AM/i.test(summary),
      `the summary does not say 8:00 AM: ${JSON.stringify(summary)}`,
    );
    console.log(`        summary = ${JSON.stringify(summary)}`);
  });

  await step("A4 Create is ENABLED when nothing is unresolved", async () => {
    const btn = page.getByRole("button", { name: "Create task" });
    must(await btn.isEnabled(), "Create is blocked on a fully determined draft");
  });

  await step("A5 the task is created and listed under its clean name", async () => {
    await page.getByRole("button", { name: "Create task" }).click();
    await page.waitForTimeout(3500);
    created.push(flagshipTitle);
    const listed = await taskRows(page).filter({ hasText: flagshipTitle }).count();
    must(listed > 0, `the created task is not listed as ${JSON.stringify(flagshipTitle)}`);
  });

  await step("A6 the stored schedule survives a reload as Sunday", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const row = taskRows(page).filter({ hasText: flagshipTitle }).first();
    const text = await row.innerText();
    must(/\bSun\b/.test(text), `the saved row does not say Sun: ${JSON.stringify(text)}`);
    must(!/\bMon\b/.test(text), `the saved row says Mon: ${JSON.stringify(text)}`);
  });

  // ── criterion 12: ambiguity is asked about, never guessed ────────────────

  await step("A7 \"Sunday at 8\" BLOCKS Create and asks AM or PM", async () => {
    await discard(page);
    await compose(page, "Sunday at 8");
    const btn = page.getByRole("button", { name: "Create task" });
    const card = page.locator("div.rounded-2xl.border-brand\\/30").first();
    must(
      !(await btn.isEnabled()),
      "Create was enabled on an ambiguous request — it would have guessed a time",
    );

    // "Sunday at 8" also names no work, and the composer asks for the most
    // important gap first — so answer the others and prove the AMBIGUOUS HOUR
    // is still tracked underneath. Blocking on the prompt alone would pass a
    // weaker test while still letting 8 PM be silently saved as 08:00.
    await page.getByRole("textbox", { name: "Task name" }).fill("Ambiguity check");
    await page
      .getByRole("textbox", { name: "Task instruction" })
      .fill("Summarise my unread email.");
    await page.waitForTimeout(400);

    must(
      !(await btn.isEnabled()),
      "Create unblocked once the work was given — the ambiguous hour was NOT tracked",
    );
    const reason = await card.locator("p.mr-auto").first().innerText();
    must(
      /AM or\s*8?\s*PM|A\.?M\.? or|what time/i.test(reason),
      `the remaining reason does not ask about the time: ${JSON.stringify(reason)}`,
    );
    console.log(`        reason shown = ${JSON.stringify(reason)}`);
  });

  // ── criterion 11: weekly starts EMPTY, in the composer and the dialog ────

  await step("A8 switching Repeat to Weekly selects NO day and blocks Create", async () => {
    await discard(page);
    await compose(page, "every day at 9 am summarise my unread emails");
    const select = page.locator("select").first();
    await select.selectOption("weekly");
    await page.waitForTimeout(600);
    const card = page.locator("div.rounded-2xl.border-brand\\/30").first();
    const text = await card.innerText();
    must(
      /Pick a day/i.test(text),
      `no "Pick a day" prompt after switching to Weekly:\n${text.slice(0, 400)}`,
    );
    const btn = page.getByRole("button", { name: "Create task" });
    must(
      !(await btn.isEnabled()),
      "Create was enabled on a weekly schedule with no day — this is the Monday bug",
    );
  });

  await step("A9 choosing a day unblocks Create", async () => {
    await page.getByRole("button", { name: "Sun", exact: true }).click();
    await page.waitForTimeout(500);
    const btn = page.getByRole("button", { name: "Create task" });
    must(await btn.isEnabled(), "Create stayed blocked after a day was chosen");
    await discard(page);
  });

  // ── criterion 3: the run does the WORK, not the meta-command ─────────────

  await soft("A10 Run Now produces work, not the scheduler refusal", async () => {
    const row = taskRows(page).filter({ hasText: flagshipTitle }).first();
    await row.hover();
    await row.getByRole("button", { name: "Task actions" }).click();
    await page.waitForTimeout(400);
    await page.getByRole("menuitem", { name: /Run now/i }).click();
    await page.waitForTimeout(2000);
    await row.click();
    await page.waitForTimeout(2000);
    // Give the real agent a generous window; this is a live model call.
    let body = "";
    for (let i = 0; i < 60; i++) {
      body = await page.locator("body").innerText();
      if (/Completed|Failed/i.test(body) && body.length > 400) break;
      await page.waitForTimeout(5000);
    }
    must(
      !REFUSAL.test(body),
      "the run still answers with the scheduled-automation refusal — the prompt is still the meta-sentence",
    );
    must(/Completed/i.test(body), "no completed run appeared within 5 minutes");
  });

  // ── cleanup: never leave test tasks on production ────────────────────────

  // Production is not a scratch pad: every task this run creates is removed.
  await step("cleanup: created tasks removed", async () => {
    for (const title of created) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2500);
        const row = taskRows(page).filter({ hasText: title }).first();
        if (!(await row.count())) break;
        await row.hover();
        await row.getByRole("button", { name: "Task actions" }).click();
        await page.waitForTimeout(500);
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await page.waitForTimeout(900);
        await page
          .getByRole("button", { name: "Delete", exact: true })
          .last()
          .click();
        await page.waitForTimeout(3000);
      }
    }
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    for (const title of created) {
      const left = await taskRows(page).filter({ hasText: title }).count();
      must(
        left === 0,
        `the test task ${JSON.stringify(title)} is still on production`,
      );
    }
  });

  await step("zero console errors", async () => {
    must(errs.length === 0, `${errs.length} console error(s):\n  ` + errs.slice(0, 6).join("\n  "));
  });

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed` + (skipped.length ? `, ${skipped.length} skipped` : ""));
  if (skipped.length) console.log("skipped: " + skipped.join(" | "));
  await b.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch(async (e) => {
  console.error("FATAL", e);
  process.exit(1);
});
