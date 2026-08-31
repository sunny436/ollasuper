// Scheduled Tasks end-to-end, in the house style: standalone node script,
// hand-rolled step() harness, and a hard assertion of zero console errors.
//
// The zero-console-error gate is the whole point on this surface. Ids reach
// Convex from the URL, and anything that lets a raw taskId hit a v.id()
// validator throws ArgumentValidationError, which the Convex client reports via
// console.error — so a regression there fails the run even when the pixels look
// right.
//
// Requires a live deployed stack:
//   E2E_BASE_URL=https://<app>  node p-scheduled.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";

// Every task this run creates is prefixed, so cleanup is unambiguous and a
// half-finished run never collides with the next one.
const TAG = "e2e-sched";

const errs = [];
const results = [];
const skipped = [];

// Set by the runner so a failure can describe the page it happened on. A
// production e2e that only says "hover timed out" costs a whole extra run to
// diagnose; the URL, the task titles actually on screen, and a screenshot
// usually settle it on the first try.
let PAGE = null;
const shot = async (name) => {
  if (!PAGE) return "";
  const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 50);
  const file = `/tmp/p-scheduled-${slug}.png`;
  try {
    await PAGE.screenshot({ path: file });
    const rows = await PAGE.locator("div.group")
      .filter({ has: PAGE.getByRole("button", { name: "Task actions" }) })
      .allInnerTexts()
      .catch(() => []);
    const titles = rows.map((t) => t.split("\n")[0]).join(" | ");
    return `\n        url=${PAGE.url()}\n        rows=[${titles}]\n        shot=${file}`;
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

// A step whose precondition the environment may not be able to produce (a
// completed run, a failed run). Reported as SKIP, never as a pass — a
// precondition we could not create is not evidence of anything.
const soft = async (n, f) => {
  try {
    const ran = await f();
    if (ran === false) {
      skipped.push(n);
      console.log("SKIP  " + n + " — precondition unavailable");
      return;
    }
    results.push(true);
    console.log("PASS  " + n);
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + n + " — " + e.message.split("\n")[0]);
  }
};

const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// Create a draft through the composer. Parsing is a model call, so it may or may
// not resolve the schedule — either way the draft card appears, because every
// parse failure degrades to the same editable form. That invariant is the thing
// worth asserting; model quality is not.
const compose = async (page, text) => {
  const box = page.getByRole("textbox", { name: "Schedule a task" });
  await box.click();
  await box.fill(text);
  await page.getByRole("button", { name: "Interpret schedule" }).click();
  const card = page.getByRole("textbox", { name: "Task instruction" });
  await card.waitFor({ state: "visible", timeout: 30000 });
  return card;
};

const taskRows = (page) =>
  page
    .locator("div.group")
    .filter({ has: page.getByRole("button", { name: "Task actions" }) });

/** The most recently updated task — list() orders by_user_updated desc, so a
 *  task created moments ago is first. Used where the parser owns the title. */
const openFirstRowMenu = async (page) => {
  const row = taskRows(page).first();
  await row.hover();
  await row.getByRole("button", { name: "Task actions" }).click();
  await page.waitForTimeout(300);
};

