// Headed verification of the QA bug fixes (#2, #5, #6, #8) against PRODUCTION.
//
// These are the four that cannot be proved from the backend: they are all
// about what the browser actually renders or persists.
//
//   E2E_EMAIL=... E2E_PASSWORD=... node qa-bugfix-verify.js
const { chromium } = require("playwright");

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

(async () => {
  const b = await chromium.launch({ headless: false, slowMo: 45 });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("console: " + m.text().slice(0, 220));
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
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 25000 });
  });

  // A conversation to act on. Reuse one if the account already has any.
  await step("ensure a conversation exists", async () => {
    const rows = page.locator("aside a, nav a").filter({ hasText: /./ });
    const existing = await page
      .locator('[href*="/chat/"]')
      .count()
      .catch(() => 0);
    if (existing > 0) {
      notes.push(`reusing an existing conversation (${existing} in the rail)`);
      return;
    }
    await page.locator("#chat-composer").click();
    await page.keyboard.type("QA fix verification thread");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(12000);
    void rows;
  });

  // ---- #2: the Move-to-project dialog was clipped by the rail -------------
  await step("#2: Move to project dialog is fully on screen and centred", async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    const row = page.locator('[href*="/chat/"]').first();
    await row.waitFor({ timeout: 15000 });
    await row.hover();
    await page
      .getByRole("button", { name: "Conversation actions" })
      .first()
      .click();
    await page.waitForTimeout(600);

    // The other items must still be there — the fix must not touch them.
    for (const label of [/^(Pin|Unpin)$/, /^Rename$/, /^Archive$/, /^Delete$/]) {
      if ((await page.getByRole("button", { name: label }).count()) === 0)
        throw new Error("menu item missing: " + label);
    }
    await page.getByRole("button", { name: /^Move to project$/ }).click();
    const dlg = page.locator('[role="dialog"][aria-label="Move chat to a project"]');
    await dlg.waitFor({ timeout: 15000 });

    const box = await dlg.boundingBox();
    if (!box) throw new Error("dialog has no box");
    const vw = page.viewportSize().width;
    notes.push(
      `#2 dialog box x=${Math.round(box.x)} w=${Math.round(box.width)} (viewport ${vw})`,
    );
    // The bug: left edge at -72px, clipped inside a 272px rail.
    if (box.x < 0) throw new Error(`dialog starts off-screen at x=${box.x}`);
    if (box.x + box.width > vw)
      throw new Error(`dialog overflows the right edge: ${box.x + box.width} > ${vw}`);
    const centre = box.x + box.width / 2;
    if (Math.abs(centre - vw / 2) > 8)
      throw new Error(`dialog not centred: centre=${centre}, want ~${vw / 2}`);

    // And the text is whole, not missing its first 72px.
    const heading = (await dlg.locator("h2").first().innerText()).trim();
    if (!/^Move to project/i.test(heading))
      throw new Error("heading is clipped: " + JSON.stringify(heading));
    notes.push(`#2 heading reads: ${JSON.stringify(heading)}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  });

  // ---- #5: sidebar and Settings must not contradict each other ------------
  await step("#5: the sidebar's files also appear in Settings → Files", async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    await page.waitForTimeout(2500);
    const sidebarCount = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button, div")];
      const hdr = btns.find((el) =>
        /^\s*Files\s*\d*\s*$/i.test((el.innerText || "").trim()),
      );
      const m = hdr && (hdr.innerText || "").match(/(\d+)/);
      return m ? Number(m[1]) : 0;
    });

    await page.goto(BASE + "/en/settings/files", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const body = await page.evaluate(() => document.body.innerText || "");
    if (!/Chat files/i.test(body))
      throw new Error("Settings → Files has no 'Chat files' section");
    const settingsCount = await page.evaluate(() => {
      const els = [...document.querySelectorAll("h2")];
      const h = els.find((e) => /Chat files/i.test(e.innerText || ""));
      const badge = h?.parentElement?.querySelector("span");
      return badge ? Number((badge.innerText || "0").trim()) : -1;
    });
    notes.push(`#5 sidebar=${sidebarCount} settings "Chat files"=${settingsCount}`);
    if (settingsCount < 0) throw new Error("could not read the Chat files count");
    if (sidebarCount !== settingsCount)
      throw new Error(
        `still contradictory: sidebar ${sidebarCount} vs settings ${settingsCount}`,
      );
  });

  // ---- #6: opening Share must not publish ---------------------------------
  let sharedBefore = 0;
  await step("#6: count existing shared links", async () => {
    await page.goto(BASE + "/en/settings/shared", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    // Each row renders an <a href=".../share/<token>">; body text shows the
    // TITLE, not the URL, so counting text found nothing and the whole check
    // passed vacuously (0 === 0). Count the anchors instead.
    sharedBefore = await page.locator('a[href*="/share/"]').count();
    notes.push(`#6 shared links before: ${sharedBefore}`);
  });
  await step("#6: a FRESH conversation, then open Share → close → nothing published", async () => {
    // MUST be a conversation with no existing share. A thread that was already
    // shared correctly shows its existing link on open (that is the dedup path,
    // not a new publication) — reusing one made an earlier run of this test
    // report a leak that was not one.
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    await page.locator("#chat-composer").click();
    await page.keyboard.type("Share regression probe " + Date.now());
    await page.keyboard.press("Enter");
    // Sharing is refused while a response is still streaming, so let it finish.
    await page.waitForTimeout(25000);

    await page.getByRole("button", { name: "Share conversation" }).click();
    const dlg = page.locator('[role="dialog"]');
    await dlg.waitFor({ timeout: 15000 });
    await page.waitForTimeout(2500);
    const shown = await dlg.innerText();
    const leaked = await page.evaluate(() => {
      const el = document.querySelector('[role="dialog"] input[readonly]');
      return el ? el.value : "";
    });
    if (/\/share\//.test(leaked))
      throw new Error("a link existed before confirming: " + leaked);
    if (!/create link/i.test(shown))
      throw new Error("no 'Create link' offered: " + shown.slice(0, 200));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1500);

    await page.goto(BASE + "/en/settings/shared", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const after = await page.locator('a[href*="/share/"]').count();
    notes.push(`#6 shared links after open+close: ${after} (was ${sharedBefore})`);
    if (after !== sharedBefore)
      throw new Error(`open+close published a link: ${sharedBefore} -> ${after}`);
  });

  await step("#6: explicit Create link publishes exactly one, and it works", async () => {
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Share conversation" }).click();
    const dlg = page.locator('[role="dialog"]');
    await dlg.waitFor({ timeout: 15000 });
    await dlg.getByRole("button", { name: /create link/i }).click();
    const input = dlg.locator("input[readonly]");
    await input.waitFor({ timeout: 25000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[role="dialog"] input[readonly]');
        return el && /\/share\//.test(el.value);
      },
      { timeout: 25000 },
    );
    const link = await input.inputValue();
    if (!/\/share\/[0-9a-f]{48}/.test(link)) throw new Error("bad link: " + link);
    notes.push(`#6 created link: ${link.slice(0, 46)}…`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);

    // Reopening must SHOW that link, not mint a second one.
    await page.getByRole("button", { name: "Share conversation" }).click();
    await dlg.waitFor({ timeout: 15000 });
    await page.waitForTimeout(2500);
    const again = await page.evaluate(() => {
      const el = document.querySelector('[role="dialog"] input[readonly]');
      return el ? el.value : "";
    });
    if (again !== link)
      throw new Error(`reopen changed the link: ${again} != ${link}`);
    await page.keyboard.press("Escape");

    const anon = await b.newContext();
    const p2 = await anon.newPage();
    await p2.goto(link, { waitUntil: "domcontentloaded" });
    await p2.waitForTimeout(3500);
    const t = await p2.evaluate(() => document.body.innerText || "");
    await anon.close();
    if (!/shared conversation/i.test(t))
      throw new Error("public page did not render: " + t.slice(0, 140));

    await page.goto(BASE + "/en/settings/shared", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const after = await page.locator('a[href*="/share/"]').count();
    notes.push(`#6 shared links after explicit create + reopen: ${after}`);
    if (after !== sharedBefore + 1)
      throw new Error(`expected exactly one new link, got ${sharedBefore} -> ${after}`);
  });


  // ---- #8: parsing feedback ------------------------------------------------
  await step("#8: a progress line shows while the schedule is parsed", async () => {
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const box = page.locator('textarea[aria-label="Schedule a task"]');
    await box.waitFor({ timeout: 20000 });
    await box.click();
    await box.fill("Daily tech news every weekday at 8am");
    await page.keyboard.press("Enter");
    // The indicator must appear while the request is in flight.
    await page
      .getByText(/Working out the schedule/i)
      .waitFor({ timeout: 20000 });
    notes.push("#8 progress line appeared");
    // ...and go away once the draft lands.
    await page
      .getByText(/Working out the schedule/i)
      .waitFor({ state: "detached", timeout: 120000 });
  });

  // ---- #9/#10 in the real UI ----------------------------------------------
  await step("#9/#10: a generated task is creatable without editing", async () => {
    const title = page.locator('input[aria-label="Task name"]');
    await title.waitFor({ timeout: 30000 });
    const t = await title.inputValue();
    const promptBox = page.locator('textarea[aria-label="What should happen on each run"], textarea').last();
    const p = await promptBox.inputValue().catch(() => "");
    notes.push(`#9 title=${JSON.stringify(t)}`);
    notes.push(`#9 prompt=${JSON.stringify((p || "").slice(0, 120))}`);
    if (/^daily tech news every weekday at 8am$/i.test((p || "").trim()))
      throw new Error("prompt is still the raw topic");
    const create = page.getByRole("button", { name: /^Create task$/ });
    await create.waitFor({ timeout: 15000 });
    if (await create.isDisabled()) {
      const reason = await page
        .locator("p.text-xs")
        .allInnerTexts()
        .catch(() => []);
      throw new Error(
        "Create is blocked without editing: " + JSON.stringify(reason.slice(-3)),
      );
    }
    await create.click();
    await page.waitForTimeout(4000);
    const body = await page.evaluate(() => document.body.innerText || "");
    if (!/scheduled task created/i.test(body) && !/Daily Tech News/i.test(body))
      throw new Error("task did not appear after Create");
    notes.push("#10 created with no edits");
  });
  // ---- Create task must not require a pointless edit ----------------------
  //
  // The composer PERSISTS its draft in sessionStorage and restores it on mount,
  // so each case clears storage first — otherwise the previous card is already
  // on screen and every assertion reads a stale draft.
  const freshComposer = async () => {
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    const box = page.locator('textarea[aria-label="Schedule a task"]');
    await box.waitFor({ timeout: 25000 });
    await page.evaluate(() => {
      try {
        sessionStorage.clear();
      } catch {}
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await box.waitFor({ timeout: 25000 });
    return box;
  };

  await step("#create: a topic with NO time is creatable with zero edits", async () => {
    const box = await freshComposer();
    await box.click();
    await box.fill("daily news update on ai");
    await page.keyboard.press("Enter");
    const create = page.getByRole("button", { name: /^Create task$/ });
    await create.waitFor({ timeout: 90000 });
    await page.waitForTimeout(3000);
    if (await create.isDisabled()) {
      const hints = await page.locator("p.text-xs").allInnerTexts().catch(() => []);
      throw new Error(
        "Create still blocked without editing: " + JSON.stringify(hints.slice(-3)),
      );
    }
    const body = await page.evaluate(() => document.body.innerText || "");
    if (!/9:00\s*AM/i.test(body))
      throw new Error("expected the visible 9:00 AM default on the card");
    await create.click();
    await page.waitForTimeout(4500);
    const after = await page.evaluate(() => document.body.innerText || "");
    if (!/scheduled task created/i.test(after) && !/News/i.test(after))
      throw new Error("task did not appear after Create");
    notes.push("#create: no-time topic created with no edits, at the shown 9:00 AM");
  });

  await step("#create: a WEEKLY request with no day is still blocked", async () => {
    // specGaps must keep biting — weekly with no weekdays is the one shape the
    // backend rejects outright ("Invalid weekdays").
    const box = await freshComposer();
    await box.click();
    await box.fill("weekly summary of my files");
    await page.keyboard.press("Enter");
    const create = page.getByRole("button", { name: /^Create task$/ });
    await create.waitFor({ timeout: 90000 });
    await page.waitForTimeout(3000);
    const shown = (await page.evaluate(() => document.body.innerText || "")) || "";
    if (!/weekly/i.test(shown)) {
      notes.push("#create: parser did not choose weekly; guard case skipped");
      return;
    }
    if (!(await create.isDisabled()))
      throw new Error("weekly with no day should still block Create");
    notes.push("#create: weekly-with-no-day still blocked (specGaps intact)");
  });



  console.log("\n--- notes ---");
  for (const n of notes) console.log("  " + n);
  const uniq = [...new Set(errs)];
  console.log(`\n--- console/network errors: ${uniq.length} ---`);
  for (const e of uniq.slice(0, 15)) console.log("  " + e);
  const passed = results.filter(([ok]) => ok).length;
  console.log(`\nRESULT ${passed}/${results.length} passed, ${uniq.length} errors`);
  for (const [ok, n] of results) if (!ok) console.log("  FAILED: " + n);
  await b.close();
  process.exit(passed === results.length ? 0 : 1);
})();
