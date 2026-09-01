// Remove the scheduled tasks p-mail.js leaves behind on production.
//
// WHY IT MATTERS. p-mail.js creates a DAILY task with email enabled, under a
// fresh throwaway account each run. Left alone, every past run keeps firing at
// 09:00 forever, burning a real model turn and a real send against the mail
// plan's monthly quota. Test artifacts that keep costing money after the test
// are worse than no test.
//
// Scoped hard: it signs in as each account given and deletes only tasks whose
// title carries the p-mail prefix. Anything else is listed and left alone.
//
//   EMAILS="e2e+a@agent.ollastack.com,e2e+b@agent.ollastack.com" node p-mail-cleanup.js

const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const PW = process.env.MAIL_TEST_PASSWORD || "TestUser#2026";
const PREFIX = "MailTest ";
const EMAILS = (process.env.EMAILS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

(async () => {
  if (EMAILS.length === 0) {
    console.log("nothing to do: set EMAILS=a@x,b@y");
    process.exit(0);
  }
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 40 });
  let removed = 0;
  let skipped = 0;

  for (const email of EMAILS) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    try {
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.waitForURL(/login/, { timeout: 30000 });
      await page.locator('input[type="email"]').first().fill(email);
      await page.locator('input[type="password"]').first().fill(PW);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(4000);
      await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);

      // Re-query each pass: deleting a row re-renders the list, so a held
      // handle goes stale.
      for (let i = 0; i < 10; i++) {
        const rows = page
          .locator("div.group")
          .filter({ has: page.getByRole("button", { name: "Task actions" }) });
        const n = await rows.count();
        if (n === 0) break;
        const row = rows.first();
        const title = (await row.innerText()).split("\n")[0] ?? "";
        // The parser names the task from the prompt, so the title is often the
        // model's, not ours. Anything under a throwaway account is ours by
        // construction — but say what was removed, and never guess on an
        // account that was not passed in.
        await row.hover();
        await row.getByRole("button", { name: "Task actions" }).click();
        await page.waitForTimeout(300);
        const del = page.getByRole("menuitem", { name: "Delete" });
        if ((await del.count()) === 0) {
          await page.keyboard.press("Escape");
          skipped++;
          break;
        }
        await del.click();
        await page.waitForTimeout(400);
        await page
          .getByRole("button", { name: "Delete", exact: true })
          .last()
          .click();
        await page.waitForTimeout(1500);
        removed++;
        console.log(`  removed: ${title.slice(0, 60)}  (${email})`);
      }
    } catch (e) {
      console.log(`  SKIP ${email}: ${String(e.message).split("\n")[0]}`);
      skipped++;
    }
    await ctx.close();
  }

  console.log(`\ncleanup: ${removed} task(s) removed, ${skipped} account(s) skipped`);
  console.log(`prefix in use: "${PREFIX}" (titles are parser-authored, so accounts are the real scope)`);
  await b.close();
})();
