// Explore — capability discovery on the landing screen, on the real deployment.
//
// The two assertions that matter most are the ones a screenshot cannot make:
//
//   ZERO LAYOUT SHIFT is checked by comparing the composer's bounding box before
//   and after opening, not by eye.
//
//   THE COMPOSER IS NOT DIMMED is checked with elementFromPoint at its centre —
//   if the portalled overlay covered it, the hit test would return the overlay.
//   That is the exact bug the design avoids: EmptyHero and ChatInput are
//   siblings in one Framer-transformed z-20 container, so an overlay above that
//   container dims BOTH unless the container is raised.
//
//   OLLASTACK_MAIL_TOKEN=... OLLASTACK_E2E_MAILBOX_ID=... node p-explore.js

const { chromium } = require("playwright");
const ollastack = require("./_lib/ollastack");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const PW = "Explore#2026";

const errs = [];
const results = [];
const step = (ok, name, detail) => {
  results.push([ok, name, detail || ""]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const explore = (page) => page.getByRole("button", { name: "Explore capabilities" });
const menu = (page) => page.getByRole("menu");
const box = async (page) =>
  page.locator("#chat-composer").boundingBox();

(async () => {
  if (!ollastack.enabled()) {
    console.log("SKIP: needs OLLASTACK_MAIL_TOKEN + OLLASTACK_E2E_MAILBOX_ID");
    process.exit(1);
  }
  const email = ollastack.taggedAddress(
    await ollastack.mailboxAddress(),
    ollastack.newTag(),
  );
  console.log(`address: ${email}`);

  const b = await chromium.launch({ headless: false, slowMo: 60 });
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
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
    await page.fill('input[name="name"]', "Explore Test");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[name="code"]', { timeout: 20000 });
    const code = await ollastack.codeForAddress(email, "verification", 120000);
    if (!code) throw new Error("no verification code arrived");
    await page.fill('input[name="code"]', code);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/chat/, { timeout: 60000 });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    await page.waitForTimeout(1500);

    // ── the idle screen adds nothing but the control ────────────────────────
    step(
      (await menu(page).count()) === 0,
      "the idle landing screen shows no menu",
    );
    step(await explore(page).isVisible(), "the Explore control is present");

    // ── open: no layout shift ───────────────────────────────────────────────
    const before = await box(page);
    await explore(page).click();
    await menu(page).waitFor({ state: "visible", timeout: 8000 });
    await page.waitForTimeout(600);
    const after = await box(page);
    const shifted =
      Math.abs(before.x - after.x) > 1 ||
      Math.abs(before.y - after.y) > 1 ||
      Math.abs(before.width - after.width) > 1;
    step(
      !shifted,
      "opening the menu shifts the composer by nothing",
      `${JSON.stringify(before)} vs ${JSON.stringify(after)}`,
    );

    // ── it opens ABOVE the composer ─────────────────────────────────────────
    const menuBox = await menu(page).boundingBox();
    step(
      menuBox.y + menuBox.height <= after.y + 8,
      "the menu opens above the composer",
      `menu bottom ${Math.round(menuBox.y + menuBox.height)} vs composer top ${Math.round(after.y)}`,
    );

    // ── the composer is NOT covered by the dim overlay ──────────────────────
    const hit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el ? el.closest("#chat-composer") !== null || el.id === "chat-composer" : false;
      },
      [after.x + after.width / 2, after.y + after.height / 2],
    );
    step(hit, "the composer sits above the dim overlay, not under it");

    // ── the greeting dims ───────────────────────────────────────────────────
    const heroDim = await page.evaluate(() => {
      const h = document.querySelector("h1");
      if (!h) return null;
      let node = h.parentElement;
      while (node) {
        const o = Number.parseFloat(getComputedStyle(node).opacity);
        if (o < 0.9) return o;
        node = node.parentElement;
      }
      return 1;
    });
    step(
      heroDim !== null && heroDim < 0.9,
      "the greeting dims while the menu is open",
      `opacity ${heroDim}`,
    );

    // ── the shared footer responds to hover AND to keyboard focus ───────────
    const footerText = () =>
      page.evaluate(() => {
        const m = document.querySelector('[role="menu"]');
        return m ? m.innerText.split("\n").slice(-1)[0] : "";
      });
    const idle = await footerText();
    await page.getByRole("menuitem", { name: /Finance/ }).first().hover();
    await page.waitForTimeout(400);
    const hovered = await footerText();
    step(
      hovered !== idle && /DCF|valuation|Finance/i.test(hovered),
      "hovering an item updates the shared footer",
      hovered.slice(0, 90),
    );

    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(400);
    const focused = await footerText();
    step(
      focused.length > 0 && focused !== idle,
      "keyboard focus updates the footer too",
      focused.slice(0, 90),
    );

    // ── Escape dismisses ────────────────────────────────────────────────────
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    step((await menu(page).count()) === 0, "Escape closes the menu");

    // ── outside-click dismisses ─────────────────────────────────────────────
    await explore(page).click();
    await menu(page).waitFor({ state: "visible", timeout: 8000 });
    await page.mouse.click(40, 40);
    await page.waitForTimeout(600);
    step((await menu(page).count()) === 0, "an outside click closes the menu");

    // ── selecting seeds the composer ────────────────────────────────────────
    await explore(page).click();
    await menu(page).waitFor({ state: "visible", timeout: 8000 });
    await page.getByRole("menuitem", { name: /Research/ }).first().click();
    await page.waitForTimeout(900);
    const seeded = await page.locator("#chat-composer").inputValue();
    step((await menu(page).count()) === 0, "selecting closes the menu");
    step(
      seeded.length > 10,
      "selecting seeds the composer with an editable prompt",
      seeded.slice(0, 70),
    );
    const caret = await page.evaluate(
      () => document.activeElement?.id === "chat-composer",
    );
    step(caret, "the caret lands in the composer");
    step(
      /\/chat\/?$/.test(new URL(page.url()).pathname) ||
        !/\/chat\/[a-z0-9]/i.test(page.url()),
      "seeding did not navigate or send",
      page.url(),
    );

    // ── responsive: no horizontal overflow ──────────────────────────────────
    let overflow = "";
    for (const [w, h] of [
      [390, 844],
      [820, 1180],
      [1440, 900],
    ]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(500);
      await explore(page).click();
      await menu(page).waitFor({ state: "visible", timeout: 8000 });
      await page.waitForTimeout(400);
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      if (over) overflow += `${w} `;
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
    step(!overflow, "no horizontal overflow at 390 / 820 / 1440", overflow);

    // ── the docked composer offers no Explore ───────────────────────────────
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("#chat-composer").fill("Reply with exactly: OK");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 30000 });
    await page.waitForTimeout(4000);
    step(
      (await explore(page).count()) === 0,
      "an existing thread shows no Explore control",
    );
  } catch (e) {
    step(false, "unexpected failure", String(e.message ?? e).slice(0, 220));
  } finally {
    await b.close();
  }

  step(errs.length === 0, "zero console errors", errs.slice(0, 3).join(" | "));

  const pass = results.filter((r) => r[0]).length;
  console.log(`\n===== EXPLORE: ${pass}/${results.length} =====`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
