// qa-router3.js — three real chat turns on production, one per tier.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-router3.js
//
// Each turn must stream a real answer with zero console errors. WHICH model
// served it is read from the server's `router.selected` log afterwards (the UI
// deliberately shows no model), so this prints each thread id to match against.
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";

const TURNS = [
  { tier: "easy", text: "What is a mutex?" },
  { tier: "medium", text: "Write a short onboarding email for new customers of a project-management app." },
  {
    tier: "complex",
    text: "Walk me through the risks of migrating a live payments database from MySQL to Postgres, and recommend a rollout plan.",
  },
];

const errs = [];
const results = [];

(async () => {
  const b = await chromium.launch({ channel: "chrome", headless: false, slowMo: 20 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push(`pageerror ${e.message}`));

  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);

    for (const t of TURNS) {
      const started = Date.now();
      await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
      await page.locator("#chat-composer").fill(t.text);
      await page.keyboard.press("Enter");
      await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 30000 });
      const stop = page.getByRole("button", { name: "Stop generating" });
      await stop.waitFor({ timeout: 60000 }).catch(() => {});
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline && (await stop.count()) > 0) await page.waitForTimeout(700);
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("div.my-5")];
        return rows[rows.length - 1]?.innerText || "";
      });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const failed = /had a problem|took too long|could not complete|could not reach/i.test(text);
      const ok = text.length > 120 && !failed;
      results.push({ ...t, ok, secs, chars: text.length, thread: page.url().split("/").pop() });
      console.log(`${ok ? "PASS" : "FAIL"}  ${t.tier.padEnd(8)} ${secs}s  ${text.length} chars  thread ${page.url().split("/").pop()}`);
      if (!ok) console.log(`      ${text.slice(0, 200).replace(/\s+/g, " ")}`);
    }
  } finally {
    await b.close();
  }
  const benign = errs.filter((e) => !/favicon|third-party cookie/i.test(e));
  console.log(`\n${results.filter((r) => r.ok).length}/${TURNS.length} answered · console errors: ${benign.length}`);
  for (const e of benign.slice(0, 5)) console.log(`  ${e.slice(0, 160)}`);
  process.exit(results.every((r) => r.ok) && !benign.length ? 0 : 1);
})();
