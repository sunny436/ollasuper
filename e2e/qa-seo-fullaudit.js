// Focused re-test: does a FULL SEO audit now COMPLETE (crawl-fallback) with a
// health score, multiple categories, no harmony leak, zero console errors?
//   E2E_BASE_URL=https://app.ollasuper.com node qa-seo-fullaudit.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const TARGET = process.env.QA_TARGET || "https://www.networkershome.com/";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 330000);

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
const settle = async (page, ms) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ timeout: 30000 }).catch(() => {});
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await stop.count()) === 0) return true;
    await page.waitForTimeout(500);
  }
  return false;
};

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 30 });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 950 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon"))
      errs.push(`HTTP ${r.status()} ${r.url()}`);
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

  await step("full audit streams to completion", async () => {
    await page
      .locator("#chat-composer")
      .fill(`Do a FULL SEO audit of ${TARGET} — crawl the key pages and cover everything.`);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
    if (!(await settle(page, WAIT_MS)))
      throw new Error("generation did not finish within the wait window");
  });

  const report = await page.evaluate(() => {
    const nodes = [
      ...document.querySelectorAll(
        "[data-message-role='assistant'], .prose, article",
      ),
    ];
    let best = "";
    for (const n of nodes) if ((n.innerText || "").length > best.length) best = n.innerText;
    return best || document.body.innerText;
  });
  console.log(
    "\n===== FULL AUDIT REPORT (first 3500 chars) =====\n" +
      report.slice(0, 3500) +
      `\n===== END (len=${report.length}) =====\n`,
  );
  const low = report.toLowerCase();
  const need = (c, m) => {
    if (!c) throw new Error(m);
  };

  await step("no harmony tool-call leak", async () =>
    need(
      !low.includes("to=functions.") && !low.includes("multi_tool_use.parallel"),
      "harmony leak present",
    ),
  );
  await step("audit COMPLETED with an overall SEO health score", async () =>
    need(low.includes("seo health") || /\b\d{1,3}\/100\b/.test(report), "no overall health score"),
  );
  await step("multi-category coverage", async () => {
    const cats = ["crawl", "on-page", "technical", "content", "index"].filter((k) =>
      low.includes(k),
    );
    need(cats.length >= 3, "not multi-category; cats=" + cats.join(","));
  });
  await step("not an empty 'incomplete/abandoned' report", async () =>
    need(
      !(low.includes("audit status: incomplete") || low.includes("i couldn't complete the audit")),
      "audit was abandoned instead of falling back",
    ),
  );

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(
    `\n===== FULL-AUDIT QA: ${passed}/${results.length} | console errors: ${errs.length} =====`,
  );
  for (const e of errs) console.log("  - " + e);
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
