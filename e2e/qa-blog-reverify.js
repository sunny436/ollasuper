// Re-verify the req5/6 fixes on prod:
//  FILE: uploaded draft scored WITHOUT failed URL-audits ("Some steps didn't
//        complete" gone) + the exact 5-category rubric.
//  ANALYZE(URL): the EXACT 5 categories (Content/SEO/E-E-A-T/Technical/AI-Citation),
//        not improvised Discoverability/Answerability.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-blog-reverify.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const TARGET = process.env.QA_TARGET || "https://www.networkershome.com/";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 360000);
const SAMPLE = process.env.QA_FILE ||
  "C:/Users/test/AppData/Local/Temp/claude/c--Users-test-Downloads-OllaSuper/93c1b126-e678-463e-bcf7-56ed5f4c04e9/scratchpad/sample-blog.md";

const results = [];
const errs = [];
const need = (c, m) => { if (!c) throw new Error(m); };
const step = async (n, f) => {
  try { await f(); results.push(true); console.log("PASS  " + n); }
  catch (e) { results.push(false); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); }
};
const settle = async (page, ms) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ timeout: 40000 }).catch(() => {});
  const d = Date.now() + ms;
  while (Date.now() < d && (await stop.count()) > 0) await page.waitForTimeout(700);
};
const answer = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll("div.my-5")];
  return rows[rows.length - 1]?.innerText || "";
});
const pillHeader = (page) => page.evaluate(() => {
  const s = document.querySelector("[data-agent-activity] summary");
  return s ? s.innerText.replace(/\s+/g, " ").trim() : "";
});
// the exact five rubric labels must ALL be present
const hasFiveCats = (t) => {
  const low = t.toLowerCase();
  return ["content quality", "seo", "e-e-a-t", "technical", "ai-citation"].every((c) => low.includes(c));
};

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 20 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);

  await step("[FILE] uploaded draft: NO failed audits + 5-category score", async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
    await page.locator('input[type="file"]').setInputFiles(SAMPLE);
    await page.waitForTimeout(4000);
    await page.locator("#chat-composer").fill("Analyze this uploaded blog draft and score it.");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
    await settle(page, WAIT_MS);
    const header = await pillHeader(page);
    const r = await answer(page);
    console.log("    pill header: " + JSON.stringify(header));
    console.log("\n---- [FILE] FULL ----\n" + r + "\n---- END ----\n");
    need(!/didn.?t complete|some steps failed/i.test(header), "URL-audit still failed on the draft: " + header);
    need(hasFiveCats(r), "FILE score did not use the exact 5-category rubric");
    need(!r.toLowerCase().includes("_endpoint"), "raw endpoint name");
  });

  await step("[ANALYZE url] EXACT 5-category rubric (not improvised)", async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
    await page.locator("#chat-composer").fill(`Analyze the page at ${TARGET} and score it.`);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
    await settle(page, WAIT_MS);
    const r = await answer(page);
    console.log("\n---- [ANALYZE] FULL ----\n" + r + "\n---- END ----\n");
    need(hasFiveCats(r), "ANALYZE did not use the exact 5-category rubric");
    need(!/discoverability|answerability/i.test(r), "ANALYZE still improvised non-rubric categories");
    need(r.toLowerCase().includes("not a") && r.toLowerCase().includes("ranking"), "missing not-a-ranking caption");
    need(!r.toLowerCase().includes("_endpoint"), "raw endpoint name");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log("\n===== BLOG-REVERIFY: " + passed + "/" + results.length + " | console errors: " + errs.length + " =====");
  for (const e of [...new Set(errs)].slice(0, 8)) console.log("  ! " + e.slice(0, 160));
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
