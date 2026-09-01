// The Scheduled Tasks UX audit, asked of the REAL deployment.
//
// The timezone half of this can only be reproduced from a browser whose zone is
// NOT in Intl.supportedValuesOf("timeZone"). That list holds ICU-CANONICAL ids:
// it contains "Asia/Calcutta" but not "Asia/Kolkata", not "UTC", and its first
// entry is "Africa/Abidjan". A <select> whose value matches no <option> falls
// back to selectedIndex 0 — and Africa/Abidjan is UTC+0, so it looks plausible
// enough not to be questioned. Hence the report: an 8 AM task whose dropdown
// read Africa/Abidjan while the summary beside it read "Kolkata".
//
// So the context below pins a zone that is ABSENT from that list. Measured in
// this Chromium: `UTC` resolves to `UTC` and is not in the 418-entry list, so a
// UTC browser stores a task the picker cannot display — and production holds
// exactly those rows. Asia/Kolkata would do too, except this engine
// canonicalises it to Asia/Calcutta in resolvedOptions(), which IS in the list;
// running from a canonical zone proves nothing, since it displays correctly
// with or without the fix.
//
//   OLLASTACK_MAIL_TOKEN=... OLLASTACK_E2E_MAILBOX_ID=... node p-sched-ux.js

const { chromium } = require("playwright");
const ollastack = require("./_lib/ollastack");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const ZONE = process.env.E2E_TZ || "UTC";
const PW = "SchedUX#2026";