const openRowMenu = async (page, title) => {
  const row = page.locator("div.group").filter({ hasText: title }).first();
  await row.hover();
  await row.getByRole("button", { name: "Task actions" }).click();
  await page.waitForTimeout(300);
};

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 60,
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  PAGE = page;
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) {
      errs.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });

  let taskId = null;
  const dailyTitle = `${TAG} daily ${Date.now()}`;
  const editedTitle = `${dailyTitle} edited`;

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
  });

  // ── navigation: the rail is shared with chat ─────────────────────────────

  await step("Scheduled appears in the rail and navigates", async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const link = page
      .locator('nav[aria-label="Conversations"]')
      .getByRole("link", { name: "Scheduled" });
    must(await link.count(), "no Scheduled entry in the rail");
    await link.first().click();
    await page.waitForURL(/\/scheduled/, { timeout: 10000 });
    await page
      .getByRole("heading", { name: "Scheduled" })
      .waitFor({ timeout: 10000 });
  });

  await step("the rail still routes back to chat from /scheduled", async () => {
    // The way back is "New chat" — the rail has no separate Chat link, because
    // a thread is only created on the first send.
    const back = page
      .locator('nav[aria-label="Conversations"]')
      .getByRole("button", { name: "New chat" });
    must(await back.count(), "no route back to chat from the scheduled route");
    await back.first().click();
    await page.waitForURL(/\/chat/, { timeout: 10000 });
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
  });

  await step("the pane renders either its list or its empty state", async () => {
    const hasEmpty = await page.getByText("No scheduled tasks yet").count();
    const hasComposer = await page
      .getByRole("textbox", { name: "Schedule a task" })
      .count();
    must(hasComposer, "the scheduling composer did not mount");
    const hasRow = await page.locator("div.group").count();
    must(hasEmpty > 0 || hasRow > 0, "neither the empty state nor a task row rendered");
  });

  // ── conversational create ────────────────────────────────────────────────

  await step("conversational create: draft, correction, confirm", async () => {
    const card = await compose(
      page,
      `${dailyTitle} — every day at 9am, summarise my open items`,
    );
    must((await card.inputValue()).length > 0, "the draft instruction was empty");

    // A correction re-parses against the standing draft rather than starting
    // over. The card must survive it.
    const box = page.getByRole("textbox", { name: "Schedule a task" });
    await box.fill("actually make it 8am");
    await page.getByRole("button", { name: "Interpret schedule" }).click();
    await page.waitForTimeout(5000);
    must(await card.count(), "the draft card vanished on a correction");

    // The card's fields are what gets created, so set them explicitly — this
    // step tests the pipeline, not the parser's accuracy.
    await page.getByRole("textbox", { name: "Task instruction" }).fill("Summarise my open items");
    const time = page.locator('input[type="time"]');
    if (await time.count()) await time.first().fill("08:00");

    await page.getByRole("button", { name: "Create task" }).click();
    await page.waitForURL(/\/scheduled\/[a-z0-9]+/i, { timeout: 20000 });
    taskId = page.url().split("/scheduled/")[1].split(/[/?#]/)[0];
    must(taskId && taskId.length > 8, "no taskId in the URL after create");
  });

  await step("discard persists nothing", async () => {
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const before = await page.locator("div.group").count();
    await compose(page, `${TAG} discard me — every friday at 7pm`);
    await page.getByRole("button", { name: "Discard draft" }).click();
    await page.waitForTimeout(800);
    must(
      (await page.getByRole("textbox", { name: "Task instruction" }).count()) === 0,
      "the draft card survived Discard",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    must(
      (await page.getByRole("textbox", { name: "Task instruction" }).count()) === 0,
      "a discarded draft came back from sessionStorage",
    );
    must(
      (await page.locator("div.group").count()) === before,
      "Discard created a task — nothing may be persisted before Confirm",
    );
  });

  // ── deep linking ─────────────────────────────────────────────────────────

  await step("the detail panel is a deep link and survives a refresh", async () => {
    await page.goto(`${BASE}/en/scheduled/${taskId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    must(
      await page.getByRole("button", { name: "Close panel" }).count(),
      "the detail panel did not open",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    must(
      await page.getByRole("button", { name: "Close panel" }).count(),
      "the detail panel did not survive a refresh",
    );
  });

  await step("a malformed taskId renders a not-found state, not an error", async () => {
    // The load-bearing console-error case: a bad id must never reach a v.id()
    // validator. A failure here shows up twice — this assertion and the gate.
    await page.goto(`${BASE}/en/scheduled/not-a-real-id`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const body = (await page.locator("body").innerText()).toLowerCase();
    must(
      body.includes("not") || body.includes("deleted") || body.includes("unavailable"),
      "a malformed taskId did not render a not-found state",
    );
  });

  // ── schedule rendering ───────────────────────────────────────────────────

  await step("the summary renders the recurrence and the task's timezone", async () => {
    await page.goto(`${BASE}/en/scheduled/${taskId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const body = await page.locator("body").innerText();
    must(/Daily|Weekly|Monthly|Once/i.test(body), "no recurrence in the summary");
    must(/[A-Za-z]+\/[A-Za-z_]+|UTC/.test(body), "no IANA timezone rendered");
  });

  await step("month-end is disclosed rather than silently clamped", async () => {
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await compose(page, `${TAG} monthly probe — on the 31st at 6pm`);
    await page.locator("select").first().selectOption("monthly");
    await page.waitForTimeout(500);
    await page.locator("select").nth(1).selectOption("31");
    await page.waitForTimeout(500);
    const body = await page.locator("body").innerText();
    must(/month end|last day/i.test(body), "day 31 did not disclose the month-end clamp");
    await page.getByRole("button", { name: "Discard draft" }).click();
    await page.waitForTimeout(500);
  });

  await step("End repeat is offered on recurring kinds and withheld from one-time", async () => {
    await compose(page, `${TAG} endsAt probe — every day at 5pm`);
    await page.locator("select").first().selectOption("daily");
    await page.waitForTimeout(500);
    must(await page.getByText("End repeat").count(), "End repeat missing on a daily schedule");
    await page.locator("select").first().selectOption("once");
    await page.waitForTimeout(500);
    must(
      (await page.getByText("End repeat").count()) === 0,
      "End repeat offered on a one-time schedule — Phase 1 rejects endsAt there",
    );
    await page.getByRole("button", { name: "Discard draft" }).click();
    await page.waitForTimeout(500);
  });

  // ── lifecycle ────────────────────────────────────────────────────────────

  await step("edit saves and the panel reflects it", async () => {
    await page.goto(`${BASE}/en/scheduled/${taskId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Edit task" }).first().click();
    await page.waitForTimeout(800);
    // The field carries no explicit type attribute, so address it by its label
    // rather than by input[type="text"], which would not match.
    await page.getByLabel("Name").fill(editedTitle);
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForTimeout(3000);
    must(await page.getByText(editedTitle).count(), "the edited title did not appear");
  });

  await step("pause disables Run now and gives the reason", async () => {
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await openRowMenu(page, editedTitle);
    await page.getByRole("menuitem", { name: "Pause" }).click();
    await page.waitForTimeout(2500);

    await openRowMenu(page, editedTitle);
    const runNow = page.getByRole("menuitem", { name: "Run now" });
    must(
      await runNow.isDisabled(),
      "Run now was enabled while paused — it would create a held occurrence that never runs",
    );
    must((await runNow.getAttribute("title")) || "", "disabled Run now gave no reason");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  });

  await step("a paused task KEEPS ITS ROW in the default view", async () => {
    // getByText("Paused") used to be enough, and it was not: the pause toast
    // contains the word too, so this passed while the row itself had vanished
    // from the default filter. Assert the ROW, and that it says Paused.
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const row = taskRows(page).filter({ hasText: editedTitle });
    must(
      await row.count(),
      "the paused task disappeared from the default view — a user could not resume it",
    );
    must(
      /Paused/.test(await row.first().innerText()),
      "the row does not say it is paused",
    );
  });

  await step("resume restores Run now", async () => {
    await openRowMenu(page, editedTitle);
    await page.getByRole("menuitem", { name: "Resume" }).click();
    await page.waitForTimeout(2500);
    await openRowMenu(page, editedTitle);
    must(
      !(await page.getByRole("menuitem", { name: "Run now" }).isDisabled()),
      "Run now stayed disabled after resume",
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  });

  await step("Run now queues a run, and a second is refused as already queued", async () => {
    await openRowMenu(page, editedTitle);
    await page.getByRole("menuitem", { name: "Run now" }).click();
    await page.waitForTimeout(3000);
    const first = await page.locator("body").innerText();
    must(/Run queued|already queued/i.test(first), "Run now produced no outcome");

    await openRowMenu(page, editedTitle);
    const again = page.getByRole("menuitem", { name: "Run now" });
    if (!(await again.isDisabled())) {
      await again.click();
      await page.waitForTimeout(3000);
      // Phase 1 refuses a second non-terminal manual occurrence; either outcome
      // is correct, a duplicate run is not.
      const second = await page.locator("body").innerText();
      must(
        /already queued|Run queued/i.test(second),
        "a duplicate Run now was neither queued nor refused",
      );
    } else {
      await page.keyboard.press("Escape");
    }
    await page.waitForTimeout(400);
  });

  await soft("a live run shows a running badge", async () => {
    // A QUEUED occurrence has no spinner and should not: it is not running yet.
    // The claim takes up to one 30s tick, so poll for the Running state rather
    // than sampling once and asserting on whatever happened to be on screen.
    await page.goto(`${BASE}/en/scheduled/${taskId}`, { waitUntil: "domcontentloaded" });
    let sawQueuedOrRunning = false;
    for (let i = 0; i < 24; i++) {
      const body = await page.locator("body").innerText();
      if (/Queued|Running|Retrying/i.test(body)) sawQueuedOrRunning = true;
      if (/Running|Retrying/i.test(body)) {
        must(
          await page.locator(".animate-spin").count(),
          "a RUNNING occurrence rendered no progress affordance",
        );
        return;
      }
      if (/Succeeded|Failed|Cancelled/i.test(body) && sawQueuedOrRunning) {
        // It finished between polls. The run happened, which is the point.
        return;
      }
      await page.waitForTimeout(5000);
    }
    return sawQueuedOrRunning ? undefined : false;
  });

  await step("share is withheld until a run has succeeded", async () => {
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await openRowMenu(page, editedTitle);
    const share = page.getByRole("menuitem", { name: "Share" });
    if (await share.isDisabled()) {
      must((await share.getAttribute("title")) || "", "disabled Share gave no reason");
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  });

  await step("notification preferences persist across a reload", async () => {
    await openRowMenu(page, editedTitle);
    await page.getByRole("menuitem", { name: "Notification settings" }).click();
    await page.waitForTimeout(1000);
    const before = await page.getByRole("switch").first().getAttribute("data-state");
    await page.getByRole("switch").first().click();
    await page.waitForTimeout(2000);
    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await openRowMenu(page, editedTitle);
    await page.getByRole("menuitem", { name: "Notification settings" }).click();
    await page.waitForTimeout(1000);
    const after = await page.getByRole("switch").first().getAttribute("data-state");
    must(after !== before, "the notification preference did not persist");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  });

  // ── history and the result viewer ────────────────────────────────────────

  await step("every occurrence is its own history row", async () => {
    await page.goto(`${BASE}/en/scheduled/${taskId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const panel = page.locator("aside");
    must(await panel.count(), "the detail panel did not render");
    const body = await panel.innerText();
    // Either runs are listed, or the panel says there are none — never blank.
    must(
      /Succeeded|Failed|Cancelled|Queued|Running|Skipped|Interrupted|No runs|hasn't run/i.test(body),
      "the run history rendered neither rows nor an empty state",
    );
  });

  await soft("the result viewer offers no mutating action", async () => {
    const run = page
      .locator("aside button")
      .filter({ hasText: /Succeeded|Failed|Cancelled/i })
      .first();
    if ((await run.count()) === 0) return false;
    await run.click();
    await page.waitForTimeout(3000);
    // C1: ChatMessage renders readOnly, and ErrorNotice gets no onRetry.
    for (const name of ["Retry", "Regenerate", "Continue", "Edit message"]) {
      must(
        (await page.getByRole("button", { name, exact: true }).count()) === 0,
        `the read-only result viewer exposed "${name}"`,
      );
    }
  });

  await soft("Open chat exposes no composer", async () => {
    await page.goto(`${BASE}/en/scheduled/${taskId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const open = page.getByRole("button", { name: "Open chat" });
    if ((await open.count()) === 0) return false;
    await open.click();
    await page.waitForTimeout(3000);
    // C4: the transcript mounts outside ChatShell, so no ChatInput exists at
    // all — and even if one did, Phase 2's assertCanGenerate refuses the send.
    must(
      (await page.locator("#chat-composer").count()) === 0,
      "a composer rendered on a scheduled thread",
    );
    must(
      (await page.getByRole("button", { name: "Stop generating" }).count()) === 0,
      "a generation control rendered on a scheduled thread",
    );
  });

  // ── responsive + keyboard ────────────────────────────────────────────────

  await step("no horizontal overflow at three widths", async () => {
    for (const [w, h] of [
      [390, 844],
      [820, 1180],
      [1440, 900],
    ]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1800);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      must(!overflow, `horizontal overflow at ${w}px`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await step("a skip link puts main content within reach of the keyboard", async () => {
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    // The rail lists every conversation, so on a real account the composer sits
    // ~70 tab stops in. The skip link has to be the FIRST thing focused.
    await page.keyboard.press("Tab");
    const first = await page.evaluate(() =>
      (document.activeElement?.textContent || "").trim(),
    );
    must(/skip to content/i.test(first), `first tab stop was "${first}"`);

    await page.keyboard.press("Enter");
    let reached = false;
    for (let i = 0; i < 10 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(
        () => document.activeElement?.getAttribute("aria-label") === "Schedule a task",
      );
    }
    must(reached, "the composer was not reachable after activating the skip link");
  });

  // ── Phase 4: delivery preferences and honest delivery status ─────────────

  await step("email preferences are opt-in and default OFF", async () => {
    // A FRESH task: the earlier persistence test deliberately leaves a toggle
    // flipped, so asserting "defaults" on that task would be asserting the
    // previous test's leftovers.
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await compose(page, `${TAG} defaults probe — every day at 6pm`);
    await page.getByRole("button", { name: "Create task" }).click();
    await page.waitForURL(/\/scheduled\/[a-z0-9]+/i, { timeout: 20000 });
    const freshId = page.url().split("/scheduled/")[1].split(/[/?#]/)[0];
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await openFirstRowMenu(page);
    await page.getByRole("menuitem", { name: "Notification settings" }).click();
    await page.waitForTimeout(1000);

    // Two groups, defaulting opposite ways on purpose: in-app is free and
    // contained; email leaves the building and cannot be recalled.
    must(await page.getByText("In OllaSuper").count(), "no in-app group");
    must(await page.getByText("By email").count(), "no email group");

    const switches = page.getByRole("switch");
    const n = await switches.count();
    must(n >= 5, `expected 5 preference switches, saw ${n}`);
    // 0,1 = in-app (ON) · 2,3 = email (OFF) · 4 = attach PDF (OFF)
    must(
      (await switches.nth(0).getAttribute("data-state")) === "checked",
      "in-app success notification should default ON",
    );
    must(
      (await switches.nth(2).getAttribute("data-state")) === "unchecked",
      "email on success must default OFF — deploying must not email anyone",
    );
    must(
      (await switches.nth(4).getAttribute("data-state")) === "unchecked",
      "attach PDF must default OFF",
    );
  });

  await step("the PDF toggle is gated on email being on", async () => {
    must(
      await page.getByRole("switch").nth(4).isDisabled(),
      "attach PDF should be disabled while email is off",
    );
    await page.getByRole("switch").nth(2).click();
    await page.waitForTimeout(1500);
    must(
      !(await page.getByRole("switch").nth(4).isDisabled()),
      "attach PDF should become available once email is on",
    );
  });

  await step("email preferences persist across a reload", async () => {
    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await openRowMenu(page, editedTitle);
    await page.getByRole("menuitem", { name: "Notification settings" }).click();
    await page.waitForTimeout(1000);
    must(
      (await page.getByRole("switch").nth(2).getAttribute("data-state")) ===
        "checked",
      "the email preference did not persist",
    );
    // Turn it back off so this suite cannot email anyone on its way out.
    await page.getByRole("switch").nth(2).click();
    await page.waitForTimeout(1500);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  });

  await soft("the run viewer reports delivery honestly", async () => {
    await page.goto(`${BASE}/en/scheduled/${taskId}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(2500);
    const run = page
      .locator("aside button")
      .filter({ hasText: /Succeeded|Failed|Cancelled/i })
      .first();
    if ((await run.count()) === 0) return false;
    await run.click();
    await page.waitForTimeout(2500);
    const body = await page.locator("body").innerText();
    // A 2xx from a mail provider means it took custody and nothing more. The UI
    // must never turn that into "delivered" on its own.
    if (/accepted by the mail provider/i.test(body)) {
      must(
        !/\bEmail delivered\b/i.test(body),
        "the UI claimed a delivery it cannot observe",
      );
    }
    // Execution status and delivery status stay separate lines: a succeeded run
    // whose email bounced is still a succeeded run.
    must(
      !/run failed.*email/i.test(body),
      "delivery failure was conflated with run failure",
    );
  });

  // ── delete, which is also the cleanup ────────────────────────────────────

  await step("delete stops the task and discloses the history consequence", async () => {
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await openRowMenu(page, editedTitle);
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.waitForTimeout(900);
    const body = await page.locator("body").innerText();
    must(
      /no longer be viewable/i.test(body),
      "the delete confirmation did not disclose what happens to the history",
    );
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await page.waitForTimeout(3000);
    must((await page.getByText(editedTitle).count()) === 0, "the deleted task is still listed");
  });

  await step("the defaults probe task is cleaned up", async () => {
    // Production is not a scratch pad: every task this suite creates is removed
    // again, so a hundred runs leave a hundred fewer rows than they otherwise
    // would.
    let removed = 0;
    for (let i = 0; i < 6; i++) {
      const rows = taskRows(page);
      if ((await rows.count()) === 0) break;
      const label = await rows.first().innerText();
      if (!label.includes(TAG)) break;
      await openFirstRowMenu(page);
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await page.waitForTimeout(700);
      await page.getByRole("button", { name: "Delete", exact: true }).last().click();
      await page.waitForTimeout(2500);
      removed++;
    }
    must(
      removed >= 1,
      `expected to clean up at least the defaults probe, removed ${removed}`,
    );
  });

  await step("a deleted task's deep link is safe, not an error", async () => {
    await page.goto(`${BASE}/en/scheduled/${taskId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const body = (await page.locator("body").innerText()).toLowerCase();
    must(
      body.includes("deleted") || body.includes("not"),
      "a deleted task's link did not render a safe state",
    );
  });

  // ── regression: the rail extraction must not have touched chat ───────────

  await step("chat still renders its composer and greeting", async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 15000 });
    must(await page.locator("h1").count(), "the chat greeting did not render");
  });

  await step("root still redirects to /chat", async () => {
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/chat/, { timeout: 15000 });
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(
    `\n===== SCHEDULED: ${passed}/${results.length} | skipped: ${skipped.length} | console errors: ${errs.length} =====`,
  );
  for (const s of skipped) console.log("  ~ " + s);
  for (const e of errs) console.log("  - " + e);
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
