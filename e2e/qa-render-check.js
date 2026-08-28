// Currency-render fix verification (headed Chrome on app.ollasuper.com).
// Asks for a sentence with several $ amounts; asserts the rendered answer contains
// LITERAL "$10"/"$20" and NO .katex elements (single-$ no longer parsed as math).
//   E2E_BASE_URL=https://app.ollasuper.com node qa-render-check.js
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const errs = [];

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 20 });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 950 } })
  ).newPage();
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);

  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
  await page
    .locator("#chat-composer")
    .fill(
      "In one sentence, list these monthly prices exactly: Basic is $10, Pro is " +
        "$20, and Enterprise is $30 per user.",
    );
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ timeout: 40000 }).catch(() => {});
  const d = Date.now() + 90000;
  while (Date.now() < d && (await stop.count()) > 0) await page.waitForTimeout(600);
  await page.waitForTimeout(1500);

  const r = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    const last = rows[rows.length - 1];
    return {
      text: last?.innerText || "",
      katex: last ? last.querySelectorAll(".katex").length : -1,
    };
  });
  console.log("\n---- ANSWER ----\n" + r.text + "\n---- katex elements: " + r.katex + " ----\n");

  const literalDollars = (r.text.match(/\$\d/g) || []).length;
  const pass =
    r.katex === 0 &&
    literalDollars >= 2 &&
    /\$10/.test(r.text) &&
    errs.length === 0;
  console.log(
    "RENDER-CHECK: katex=" +
      r.katex +
      " literal$=" +
      literalDollars +
      " consoleErrors=" +
      errs.length +
      " => " +
      (pass ? "PASS" : "FAIL"),
  );
  await b.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
