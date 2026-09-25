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
const PASSWORD = require("./creds").adminPassword();

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
// Every parse's wall time, printed at the end: the only way to tell a slow
// model tail from a broken composer when the card is late.
const parseMs = [];
const compose = async (page, text) => {
  const box = page.getByRole("textbox", { name: "Schedule a task" });
  await box.click();
  await box.fill(text);
  const t0 = Date.now();
  await page.getByRole("button", { name: "Interpret schedule" }).click();
  const card = page.getByRole("textbox", { name: "Task instruction" });
  try {
    await card.waitFor({ state: "visible", timeout: 30000 });
  } finally {
    parseMs.push(Date.now() - t0);
  }
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
  // Chrome reports some of its OWN policy decisions at console.error level.
  // The beforeunload one fires because Playwright reloads without a preceding
  // user gesture — it is Chrome saying it suppressed a dialog, links to
  // chromestatus.com, and originates in no application code (we register no
  // beforeunload handler anywhere). Counting it would mean the gate fails on
  // browser behaviour instead of on ours. Narrow by design: anything without a
  // chromestatus.com citation still counts.
  const BROWSER_NOTICE = /chromestatus\.com/;
  page.on("console", (m) => {
    if (m.type() === "error" && !BROWSER_NOTICE.test(m.text())) {
      errs.push(m.text());
    }
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) {
      errs.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });

  let taskId = null;
  // The Phase 4 defaults probe, opened BY NAME. It used to be opened as "the
  // first row", on the theory that the newest task sorts first — but the list
  // is ordered by updatedAt, and finishing the earlier "Run now" bumps the main
  // task's updatedAt (occurrences.ts, finalize). Whenever that run landed after
  // the probe was created, the main task jumped to the top and these steps
  // opened IT — the task whose in-app switch an earlier step deliberately
  // flipped. That was the flake: 3 failures in 3 runs on 2026-09-25, each one
  // a different symptom of opening the wrong task.
  let probeTitle = null;
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
    //
    // The NAME is set here too. The parser now writes a real label ("Daily AI
    // News Bullet Points") instead of echoing the request, so a title can no
    // longer be relied on to carry TAG — and cleanup finds this suite's rows
    // by TAG.
    await page.getByRole("textbox", { name: "Task name" }).fill(`${TAG} pipeline`);
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
    // scheduleSummary() prints shortZone(spec.timezone) — "Kolkata", not
    // "Asia/Kolkata" — on purpose, so the line reads as a place rather than a
    // database key. Derive the same short form the composer defaulted to.
    const zone = await page.evaluate(() => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      return (tz.split("/").pop() ?? tz).replace(/_/g, " ");
    });
    must(body.includes(zone), `the summary does not name the task's zone ("${zone}")`);
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

  await step("the filters isolate Active from Paused", async () => {
    // This step asserted the OPPOSITE until the Scheduled Tasks audit: that a
    // paused task "KEEPS ITS ROW in the default view". It did, because Active
    // was defined as active-or-paused plus a fallback that showed everything
    // when the live set was empty. That made the filter lie about the one
    // thing a status filter exists to report.
    //
    // The concern behind it was real — pause is triggered from this list's row
    // menu, so a vanishing row is a task you cannot resume — and it is now
    // answered by TaskRow moving the filter to "All" on a successful pause,
    // covered separately below. On a FRESH load the default filter is Active,
    // and a paused task must not be in it.
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const pick = async (label) => {
      await page
        .getByRole("button", { name: /^(Active|Paused|All)$/ })
        .first()
        .click();
      await page.waitForTimeout(300);
      await page.getByRole("menuitem", { name: label, exact: true }).click();
      await page.waitForTimeout(1200);
    };

    const row = () => taskRows(page).filter({ hasText: editedTitle });

    must(
      (await row().count()) === 0,
      "a PAUSED task appeared under the Active filter",
    );

    await pick("Paused");
    must(
      await row().count(),
      "the paused task is missing from the Paused filter",
    );
    must(
      /Paused/.test(await row().first().innerText()),
      "the row does not say it is paused",
    );

    await pick("All");
    must(await row().count(), "the paused task is missing from All");

    // Leave the view on All so the later steps can still find the row.
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
      // The RUN ROWS' status labels, not the whole page: a case-insensitive
      // /Running/i over body text matched the sentence "This task is not
      // running: …" and failed 2 of 3 runs with a spinner that was never
      // supposed to be there. A run row's label is its first word.
      const labels = (await page.locator("aside button").allInnerTexts()).map((t) => t.trim());
      const has = (re) => labels.some((l) => re.test(l));
      if (has(/^(Queued|Running|Retrying)\b/)) sawQueuedOrRunning = true;
      if (has(/^(Running|Retrying)\b/)) {
        must(
          await page.locator("aside .animate-spin").count(),
          "a RUNNING occurrence rendered no progress affordance",
        );
        return;
      }
      if (has(/^(Completed|Failed|Cancelled)\b/) && sawQueuedOrRunning) {
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
    await page.goto(`${BASE}/en/scheduled/${taskId}`, {
      waitUntil: "domcontentloaded",
    });
    const panel = page.locator("aside");
    await panel.first().waitFor({ timeout: 15000 });

    // Poll rather than sampling once: history and activeRun are two separate
    // subscriptions, and while both are still resolving the panel shows a
    // skeleton that is legitimately neither a run row nor an empty state.
    // The wording must match what the panel actually says — "No updates
    // available" / "Runs will appear here once this task has executed."
    let body = "";
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(2500);
      body = await panel.first().innerText();
      if (
        /Completed|Failed|Cancelled|Queued|Running|Retrying|Skipped|Interrupted|No updates available|Runs will appear here/i.test(
          body,
        )
      ) {
        return;
      }
    }
    must(false, `the run history settled on neither rows nor an empty state`);
  });

  await soft("a run opens in a modal and offers no mutating action", async () => {
    const run = page
      .locator("aside button")
      .filter({ hasText: /Completed|Failed|Cancelled/i })
      .first();
    if ((await run.count()) === 0) return false;
    const before = page.url();
    await run.click();
    await page.waitForTimeout(3000);
    // Requirement 4: a dedicated dialog, not an inline panel view.
    must(
      await page.locator('[role="dialog"]').count(),
      "the run did not open in a dialog",
    );
    // ...and opening it must not navigate away from Scheduled Tasks.
    must(
      new URL(page.url()).pathname === new URL(before).pathname,
      "opening a run navigated away from the scheduled route",
    );
    // Requirement 5: the model, the step count and the tool trace are
    // execution data and must not appear in the user-facing result.
    const dialogText = await page.locator('[role="dialog"]').innerText();
    must(
      !/\bDone\b\s*·\s*\d+\s*steps?/i.test(dialogText),
      "the result modal exposed the agent step count",
    );
    // C1: ChatMessage renders readOnly, and ErrorNotice gets no onRetry.
    for (const name of ["Retry", "Regenerate", "Continue", "Edit message"]) {
      must(
        (await page.getByRole("button", { name, exact: true }).count()) === 0,
        `the read-only result viewer exposed "${name}"`,
      );
    }
  });

  await step("a scheduled task offers no route into chat", async () => {
    // Replaces "Open chat exposes no composer". That button opened a read-only
    // transcript inside the panel; the surface is gone entirely, so the check
    // is now that it cannot be reached at all — including by the old URL, which
    // must fall through to the ordinary run list rather than rendering a thread.
    await page.goto(`${BASE}/en/scheduled/${taskId}?view=thread`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(3000);
    must(
      (await page.getByRole("button", { name: "Open chat" }).count()) === 0,
      "the Open chat action is still present",
    );
    must(
      (await page.locator("#chat-composer").count()) === 0,
      "a composer rendered on a scheduled task",
    );
    must(
      (await page.getByRole("button", { name: "Stop generating" }).count()) === 0,
      "a generation control rendered on a scheduled task",
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
    // Pin a UNIQUE name: cleanup finds it by the tag, and these steps open it by
    // this exact name (see probeTitle above for why not "the first row").
    probeTitle = `${TAG} defaults probe ${Date.now()}`;
    await page.getByRole("textbox", { name: "Task name" }).fill(probeTitle);
    await page.getByRole("button", { name: "Create task" }).click();
    await page.waitForURL(/\/scheduled\/[a-z0-9]+/i, { timeout: 20000 });
    const freshId = page.url().split("/scheduled/")[1].split(/[/?#]/)[0];
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await openRowMenu(page, probeTitle);
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
    // The SAME fresh task the two steps above used — by its unique name, not
    // by position (see probeTitle).
    await openRowMenu(page, probeTitle);
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
      .filter({ hasText: /Completed|Failed|Cancelled/i })
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
      // Case- and space-insensitive: a title that went through the parser may
      // come back reformatted ("e2e-sched" -> "E2E Sched"), and a leftover row
      // must still be recognised as this suite's.
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const label = await rows.first().innerText();
      if (!norm(label).includes(norm(TAG))) break;
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
  if (parseMs.length) {
    const sorted = [...parseMs].sort((a, b) => a - b);
    console.log(`parse → draft card: n=${sorted.length} p50=${sorted[Math.floor(sorted.length / 2)]} ms max=${sorted[sorted.length - 1]} ms [${parseMs.join(", ")}]`);
  }
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
