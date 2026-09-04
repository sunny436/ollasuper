// Composer follow-up chips, end to end against the deployed stack.
//
// House style: standalone node script, hand-rolled step() harness, hard
// assertion of zero console errors.
//
//   E2E_BASE_URL=https://app.ollasuper.com node qa-suggestions.js
//
// What matters here is the LIFECYCLE, not that a model said something clever:
// chips must never appear mid-stream, must survive a click and an edit, must
// vanish on send, and must never become conversation.
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";

const errs = [];
const results = [];
const notes = [];

const CHIPS = "[data-suggestions] button";

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

/** Generating iff the composer is offering "Stop generating". */
const generating = async (page) =>
  (await page.getByRole("button", { name: "Stop generating" }).count()) > 0;

const settle = async (page, ms = 120000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await generating(page))) return true;
    await page.waitForTimeout(250);
  }
  throw new Error("generation did not finish");
};

/** Send, then return ms from generation-finished to chips-rendered. */
async function sendAndTime(page, text) {
  await page.locator("#chat-composer").fill(text);
  await page.keyboard.press("Enter");
  // Wait for the turn to actually start, so `settle` cannot pass instantly.
  await page.waitForTimeout(1200);
  await settle(page);
  const t0 = Date.now();
  try {
    await page.waitForSelector(CHIPS, { timeout: 8000 });
    return Date.now() - t0;
  } catch {
    return null;
  }
}

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 40,
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
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
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
  });

  await step("landing screen offers no chips", async () => {
    // No assistant turn exists yet, so there is nothing to follow up on.
    if ((await page.locator(CHIPS).count()) !== 0)
      throw new Error("chips on the empty new-chat screen");
  });

  let elapsed = null;
  await step("a substantive answer produces at most 3 chips", async () => {
    elapsed = await sendAndTime(
      page,
      "Draft a short launch plan for a new API product. Three bullets.",
    );
    if (elapsed === null) throw new Error("no chips after a substantive answer");
    const n = await page.locator(CHIPS).count();
    if (n === 0 || n > 3) throw new Error(`expected 1..3 chips, got ${n}`);
    const texts = await page.locator(CHIPS).allInnerTexts();
    notes.push(`chips: ${JSON.stringify(texts)}`);
    notes.push(`chips appeared ${elapsed}ms after generation finished`);
    if (new Set(texts.map((t) => t.toLowerCase())).size !== texts.length)
      throw new Error("duplicate chips");
    for (const t of texts) {
      if (!t.trim()) throw new Error("empty chip");
      if (/would you like|learn more|tell me more/i.test(t))
        throw new Error(`filler chip: ${t}`);
    }
  });

  await step("chips arrive within ~1s of the answer finishing", async () => {
    if (elapsed === null) throw new Error("no chips to time");
    // The budget the feature was designed against: model p90 ~0.8s plus one
    // ingress round-trip plus the Convex push. Generous ceiling so a slow
    // provider day is a note, not a red suite.
    if (elapsed > 3000) throw new Error(`chips took ${elapsed}ms`);
    if (elapsed > 1000) notes.push(`WARN chips took ${elapsed}ms (>1s target)`);
  });

  await step("chips sit inside the composer's own width", async () => {
    const shell = await page
      .locator("[data-composer-shell]")
      .first()
      .boundingBox();
    const row = await page.locator("[data-suggestions]").first().boundingBox();
    if (!shell || !row) throw new Error("no bounding boxes");
    if (row.x < shell.x - 2 || row.x + row.width > shell.x + shell.width + 2)
      throw new Error(
        `chips (${row.x}..${row.x + row.width}) escape composer ` +
          `(${shell.x}..${shell.x + shell.width})`,
      );
    if (row.y > shell.y + shell.height)
      throw new Error("chips render below the composer");
  });

  let picked = "";
  await step("clicking a chip fills the composer WITHOUT sending", async () => {
    picked = (await page.locator(CHIPS).first().innerText()).trim();
    await page.locator(CHIPS).first().click();
    await page.waitForTimeout(600);
    const value = await page.locator("#chat-composer").inputValue();
    if (value.trim() !== picked)
      throw new Error(`composer holds "${value}", expected "${picked}"`);
    if (await generating(page))
      throw new Error("clicking a chip started a generation");
  });

  await step("chips survive the click and stay visible while editing", async () => {
    if ((await page.locator(CHIPS).count()) === 0)
      throw new Error("chips vanished on click");
    await page.locator("#chat-composer").click();
    await page.keyboard.type(" and add a timeline");
    await page.waitForTimeout(400);
    if ((await page.locator(CHIPS).count()) === 0)
      throw new Error("chips vanished while editing");
    const value = await page.locator("#chat-composer").inputValue();
    if (!value.includes("and add a timeline"))
      throw new Error("edit did not land in the composer");
  });

  await step("chips are not conversation", async () => {
    // They must exist only as composer UI: never a message row, so never in
    // the transcript.
    // The chip row and the composer are BOTH legitimate homes for this text —
    // the composer is where a click is meant to put it. What must not happen is
    // the text existing anywhere else, i.e. having become a message.
    const inTranscript = await page.evaluate((text) => {
      const main = document.querySelector("main") || document.body;
      const clone = main.cloneNode(true);
      for (const el of clone.querySelectorAll(
        "[data-suggestions], #chat-composer",
      )) {
        el.remove();
      }
      return (clone.textContent || "").includes(text);
    }, picked);
    if (inTranscript)
      throw new Error("chip text appears in the transcript as a message");
  });

  await step("sending clears the chips", async () => {
    await page.locator("#chat-composer").fill("Say only: OK");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
    if ((await page.locator(CHIPS).count()) !== 0)
      throw new Error("chips survived send / are visible during streaming");
  });

  await step("chips stay hidden for the whole generation", async () => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (!(await generating(page))) break;
      if ((await page.locator(CHIPS).count()) !== 0)
        throw new Error("chips appeared mid-stream");
      await page.waitForTimeout(300);
    }
    await settle(page);
  });

  await step("a trivial turn shows no chips", async () => {
    // "hi" must produce nothing — and, because a turn always writes its own
    // result, it must also CLEAR whatever the previous turn left.
    const t = await sendAndTime(page, "hi");
    if (t !== null) {
      const texts = await page.locator(CHIPS).allInnerTexts();
      throw new Error(`trivial turn produced chips: ${JSON.stringify(texts)}`);
    }
  });

  await step("a later substantive turn brings them back", async () => {
    const t = await sendAndTime(
      page,
      "Now compare two pricing models for that product.",
    );
    if (t === null) throw new Error("no chips after a substantive follow-up");
    notes.push(
      `replacement chips: ${JSON.stringify(
        await page.locator(CHIPS).allInnerTexts(),
      )}`,
    );
  });

  await step("chips survive a refresh (only Send clears them)", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    await page.waitForTimeout(2500);
    if ((await page.locator(CHIPS).count()) === 0)
      throw new Error("chips lost on refresh");
  });

  await step("mobile: chips stay inside the viewport", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1200);
    if ((await page.locator(CHIPS).count()) === 0)
      throw new Error("chips missing at mobile width");
    const row = await page.locator("[data-suggestions]").first().boundingBox();
    if (!row) throw new Error("no chip row box");
    if (row.x < -2 || row.x + row.width > 392)
      throw new Error(`chip row overflows 390px viewport: ${JSON.stringify(row)}`);
    const scrolls = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    if (scrolls) throw new Error("page scrolls horizontally at 390px");
  });

  await step("zero console errors", async () => {
    if (errs.length) throw new Error(errs.slice(0, 4).join(" | "));
  });

  await b.close();
  for (const n of notes) console.log("      " + n);
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
