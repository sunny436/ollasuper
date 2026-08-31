// Headed diagnostic for the three remaining p-scheduled failures.
// Observes real DOM state instead of guessing at it. Read-only apart from the
// one task it creates and deletes.
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 40 });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("  CONSOLE-ERROR: " + m.text().slice(0, 140));
  });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);

  // ── 1. keyboard reachability: how far away IS the composer? ───────────────
  await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const railLinks = await page
    .locator('nav[aria-label="Conversations"] a, nav[aria-label="Conversations"] button')
    .count();
  console.log(`\n[1] focusable controls in the rail: ${railLinks}`);
  let steps = -1;
  const seen = [];
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      return el
        ? {
            tag: el.tagName,
            label: el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 28),
          }
        : null;
    });
    if (i < 12) seen.push(`${info?.tag}:${info?.label}`);
    if (info?.label === "Schedule a task") { steps = i + 1; break; }
  }
  console.log(`    composer reached after ${steps} tabs WITHOUT the skip link`);
  console.log(`    first stops: ${seen.join(" -> ")}`);

  // A skip link is ACTIVATED, not tabbed past — measure it the way it is used.
  await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.keyboard.press("Tab");
  const firstLabel = await page.evaluate(() =>
    (document.activeElement?.textContent || "").trim(),
  );
  await page.keyboard.press("Enter");
  let viaSkip = -1;
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Tab");
    const l = await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    );
    if (l === "Schedule a task") {
      viaSkip = i + 1;
      break;
    }
  }
  console.log(
    `    first tab stop = "${firstLabel}"; composer is ${viaSkip} tabs after activating it`,
  );

  // ── 2. the notification dialog's real switch order ───────────────────────
  await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  // Do not depend on a task already existing — the e2e run deletes its own.
  if ((await page.locator("div.group").filter({ has: page.getByRole("button", { name: "Task actions" }) }).count()) === 0) {
    const box = page.getByRole("textbox", { name: "Schedule a task" });
    await box.fill("p5-diag probe - every day at 9am, summarise my open items");
    await page.getByRole("button", { name: "Interpret schedule" }).click();
    await page
      .getByRole("textbox", { name: "Task instruction" })
      .waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "Create task" }).click();
    await page.waitForTimeout(4000);
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    console.log("    [created a probe task]");
  }
  const row = page.locator("div.group").filter({ has: page.getByRole("button", { name: "Task actions" }) }).first();
  if (await row.count()) {
    await row.hover();
    await row.getByRole("button", { name: "Task actions" }).click();
    await page.waitForTimeout(400);
    await page.getByRole("menuitem", { name: "Notification settings" }).click();
    await page.waitForTimeout(1200);
    const n = await page.getByRole("switch").count();
    console.log(`\n[2] switches in the dialog: ${n}`);
    for (let i = 0; i < n; i++) {
      const sw = page.getByRole("switch").nth(i);
      const state = await sw.getAttribute("data-state");
      const disabled = await sw.isDisabled();
      const label = await sw
        .locator("xpath=ancestor::label[1]")
        .innerText()
        .catch(() => "?");
      console.log(`    [${i}] ${state}${disabled ? " (disabled)" : ""}  ${label.replace(/\n/g, " | ").slice(0, 70)}`);
    }
    await page.keyboard.press("Escape");
  } else {
    console.log("\n[2] no task row to open");
  }

  // ── 3. what a live run actually renders ──────────────────────────────────
  if (await row.count()) {
    await page.waitForTimeout(500);
    await row.hover();
    await row.getByRole("button", { name: "Task actions" }).click();
    await page.waitForTimeout(400);
    const runNow = page.getByRole("menuitem", { name: "Run now" });
    if (!(await runNow.isDisabled())) {
      await runNow.click();
      console.log("\n[3] Run now clicked; sampling the panel for 60s");
      await row.click();
      for (let s = 0; s < 12; s++) {
        await page.waitForTimeout(5000);
        const aside = page.locator("aside");
        const txt = (await aside.count()) ? await aside.innerText() : "";
        const spin = await page.locator(".animate-spin").count();
        const status = (txt.match(/(Running|Queued|Retrying|Completed|Failed|Cancelled)/g) || []).join(",");
        console.log(`    t+${(s + 1) * 5}s  spinners=${spin}  statuses=[${status}]`);
        if (/Completed|Failed/.test(txt)) break;
      }
    } else {
      console.log("\n[3] Run now disabled — skipping");
      await page.keyboard.press("Escape");
    }
  }

  await b.close();
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
