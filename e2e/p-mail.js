// Scheduled report -> REAL inbox, end to end, in a real browser.
//
// WHAT THIS PROVES THAT NOTHING ELSE DID. Every other test of this pipeline
// either stubbed the provider (convex-test) or read Mailpit, a local catcher on
// the VM. Both pass on a deployment that cannot deliver mail to anyone — which
// is exactly what production turned out to be. This creates a real task as a
// real signed-in user, lets it run, and then reads the message out of a real
// external mailbox: subject, body, and the PDF attachment's own bytes.
//
// Usage (headed, against prod):
//   OLLASTACK_MAIL_TOKEN=... OLLASTACK_E2E_MAILBOX_ID=... node p-mail.js
//
// PROMPT= selects what the task asks for, so the same harness covers a plain
// prompt, a tool-using one and a skill-using one:
//   PROMPT=plain|tools|skill|combo   (default: plain)

const { chromium } = require("playwright");
const ollastack = require("./_lib/ollastack");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const PW = "TestUser#2026";
const KIND = process.env.PROMPT || "plain";

// Four prompt classes. Each must produce a real result BEFORE any email goes
// out — delivery is downstream of the finished run, never parallel to it.
const PROMPTS = {
  plain:
    "Every day at 9am, write two sentences explaining what compound interest is.",
  tools:
    "Every day at 9am, search the web for one notable AI news item from this week and summarise it in three bullets.",
  skill:
    "Every day at 9am, write a short blog intro (about 120 words) on why small teams ship faster.",
  combo:
    "Every day at 9am, research one current SEO ranking factor and produce a short brief with three recommendations.",
};

