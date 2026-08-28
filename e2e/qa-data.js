// Data Analysis — prod acceptance (headed Chrome on app.ollasuper.com).
// Upload a CSV → analysis via COMPUTE tools (not raw-data dump); follow-up with NO
// re-upload uses the same dataset; anomaly detection; a chart when asked; a normal
// chat is unaffected. Prints full outputs; asserts behavior; 0 console errors.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-data.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 240000);
const SAMPLE =
  process.env.QA_FILE ||
  "C:/Users/test/AppData/Local/Temp/claude/c--Users-test-Downloads-OllaSuper/93c1b126-e678-463e-bcf7-56ed5f4c04e9/scratchpad/sales.csv";

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
  while (Date.now() < d && (await stop.count()) > 0) await page.waitForTimeout(700);
  await page.waitForTimeout(1200);
};
const lastMsg = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    const last = rows[rows.length - 1];
    const pill = last?.querySelector("[data-agent-activity]");
    return {
      text: last?.innerText || "",
      pill: pill ? pill.innerText.replace(/\s+/g, " ").trim() : "",
      canvases: last ? last.querySelectorAll("canvas").length : 0,
    };
  });
const noRaw = (t) =>
  !t.toLowerCase().includes("_endpoint") &&
  !t.toLowerCase().includes("find capabilities") &&
  !/profile_dataset|sql_query|detect_outliers/.test(t);
// send a prompt in the CURRENT thread (follow-up) — no navigation, no re-upload
async function followUp(page, prompt) {
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 60000 });
  await page.locator("#chat-composer").fill(prompt);
  await page.keyboard.press("Enter");
  await settle(page, WAIT_MS);
  return lastMsg(page);
}
const show = (tag, r) =>
  console.log(`\n---- [${tag}] pill:${JSON.stringify(r.pill).slice(0, 160)} canvases:${r.canvases}\n${r.text}\n---- END ${tag} ----\n`);

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

  // 1) Upload + analyze — must COMPUTE, name the weak region, not dump the CSV.
  await step("[ANALYZE] upload CSV → computed analysis", async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
    await page.locator('input[type="file"]').setInputFiles(SAMPLE);
    await page.waitForTimeout(4000);
    await page
      .locator("#chat-composer")
      .fill(
        "Analyze this sales data. What's happening to revenue over the months, " +
          "which region needs the most improvement, and why?",
      );
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
    await settle(page, WAIT_MS);
    const r = await lastMsg(page);
    show("ANALYZE", r);
    // Tools ran => the pill reports steps (the collapsed header shows the COUNT, not
    // names). A pure no-tool answer has an empty pill.
    const steps = Number((r.pill.match(/(\d+)\s*steps?/i) || [])[1] || 0);
    need(steps >= 3, "data tools did not run (pill: " + r.pill + ")");
    need(/west|north|south|region/i.test(r.text), "no regional analysis");
    need((r.text.match(/\d[\d,]*\.?\d*/g) || []).length > 5, "no computed numbers");
    need(noRaw(r.text), "raw tool identifier or CSV leaked");
  });

  // 2) Follow-up with NO re-upload — the dataset must persist.
  await step("[FOLLOW-UP] anomaly on the same dataset, no re-upload", async () => {
    const r = await followUp(page, "Find any anomalies or outliers in the data.");
    show("ANOMALY", r);
    need(!/upload|attach|provide the (file|data|dataset)/i.test(r.text.slice(0, 300)), "asked to re-upload on a follow-up");
    need(/outlier|anomal|1200|54000|54,000/i.test(r.text), "did not surface the outlier from the same dataset");
    need(noRaw(r.text), "raw identifier leaked");
  });

  // 3) A chart when asked — renders inline as a canvas.
  await step("[CHART] chart the monthly trend inline", async () => {
    const r = await followUp(page, "Chart the total revenue by month.");
    show("CHART", r);
    need(r.canvases >= 1, "no chart canvas rendered for an explicit chart request");
    need(noRaw(r.text), "raw identifier leaked");
  });

  // 4) Regression — a normal chat has no data tools and works.
  await step("[REGRESSION] normal chat unaffected", async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
    await page.locator("#chat-composer").fill("In one sentence, what is a CDN?");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
    await settle(page, 60000);
    const r = await lastMsg(page);
    need(/cdn|content delivery|network/i.test(r.text), "normal chat broke");
    need(r.canvases === 0, "a chart leaked into a normal answer");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log("\n===== DATA-QA: " + passed + "/" + results.length + " | console errors: " + errs.length + " =====");
  for (const e of [...new Set(errs)].slice(0, 10)) console.log("  ! " + e.slice(0, 160));
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
