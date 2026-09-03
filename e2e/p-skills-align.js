// Skills menu — corners, centring and label, on the real deployment.
//
// Deliberately NOT part of p-explore.js: that suite signs up a fresh user and so
// needs OLLASTACK_MAIL_TOKEN, which is not available here, meaning any assertion
// added there could never actually run. This logs in as the admin (the p-chat.js
// pattern) and reaches the same landing state.
//
//   E2E_BASE_URL=https://app.ollasuper.com node p-skills-align.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const WIDTHS = (process.env.QA_WIDTHS || "1280,1440,1920").split(",").map(Number);

const errs = [];
const results = [];
const step = (ok, name, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const skills = (page) => page.getByRole("button", { name: "Skills" });
const menu = (page) => page.locator('[role="menu"][data-state="open"]');

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 15000 });
    await page.waitForTimeout(900); // let the centred spring settle before measuring

    if (width === WIDTHS[0]) {
      step(await skills(page).isVisible(), 'the control is labelled "Skills"');
    }

    await skills(page).click();
    await menu(page).waitFor({ state: "visible", timeout: 8000 });
    await page.waitForTimeout(450); // popper settle

    const shell = await page.locator("[data-composer-shell]").boundingBox();
    const panel = await menu(page).boundingBox();

    // Centred on the COMPOSER, not on the trigger. Pre-fix this was ~200px out:
    // align="start" anchored the panel's left edge to the Skills button, which
    // sits left-of-centre in the composer.
    const shellMid = shell.x + shell.width / 2;
    const panelMid = panel.x + panel.width / 2;
    const delta = Math.abs(shellMid - panelMid);
    step(
      delta <= 4,
      `panel is centred on the composer @${width}w`,
      `panel mid ${Math.round(panelMid)} vs composer mid ${Math.round(shellMid)} (d=${Math.round(delta)}px)`,
    );

    step(
      Math.abs(panel.width - shell.width) <= 4,
      `panel width matches the composer @${width}w`,
      `${Math.round(panel.width)} vs ${Math.round(shell.width)}`,
    );

    // Measured against the TEXTAREA, not the shell: `sideOffset` is relative to
    // the trigger, which sits inside the pill's py-3 padding, so the panel's box
    // legitimately reaches ~11px into the shell's top edge with no visual overlap.
    // `data-side` is the real invariant — that floating-ui did not flip it below.
    const ta = await page.locator("#chat-composer").boundingBox();
    const side = await menu(page).evaluate((el) => el.getAttribute("data-side"));
    step(
      side === "top" && panel.y + panel.height <= ta.y,
      `the panel opens above the composer @${width}w`,
      `side=${side}, panel bottom ${Math.round(panel.y + panel.height)} vs textarea top ${Math.round(ta.y)}`,
    );

    if (width === WIDTHS[0]) {
      const radius = await menu(page).evaluate(
        (el) => getComputedStyle(el).borderTopLeftRadius,
      );
      step(
        Number.parseFloat(radius) >= 12,
        "the panel has the softened corner radius",
        radius,
      );
    }

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }

  const passed = results.filter(Boolean).length;
  console.log(
    `\n===== SKILLS-ALIGN: ${passed}/${results.length} | console errors: ${errs.length} =====`,
  );
  if (errs.length) console.log(errs.slice(0, 5).join("\n"));
  await b.close();
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})();