const errs = [];
const results = [];
let cur = BASE;
const step = async (n, f) => {
  try {
    const d = await f();
    results.push([true, n, d || ""]);
    console.log("PASS  " + n + (d ? " — " + d : ""));
    return d;
  } catch (e) {
    const first = String(e.message).split(/\r?\n/)[0];
    results.push([false, n, first]);
    console.log("FAIL  " + n + " — " + first);
    return null;
  }
};
const must = (c, m) => {
  if (!c) throw new Error(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!ollastack.enabled()) {
    console.log(
      "SKIP: set OLLASTACK_MAIL_TOKEN and OLLASTACK_E2E_MAILBOX_ID — this test is only meaningful against a real inbox.",
    );
    process.exit(1);
  }
  const TAG = ollastack.newTag();
  const EMAIL = ollastack.taggedAddress(await ollastack.mailboxAddress(), TAG);
  const TITLE = `MailTest ${TAG}`;
  console.log(`inbox  ${EMAIL}`);
  console.log(`prompt class: ${KIND}`);

  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 60,
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(`[${cur}] ${m.text()}`);
  });

  // ── a real, verified account whose address is a real inbox ───────────────
  await step("sign up and verify at a real inbox", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 30000 });
    await page.click('button:has-text("Create an account")');
    await page.fill('input[name="name"]', "Mail Test");
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[name="code"]', { timeout: 30000 });
    const code = await ollastack.codeFromOllastack(
      TAG,
      "email verification",
      120000,
    );
    must(code, "no verification code arrived in the real inbox");
    await page.fill('input[name="code"]', code);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
    // The delivery recipient is the account's VERIFIED address, read
    // server-side. Without this the run would record `no_verified_recipient`.
    return code;
  });

  // ── create the task, with email + PDF on ─────────────────────────────────
  await step("create a scheduled task with email + PDF enabled", async () => {
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    cur = page.url();
    const box = page.getByRole("textbox", { name: "Schedule a task" });
    await box.waitFor({ timeout: 20000 });
    // A sign-up/verification toast renders over the composer and INTERCEPTS the
    // click — the element is visible, enabled and stable, so Playwright retries
    // until it times out and the failure looks like a missing selector rather
    // than an overlay. Let it clear, then fill directly: fill() focuses the
    // field itself, so the separate click bought nothing but a hit test.
    await page
      .locator("[data-sonner-toaster] li")
      .first()
      .waitFor({ state: "detached", timeout: 20000 })
      .catch(() => {});
    await box.fill(PROMPTS[KIND] || PROMPTS.plain);
    await page.getByRole("button", { name: "Interpret schedule" }).click();
    const card = page.getByRole("textbox", { name: "Task instruction" });
    await card.waitFor({ state: "visible", timeout: 60000 });

    // Name it so the row and the email subject are findable.
    const titleBox = page.getByRole("textbox", { name: "Task title" });
    if (await titleBox.count()) {
      await titleBox.fill(TITLE);
    }
    // "Attach a PDF" is rendered ONLY once emailOnSuccess is true, so it cannot
    // be clicked in the same breath as the toggle that reveals it.
    await page.getByText("Email me each result").click();
    const pdfToggle = page.getByText("Attach a PDF");
    await pdfToggle.waitFor({ state: "visible", timeout: 10000 });
    await pdfToggle.click();
    await page.waitForTimeout(400);

    // Exact name. A loose /Schedule|Confirm|Create/ regex also matches the
    // composer's own "Schedule a task" control, and .last() then resolves to
    // whichever happened to be last in the DOM — which is why this passed for
    // some prompts and timed out for others.
    const confirm = page.getByRole("button", { name: "Create task" });
    await confirm.waitFor({ state: "visible", timeout: 15000 });
    await confirm.click();
    await page.waitForTimeout(5000);
    return TITLE;
  });

  // ── run it now and let it actually produce a result ──────────────────────
  await step("Run now, and the run reaches a terminal state", async () => {
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const row = page
      .locator("div.group")
      .filter({ has: page.getByRole("button", { name: "Task actions" }) })
      .first();
    await row.hover();
    await row.getByRole("button", { name: "Task actions" }).click();
    await page.waitForTimeout(400);
    const runNow = page.getByRole("menuitem", { name: "Run now" });
    must(await runNow.count(), "no Run now menu item");
    await runNow.click();
    await page.waitForTimeout(3000);
    await page.keyboard.press("Escape");

    // The model turn is real, so give it room. Delivery is enqueued only from
    // the terminal transition, so waiting on the email implicitly waits on the
    // result being finished and written.
    return "dispatched";
  });

  // ── the actual proof ─────────────────────────────────────────────────────
  let mail = null;
  const notAuthMail = (m) =>
    !/verification|password reset|OTP/i.test(String(m.subject ?? ""));

  await step("the report email arrives in the REAL inbox", async () => {
    const deadline = Date.now() + 600000; // model turn + PDF render + send
    while (Date.now() < deadline) {
      const msgs = await ollastack.messagesForTag(TAG).catch(() => []);
      const hit = msgs.find(notAuthMail);
      if (hit) {
        mail = await ollastack.message(hit.id);
        if (mail) return `subject: ${mail.subject}`;
      }
      await sleep(10000);
    }
    // Before calling this "never arrived", check the spam view. A hard-spam
    // message is excluded from the normal list, so the two failures are
    // indistinguishable from here — and they are opposite problems: a transport
    // fault versus content that tripped a filter. Say which.
    const spam = (await ollastack.messagesForTag(TAG, { spam: true }).catch(() => []))
      .filter(notAuthMail);
    if (spam.length > 0) {
      throw new Error(
        `DELIVERED BUT FILTERED AS SPAM (${spam[0].spamReason}): "${spam[0].subject}" — the provider sent it; the receiving side quarantined it`,
      );
    }
    throw new Error("no report email arrived within 10 minutes, and none in spam");
  });

  await step("the email carries the run's actual result", async () => {
    must(mail, "no message to inspect");
    const body = `${mail.textBody ?? ""}`.trim();
    must(body.length > 40, `body too short to be a real result (${body.length} chars)`);
    must(
      !/finished without producing any text/i.test(body),
      "the run produced no text — email delivered, but the result did not",
    );
    return `${body.length} chars`;
  });

  await step("the PDF is attached, and is a real PDF", async () => {
    must(mail, "no message to inspect");
    const atts = mail.attachments ?? [];
    must(atts.length > 0, "no attachment on the report email");
    const pdf = atts.find((a) =>
      /pdf/i.test(`${a.mimeType ?? ""} ${a.filename ?? ""}`),
    );
    must(pdf, `no PDF among attachments: ${JSON.stringify(atts)}`);
    must(
      (pdf.sizeBytes ?? 0) > 800,
      `PDF suspiciously small (${pdf.sizeBytes} bytes)`,
    );
    return `${pdf.filename} ${pdf.sizeBytes} bytes`;
  });

  await step("the UI reports the delivery honestly", async () => {
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const row = page
      .locator("div.group")
      .filter({ has: page.getByRole("button", { name: "Task actions" }) })
      .first();
    await row.click();
    await page.waitForURL(/\/scheduled\/[a-z0-9]+/i, { timeout: 20000 });
    await page.waitForTimeout(3000);
    // The delivery line lives on the RUN, not the task: task-detail.tsx mounts
    // RunResult only when ?run=<occurrenceId> is set. Open the run from the
    // history list first, or there is nothing to assert against.
    const runEntry = page
      .locator("button, a, div[role='button']")
      .filter({ hasText: /Completed|Succeeded/i })
      .first();
    must(await runEntry.count(), "no completed run in the history list");
    await runEntry.click();
    await page.waitForURL(/[?&]run=/, { timeout: 20000 });
    cur = page.url();
    await page.waitForTimeout(3000);
    const text = await page.locator("body").innerText();
    must(
      /accepted by the mail provider|Email delivered/i.test(text),
      "no delivery state rendered on the task page",
    );
    // The honesty invariant: custody is all the provider tells us, so the UI
    // must not claim delivery it cannot observe.
    must(
      !/Email delivered/i.test(text),
      "UI claimed 'delivered' — this transport reports no delivery event",
    );
    return "accepted by the mail provider";
  });

  const pass = results.filter((r) => r[0]).length;
  console.log(`\n========= SCHEDULED MAIL (${KIND}): ${pass}/${results.length} =========`);
  for (const [ok, n, d] of results) {
    console.log(`${ok ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`);
  }
  console.log("console errors:", errs.length);
  for (const e of errs.slice(0, 5)) console.log("  " + e);
  await b.close();
  process.exit(pass === results.length && errs.length === 0 ? 0 : 1);
})();
