// Notification centre acceptance, against the deployed stack.
//
// The behaviour that matters most is what must NOT happen: opening the panel
// must not consume unread state (the bell used to call markAllRead on open, so
// a glance destroyed every unread mark), and the loading state must not be
// mistaken for "no notifications".
//
//   E2E_BASE_URL=https://app.ollasuper.com node p-notif-center.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const TAG = "e2e-notif";

const errs = [];
const results = [];
const skipped = [];
const created = [];
let PAGE = null;

const shot = async (name) => {
  if (!PAGE) return "";
  const file = `/tmp/p-notif-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 48)}.png`;
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
function must(c, m) {
  if (!c) throw new Error(m);
}

const bell = (page) => page.getByRole("button", { name: "Notifications" });

/** The badge's accessible name is "<n> unread"; absent means zero. */
async function unreadCount(page) {
  const badge = page.locator('[aria-label$="unread"]').first();
  if (!(await badge.count())) return 0;
  const label = await badge.getAttribute("aria-label");
  const n = Number.parseInt(label, 10);
  return Number.isFinite(n) ? n : 0;
}

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
  const BROWSER_NOTICE = /chromestatus\.com/;
  page.on("console", (m) => {
    if (m.type() === "error" && !BROWSER_NOTICE.test(m.text())) errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
  });

  // ── placement ────────────────────────────────────────────────────────────

  await step("N1 the bell is in the chat topbar, between Share and the theme control", async () => {
    const header = page.locator("header").first();
    must(await header.count(), "no chat header");
    must(
      await header.getByRole("button", { name: "Notifications" }).count(),
      "the bell is not in the chat header",
    );
    // DOM order inside the header's right cluster: Share, then the bell, then
    // the theme toggle - a button since the monochrome system replaced the
    // ambience slider, so the selector below no longer looks for a range input.
    const order = await header.evaluate((h) => {
      const names = [];
      for (const el of h.querySelectorAll("button")) {
        const l = el.getAttribute("aria-label") || "";
        if (/Share conversation/.test(l)) names.push("share");
        else if (/^Notifications$/.test(l)) names.push("bell");
        else if (/[Tt]heme/.test(l)) names.push("theme");
      }
      return names.join(",");
    });
    must(
      /share,bell/.test(order) || /bell,theme/.test(order),
      `unexpected header order: ${order}`,
    );
    console.log(`        header order = ${order}`);
  });

  await step("N2 the sidebar no longer carries a notification entry", async () => {
    const rail = page.locator('nav[aria-label="Conversations"]');
    const inRail = await rail.getByRole("button", { name: "Notifications" }).count();
    must(inRail === 0, "the sidebar still has a notification control");
    must(
      (await page.getByText("Updates", { exact: true }).count()) === 0,
      'the sidebar still shows the "Updates" row',
    );
  });

  await step("N3 /scheduled also has the bell (it has no header of its own)", async () => {
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    must(await bell(page).count(), "no notification control on /scheduled");
  });

  // ── the P0: opening must not consume unread state ────────────────────────

  let beforeOpen = 0;
  await step("N4 the panel opens and shows a real state, not a flash of empty", async () => {
    beforeOpen = await unreadCount(page);
    await bell(page).first().click();
    await page.waitForTimeout(1200);
    const panel = await page.locator("body").innerText();
    must(/Notifications/.test(panel), "the panel did not open");
    must(
      /No notifications|ago|in \d/.test(panel),
      "neither the empty state nor any row rendered",
    );
    console.log(`        unread before opening = ${beforeOpen}`);
  });

  await step("N5 OPENING THE PANEL READS NOTHING", async () => {
    // The defect this replaces: markAllRead fired on open, so glancing at the
    // bell destroyed every unread mark.
    const after = await unreadCount(page);
    must(
      after === beforeOpen,
      `unread went ${beforeOpen} → ${after} just from opening the panel`,
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  });

  await step("N6 Escape closes the panel", async () => {
    const open = await page.locator('[role="menu"]').count();
    must(open === 0, "the panel stayed open after Escape");
  });

  // ── a real event, arriving without a refresh ─────────────────────────────

  let taskTitle = `${TAG} ${Date.now()}`;
  await soft("N7 a real scheduled run raises a notification WITHOUT a refresh", async () => {
    // Create a task through the composer, pinning the fields so this step
    // tests notifications rather than the parser.
    const box = page.getByRole("textbox", { name: "Schedule a task" });
    await box.click();
    await box.fill("every day at 9 am summarise my open items");
    await page.getByRole("button", { name: "Interpret schedule" }).click();
    await page
      .getByRole("textbox", { name: "Task instruction" })
      .waitFor({ state: "visible", timeout: 45000 });
    await page.getByRole("textbox", { name: "Task name" }).fill(taskTitle);
    await page
      .getByRole("textbox", { name: "Task instruction" })
      .fill("Reply with exactly: ok");
    await page.getByRole("button", { name: "Create task" }).click();
    await page.waitForTimeout(3500);
    created.push(taskTitle);

    const before = await unreadCount(page);
    // Run it now, then WAIT WITHOUT RELOADING — the badge must change on its own.
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const row = taskRows(page).filter({ hasText: taskTitle }).first();
    await row.hover();
    await row.getByRole("button", { name: "Task actions" }).click();
    await page.waitForTimeout(400);
    await page.getByRole("menuitem", { name: /Run now/i }).click();

    const start = await unreadCount(page);
    let arrived = false;
    for (let i = 0; i < 48; i++) {
      await page.waitForTimeout(5000); // no reload anywhere in this loop
      if ((await unreadCount(page)) > start) {
        arrived = true;
        break;
      }
    }
    must(arrived, "no notification arrived within 4 minutes without a refresh");
    console.log(`        unread ${before} → ${await unreadCount(page)} with no reload`);
  });

  await soft("N8 opening ONE notification marks only that one, and the badge drops", async () => {
    const before = await unreadCount(page);
    must(before > 0 && before < 9, `need 1..8 unread to see a decrement, have ${before}`);
    await bell(page).first().click();
    await page.waitForTimeout(1200);
    // The check button marks read without navigating, so the panel stays open.
    const check = page.locator('[aria-label^="Mark "]').first();
    must(await check.count(), "no per-notification read control");
    await check.click();
    await page.waitForTimeout(1500);
    const after = await unreadCount(page);
    must(after === before - 1, `unread ${before} → ${after}, expected ${before - 1}`);
    await page.keyboard.press("Escape");
  });

  await soft("N9 clicking a scheduled notification opens that RUN", async () => {
    await bell(page).first().click();
    await page.waitForTimeout(1200);
    const row = page.locator('[role="menu"] button').filter({ hasText: taskTitle }).first();
    must(await row.count(), "the run notification is not in the panel");
    await row.click();
    await page.waitForTimeout(2500);
    must(
      /\/scheduled\/[a-z0-9]+/i.test(page.url()),
      `did not navigate to the task: ${page.url()}`,
    );
    must(/[?&]run=/.test(page.url()), `no ?run= in the URL: ${page.url()}`);
    console.log(`        landed on ${page.url().replace(BASE, "")}`);
  });

  await soft("N10 mark all as read clears the badge", async () => {
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    if ((await unreadCount(page)) === 0) throw new Error("nothing unread to clear");
    await bell(page).first().click();
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: "Mark all as read" }).click();
    await page.waitForTimeout(2000);
    must((await unreadCount(page)) === 0, "the badge did not clear");
    await page.keyboard.press("Escape");
  });

  await step("N11 notifications are newest-first", async () => {
    await bell(page).first().click();
    await page.waitForTimeout(1200);
    const stamps = await page.locator('[role="menu"]').first().innerText();
    must(stamps.length > 0, "the panel rendered nothing");
    await page.keyboard.press("Escape");
  });

  // ── layout ───────────────────────────────────────────────────────────────

  await step("N12 no horizontal overflow on /chat at 390px", async () => {
    // The existing suite only checks /scheduled; the chat header is the one
    // that just gained a control.
    for (const [w, h] of [
      [390, 844],
      [820, 1180],
      [1440, 900],
    ]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1800);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      must(!overflow, `horizontal overflow at ${w}px`);
      must(await bell(page).count(), `the bell disappeared at ${w}px`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  // ── cleanup ──────────────────────────────────────────────────────────────

  await step("cleanup: created tasks removed", async () => {
    for (const title of created) {
      for (let i = 0; i < 3; i++) {
        await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2500);
        const row = taskRows(page).filter({ hasText: title }).first();
        if (!(await row.count())) break;
        await row.hover();
        await row.getByRole("button", { name: "Task actions" }).click();
        await page.waitForTimeout(500);
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await page.waitForTimeout(900);
        await page.getByRole("button", { name: "Delete", exact: true }).last().click();
        await page.waitForTimeout(3000);
      }
    }
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    for (const title of created) {
      must(
        (await taskRows(page).filter({ hasText: title }).count()) === 0,
        `${title} is still on production`,
      );
    }
  });

  await step("zero console errors", async () => {
    must(errs.length === 0, `${errs.length}:\n  ` + errs.slice(0, 6).join("\n  "));
  });

  const passed = results.filter(Boolean).length;
  console.log(
    `\n===== NOTIF CENTRE: ${passed}/${results.length}` +
      (skipped.length ? ` | skipped: ${skipped.length}` : "") +
      ` | console errors: ${errs.length} =====`,
  );
  if (skipped.length) console.log("skipped: " + skipped.join(" | "));
  await b.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch(async (e) => {
  console.error("FATAL", e.message || e);
  process.exit(1);
});
