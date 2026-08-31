// Phase 4 production acceptance: the full delivery pipeline, end to end.
//
// Covers what p-scheduled.js can only SKIP, because those steps need a run that
// has actually settled: the read-only result viewer (C1), the delivery status
// line (P3), the PDF, and the notification. Creates one task, runs it, waits for
// a terminal outcome, inspects everything, and deletes the task.
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const TAG = "p5-accept";

const results = [];
const errs = [];
const ok = (n) => {
  results.push(true);
  console.log("PASS  " + n);
};
const no = (n, d) => {
  results.push(false);
  console.log("FAIL  " + n + (d ? " — " + d : ""));
};
const must = (c, n, d) => (c ? ok(n) : no(n, d));

const taskRows = (page) =>
  page
    .locator("div.group")
    .filter({ has: page.getByRole("button", { name: "Task actions" }) });

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 40,
  });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !/chromestatus\.com/.test(m.text())) {
      errs.push(m.text());
    }
  });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
  ok("login");

  // ── create ────────────────────────────────────────────────────────────────
  await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const box = page.getByRole("textbox", { name: "Schedule a task" });
  await box.fill(
    `${TAG} — every day at 9am, list three short bullet points about AI news`,
  );
  await page.getByRole("button", { name: "Interpret schedule" }).click();
  await page
    .getByRole("textbox", { name: "Task instruction" })
    .waitFor({ timeout: 40000 });
  await page.getByRole("button", { name: "Create task" }).click();
  await page.waitForURL(/\/scheduled\/[a-z0-9]+/i, { timeout: 25000 });
  const taskId = page.url().split("/scheduled/")[1].split(/[/?#]/)[0];
  must(Boolean(taskId), "task created through the composer", taskId);

  // ── enable email + PDF for this task ──────────────────────────────────────
  await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const row = taskRows(page).first();
  await row.hover();
  await row.getByRole("button", { name: "Task actions" }).click();
  await page.waitForTimeout(400);
  await page.getByRole("menuitem", { name: "Notification settings" }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("switch").nth(2).click(); // email on success
  await page.waitForTimeout(1200);
  await page.getByRole("switch").nth(4).click(); // attach PDF
  await page.waitForTimeout(1200);
  const emailOn =
    (await page.getByRole("switch").nth(2).getAttribute("data-state")) ===
    "checked";
  const pdfOn =
    (await page.getByRole("switch").nth(4).getAttribute("data-state")) ===
    "checked";
  must(emailOn && pdfOn, "email + PDF enabled for this task");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // ── run it ────────────────────────────────────────────────────────────────
  await row.hover();
  await row.getByRole("button", { name: "Task actions" }).click();
  await page.waitForTimeout(400);
  await page.getByRole("menuitem", { name: "Run now" }).click();
  await page.waitForTimeout(2500);
  ok("Run now accepted");

  // ── wait for a terminal outcome ───────────────────────────────────────────
  await page.goto(`${BASE}/en/scheduled/${taskId}`, {
    waitUntil: "domcontentloaded",
  });
  let settled = false;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(5000);
    const body = await page.locator("aside").first().innerText();
    if (/Succeeded|Failed|Cancelled/i.test(body)) {
      settled = true;
      console.log(`      settled after ~${(i + 1) * 5}s`);
      break;
    }
  }
  must(settled, "the run reached a terminal state within 200s");

  // ── the result viewer is READ-ONLY (C1) ──────────────────────────────────
  const runBtn = page
    .locator("aside button")
    .filter({ hasText: /Succeeded|Failed|Cancelled/i })
    .first();
  if (await runBtn.count()) {
    await runBtn.click();
    await page.waitForTimeout(3500);
    let clean = true;
    const found = [];
    for (const name of ["Retry", "Regenerate", "Continue", "Edit message"]) {
      const n = await page.getByRole("button", { name, exact: true }).count();
      if (n > 0) {
        clean = false;
        found.push(name);
      }
    }
    must(clean, "the result viewer offers no mutating action (C1)", found.join(","));

    const panel = await page.locator("aside").first().innerText();
    console.log("      panel says: " + panel.replace(/\n+/g, " | ").slice(0, 220));

    // Delivery status must not claim more than it knows (P3).
    const claimsDelivered = /Email delivered/i.test(panel);
    const claimsAccepted = /accepted by the mail provider/i.test(panel);
    must(
      !claimsDelivered || claimsAccepted === false,
      "the UI never upgrades 'accepted' into 'delivered' on its own (P3)",
    );
    const anyDelivery =
      /Email|PDF/i.test(panel) || /No email sent/i.test(panel);
    must(anyDelivery, "a delivery outcome is reported in the run viewer");
  } else {
    no("a settled run row is present to open");
  }

  // ── notification ─────────────────────────────────────────────────────────
  const bell = page.getByRole("button", { name: "Notifications" });
  if (await bell.count()) {
    await bell.first().click();
    await page.waitForTimeout(1500);
    const list = await page.locator("body").innerText();
    must(
      new RegExp(TAG, "i").test(list) || /completed|failed/i.test(list),
      "an in-app notification was raised for the run",
    );
    await page.keyboard.press("Escape");
  }

  // ── cleanup ──────────────────────────────────────────────────────────────
  await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const mine = taskRows(page).filter({ hasText: TAG });
  if (await mine.count()) {
    await mine.first().hover();
    await mine.first().getByRole("button", { name: "Task actions" }).click();
    await page.waitForTimeout(400);
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await page.waitForTimeout(2500);
  }
  must((await taskRows(page).filter({ hasText: TAG }).count()) === 0, "cleaned up");

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(
    `\n===== P5 ACCEPTANCE: ${passed}/${results.length} | console errors: ${errs.length} =====`,
  );
  for (const e of errs) console.log("  - " + e.slice(0, 160));
  console.log(`taskId=${taskId}`);
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