const errs = [];
const results = [];
const step = (ok, name, detail) => {
  results.push([ok, name, detail || ""]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const taskRows = (page) =>
  page
    .locator("div.group")
    .filter({ has: page.getByRole("button", { name: "Task actions" }) });

/** Choose a value from the Active/Paused/All filter menu. */
async function pickFilter(page, label) {
  await page
    .getByRole("button", { name: /^(Active|Paused|All)$/ })
    .first()
    .click();
  await page.waitForTimeout(300);
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  await page.waitForTimeout(1500);
}

(async () => {
  if (!ollastack.enabled()) {
    console.log("SKIP: needs OLLASTACK_MAIL_TOKEN + OLLASTACK_E2E_MAILBOX_ID");
    process.exit(1);
  }
  const email = ollastack.taggedAddress(
    await ollastack.mailboxAddress(),
    ollastack.newTag(),
  );
  console.log(`address: ${email}   browser zone: ${ZONE}`);

  const b = await chromium.launch({ headless: false, slowMo: 90 });
  const ctx = await b.newContext({
    viewport: { width: 1440, height: 900 },
    timezoneId: ZONE,
  });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !/chromestatus\.com/.test(m.text())) {
      errs.push(m.text());
    }
  });

  try {
    // ── register ────────────────────────────────────────────────────────────
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.click('button:has-text("Create an account")');
    await page.fill('input[name="name"]', "Sched UX");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[name="code"]', { timeout: 20000 });
    const code = await ollastack.codeForAddress(email, "verification", 120000);
    if (!code) throw new Error("no verification code arrived");
    await page.fill('input[name="code"]', code);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/chat/, { timeout: 60000 });

    // Confirm the browser really is in the zone this test depends on.
    const seen = await page.evaluate(
      () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    step(seen === ZONE, "the browser reports the intended zone", seen);

    // ── create a task ───────────────────────────────────────────────────────
    await page.goto(`${BASE}/en/scheduled`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const box = page.getByRole("textbox", { name: "Schedule a task" });
    await box.click();
    await box.fill("Every day at 8 AM, write one sentence about the weather.");
    await page.getByRole("button", { name: "Interpret schedule" }).click();
    await page
      .getByRole("textbox", { name: "Task instruction" })
      .waitFor({ state: "visible", timeout: 45000 });
    await page.getByRole("button", { name: "Create task" }).click();
    await page.waitForTimeout(4000);
    step(await taskRows(page).count(), "a task was created");

    // ── THE BUG: the picker must show the task's own zone ───────────────────
    const row = taskRows(page).first();
    const openEdit = async () => {
      await row.hover();
      await row.getByRole("button", { name: "Edit task" }).click();
      await page.waitForTimeout(1800);
    };
    await openEdit();

    const tzSelect = page.locator('[role="dialog"] select').nth(1);
    const shown = await tzSelect.inputValue();
    step(
      shown === ZONE,
      "the timezone picker shows the task's own zone",
      `select reads "${shown}"`,
    );
    step(
      shown !== "Africa/Abidjan",
      "the picker did NOT fall back to option zero",
      shown,
    );
    const summary = await page.locator('[role="dialog"]').innerText();
    const shortZ = ZONE.split("/").pop().replace(/_/g, " ");
    step(
      new RegExp(shortZ).test(summary),
      "the summary line agrees with the picker",
      (summary.match(/Daily at [^\n]*/) || ["(none)"])[0],
    );

    // Saving without touching the dropdown must not rewrite the stored zone.
    await page.locator('[role="dialog"] textarea').first().fill(
      "Every day at 8 AM, write one sentence about the weather. Keep it short.",
    );
    await page.getByRole("button", { name: /^Save$/ }).click();
    await page.waitForTimeout(3000);
    await openEdit();
    const after = await page.locator('[role="dialog"] select').nth(1).inputValue();
    step(after === ZONE, "an unrelated edit did not rewrite the zone", after);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);

    // ── Open chat must be gone ──────────────────────────────────────────────
    await taskRows(page).first().click();
    await page.waitForTimeout(2500);
    step(
      (await page.getByRole("button", { name: "Open chat" }).count()) === 0,
      "the Open chat action is gone",
    );

    // ── Active / Paused isolation ───────────────────────────────────────────
    await page.goto(`${BASE}/en/scheduled`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const first = taskRows(page).first();
    await first.hover();
    await first.getByRole("button", { name: "Task actions" }).click();
    await page.waitForTimeout(400);
    await page.getByRole("menuitem", { name: /^Pause$/ }).click();
    await page.waitForTimeout(2500);
    // The filter should have moved to All so the row is still reachable.
    step(
      await taskRows(page).count(),
      "a task paused from the row menu stays on screen",
    );

    await page.goto(`${BASE}/en/scheduled`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    step(
      (await taskRows(page).count()) === 0,
      "a PAUSED task does not appear under Active",
      `${await taskRows(page).count()} row(s)`,
    );
    await pickFilter(page, "Paused");
    step(await taskRows(page).count(), "it does appear under Paused");
    await pickFilter(page, "All");
    step(await taskRows(page).count(), "it does appear under All");

    // Resume, so the run below can happen.
    const back = taskRows(page).first();
    await back.hover();
    await back.getByRole("button", { name: "Task actions" }).click();
    await page.waitForTimeout(400);
    await page.getByRole("menuitem", { name: /^Resume$/ }).click();
    await page.waitForTimeout(2500);
    await pickFilter(page, "Active");
    step(
      await taskRows(page).count(),
      "a resumed task returns to Active",
    );

    // ── run it, then open the result modal ──────────────────────────────────
    const live = taskRows(page).first();
    await live.hover();
    await live.getByRole("button", { name: "Task actions" }).click();
    await page.waitForTimeout(400);
    await page.getByRole("menuitem", { name: /Run now/i }).click();
    await page.waitForTimeout(2000);
    await taskRows(page).first().click();
    await page.waitForTimeout(3000);

    let runBtn = null;
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(5000);
      const candidate = page
        .locator("aside button")
        .filter({ hasText: /Completed|Failed|Cancelled/i })
        .first();
      if (await candidate.count()) {
        runBtn = candidate;
        break;
      }
    }
    if (!runBtn) {
      step(false, "a run finished within two minutes");
    } else {
      const before = page.url();
      await runBtn.click();
      await page.waitForTimeout(3500);
      const dialog = page.locator('[role="dialog"]');
      step(await dialog.count(), "clicking a run opens a dialog");
      step(
        new URL(page.url()).pathname === new URL(before).pathname,
        "opening the run did not navigate away",
        page.url(),
      );
      const text = await dialog.innerText();
      step(
        !/\bDone\b\s*·\s*\d+\s*steps?/i.test(text),
        "the modal shows no agent step count",
      );
      step(
        !/\bRan\b\s*[“"]/.test(text),
        "the modal does not restate the prompt",
      );
      // The run header must read in the task's zone, not UTC.
      step(
        /Scheduled/.test(text),
        "the modal carries the run's status header",
      );
      // Close by the X, and confirm we are still on Scheduled Tasks.
      await page
        .locator('[role="dialog"] button')
        .last()
        .click()
        .catch(() => {});
      await page.keyboard.press("Escape");
      await page.waitForTimeout(1500);
      step(
        (await page.locator('[role="dialog"]').count()) === 0 &&
          /\/scheduled/.test(page.url()),
        "closing the modal stays on Scheduled Tasks",
        page.url(),
      );
    }
  } catch (e) {
    step(false, "unexpected failure", String(e.message ?? e).slice(0, 220));
  } finally {
    await b.close();
  }

  step(errs.length === 0, "zero console errors", errs.slice(0, 3).join(" | "));

  const pass = results.filter((r) => r[0]).length;
  console.log(`\n===== SCHEDULED UX: ${pass}/${results.length} =====`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
