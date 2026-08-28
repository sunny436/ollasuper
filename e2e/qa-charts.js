// Chart.js inline rendering — prod acceptance (headed Chrome on app.ollasuper.com).
// Verifies: a chart spec is generated, passed to the frontend, and Chart.js renders
// it as a <canvas> INSIDE the chat message; multiple charts render independently;
// existing chat still works; 0 console errors.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-charts.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 180000);

const results = [];
const errs = [];
const need = (c, m) => {
  if (!c) throw new Error(m);
};
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
  await stop.waitFor({ timeout: 40000 }).catch(() => {});
  const d = Date.now() + ms;
  while (Date.now() < d && (await stop.count()) > 0) await page.waitForTimeout(600);
  await page.waitForTimeout(1500); // let the canvas mount after finalize
};
// canvases + text of the LAST assistant message row.
const lastMsg = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    const last = rows[rows.length - 1];
    return {
      canvases: last ? last.querySelectorAll("canvas").length : 0,
      text: last?.innerText || "",
    };
  });
async function ask(page, prompt) {
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
  await page.locator("#chat-composer").fill(prompt);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
  await settle(page, WAIT_MS);
  return lastMsg(page);
}

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

  // 1) A single chart renders as a <canvas> inside the message (not raw JSON).
  await step("[SINGLE] a bar chart renders inline as a canvas", async () => {
    const r = await ask(
      page,
      "Show this as a bar chart: Jan 10, Feb 25, Mar 18, Apr 30. Add a one-line note.",
    );
    console.log("    canvases=" + r.canvases);
    need(r.canvases >= 1, "no <canvas> rendered in the message");
    need(!r.text.includes('"datasets"'), "raw chart JSON leaked as text (not rendered)");
  });

  // 2) Multiple charts render independently in the same message.
  await step("[MULTI] several chart types render independently", async () => {
    const r = await ask(
      page,
      "Give me THREE charts: (a) a bar chart of sales Q1 100, Q2 140, Q3 90, Q4 160; " +
        "(b) a line chart of the same trend; (c) a pie chart of market share A 50, " +
        "B 30, C 20. Briefly interpret each.",
    );
    console.log("    canvases=" + r.canvases);
    need(r.canvases >= 2, "expected multiple independent canvases, got " + r.canvases);
    need(!r.text.includes('"datasets"'), "raw chart JSON leaked as text");
  });

  // 3) Existing chat is unaffected — a normal answer has NO chart and works.
  await step("[REGRESSION] a normal answer works and has no chart", async () => {
    const r = await ask(page, "In one sentence, what is a CDN?");
    need(/cdn|content delivery|network/i.test(r.text), "normal answer broke");
    need(r.canvases === 0, "a chart leaked into a non-chart answer");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(
    "\n===== CHARTS-QA: " +
      passed +
      "/" +
      results.length +
      " | console errors: " +
      errs.length +
      " =====",
  );
  for (const e of [...new Set(errs)].slice(0, 10)) console.log("  ! " + e.slice(0, 160));
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
