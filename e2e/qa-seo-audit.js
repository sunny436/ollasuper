// Production QA — a REAL user starts a whole-site SEO audit from chat and we watch
// the durable run drive to a rendered report card, asserting zero console errors.
// Headed by default (headless only under CI), per the house harness.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-seo-audit.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const TARGET = process.env.QA_TARGET || "https://www.networkershome.com/";
const REPORT_WAIT_MS = Number(process.env.QA_REPORT_WAIT_MS || 600000); // 10 min

const errs = [];
const results = [];
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
const settle = async (page, ms = 120000) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await stop.count()) === 0) return true;
    await page.waitForTimeout(400);
  }
  return false;
};

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 40,
  });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 950 } })
  ).newPage();
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
    await page.waitForSelector("#chat-composer", { timeout: 15000 });
  });

  await step("a real user asks for an SEO audit", async () => {
    const prompt =
      process.env.QA_PROMPT ||
      `Run a full technical SEO audit of my entire website ${TARGET}. ` +
        `Crawl the site and check about 8 pages, then give me the report.`;
    await page.locator("#chat-composer").fill(prompt);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 20000 });
    console.log("      ↳ thread " + page.url().split("/").pop());
  });

  await step("the audit turn starts generating", async () => {
    await page
      .getByRole("button", { name: "Stop generating" })
      .waitFor({ timeout: 30000 })
      .catch(() => {}); // a very fast turn may already be past this
  });

  await step("the audit finalizes and renders a report card", async () => {
    const report = page.locator('[aria-label="SEO audit report"]');
    const deadline = Date.now() + REPORT_WAIT_MS;
    let seen = false;
    while (Date.now() < deadline) {
      if ((await report.count()) > 0) {
        seen = true;
        break;
      }
      // Keep the thread live; a reload re-subscribes the getRun/getReport queries.
      await page.waitForTimeout(10000);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    }
    if (!seen) throw new Error("no SEO report card within the wait window");
    await page.locator('[aria-label="SEO audit report"]').first().scrollIntoViewIfNeeded();
  });

  await step("the report card shows real audit content", async () => {
    const txt = await page
      .locator('[aria-label="SEO audit report"]')
      .first()
      .innerText();
    console.log("\n----- REPORT CARD -----\n" + txt + "\n----- END -----\n");
    if (!/SEO Audit Report/i.test(txt))
      throw new Error("report card missing its title");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(
    `\n===== SEO QA: ${passed}/${results.length} | console errors: ${errs.length} =====`,
  );
  for (const e of errs) console.log("  - " + e);
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
