// Remove scheduled tasks left behind by this phase's test runs.
//
// Only titles matching the known test prefixes are touched — production is
// someone's real workspace, and a cleanup script that guesses is worse than
// leftovers. Anything it does not recognise is listed and left alone.
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";

// Every prefix this phase's scripts create tasks under.
const TEST_PREFIXES = ["e2e-sched", "p5-accept", "p5-diag", "restart-drill"];
const isMine = (title) => TEST_PREFIXES.some((p) => title.includes(p));

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 30 });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);

  const rows = () =>
    page
      .locator("div.group")
      .filter({ has: page.getByRole("button", { name: "Task actions" }) });

  let removed = 0;
  const kept = [];
  for (let pass = 0; pass < 25; pass++) {
    await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    // "All", so paused and completed test tasks are visible too.
    const filter = page.getByRole("button", { name: /Active|Paused|All/ });
    if (await filter.count()) {
      await filter.first().click();
      await page.waitForTimeout(300);
      const all = page.getByRole("menuitem", { name: "All" });
      if (await all.count()) await all.click();
      await page.waitForTimeout(1500);
    }

    const n = await rows().count();
    let target = null;
    for (let i = 0; i < n; i++) {
      const title = (await rows().nth(i).innerText()).split("\n")[0];
      if (isMine(title)) {
        target = i;
        break;
      }
      if (!kept.includes(title)) kept.push(title);
    }
    if (target === null) break;

    const row = rows().nth(target);
    await row.hover();
    await row.getByRole("button", { name: "Task actions" }).click();
    await page.waitForTimeout(400);
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await page.waitForTimeout(2500);
    removed++;
  }

  console.log(`removed ${removed} test task(s)`);
  console.log(`left alone (${kept.length}): ${kept.join(" | ") || "none"}`);
  await b.close();
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
