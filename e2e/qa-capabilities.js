// Capability self-awareness — prod acceptance (headed Chrome on app.ollasuper.com).
// "What can you do?" must name the ACTUAL specialized capabilities (SEO, data
// analysis, charts, blog, research, file generation) — not the old generic list;
// capability-specific questions answered by real availability; normal chat unaffected.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-capabilities.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const WAIT_MS = Number(process.env.QA_WAIT_MS || 90000);

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
  while (Date.now() < d && (await stop.count()) > 0) await page.waitForTimeout(500);
  await page.waitForTimeout(1000);
};
const answer = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    return rows[rows.length - 1]?.innerText || "";
  });
async function ask(page, prompt) {
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
  await page.locator("#chat-composer").fill(prompt);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
  await settle(page, WAIT_MS);
  return answer(page);
}
const show = (tag, t) => console.log(`\n---- [${tag}] ----\n${t}\n---- END ----\n`);
const noRaw = (t) =>
  !/skill_id|ai_[a-z_]*enabled|_endpoint|\.py\b|storageid/i.test(t);

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

  // 1) "What can you do?" — must name the SPECIALIZED capabilities, not the generic list.
  await step("[WHAT] names the actual specialized capabilities", async () => {
    const t = await ask(page, "What capabilities do you have and what can you do for me?");
    show("WHAT", t);
    const low = t.toLowerCase();
    const hits = [
      /seo/.test(low),
      /data anal|analyz.*(csv|excel|data)|dataset/.test(low),
      /chart|visuali/.test(low),
      /blog|writing|content/.test(low),
      /research/.test(low),
      /file|pdf|document|excel|word/.test(low),
    ].filter(Boolean).length;
    need(hits >= 5, "answer did not reflect the real specialized capabilities (hits=" + hits + ")");
    need(/seo/.test(low), "did not mention SEO specifically");
    need(noRaw(t), "leaked internal detail (skill_id/flag/path)");
  });

  // 2) Capability-specific, contextual — no dataset yet.
  await step("[CONTEXT] can you analyze my CSV → yes, upload it", async () => {
    const t = await ask(page, "Can you analyze my sales CSV file?");
    show("CONTEXT", t);
    need(/yes|can|able|upload|attach|share/i.test(t), "did not affirm data-analysis");
    need(/upload|attach|share|send|provide/i.test(t), "did not note it needs the file");
    need(noRaw(t), "leaked internal detail");
  });

  // 3) Capability-specific — SEO is enabled.
  await step("[SEO] can you do an SEO audit → yes", async () => {
    const t = await ask(page, "Can you perform an SEO audit of a website?");
    show("SEO-Q", t);
    need(/yes|can|able|absolutely|sure/i.test(t) && /seo|audit/i.test(t), "did not affirm SEO");
    need(noRaw(t), "leaked internal detail");
  });

  // 4) Regression — a normal question still works.
  await step("[REGRESSION] normal chat unaffected", async () => {
    const t = await ask(page, "In one sentence, what is a hash map?");
    need(/hash|map|key|value|data structure/i.test(t), "normal chat broke");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log("\n===== CAPABILITIES-QA: " + passed + "/" + results.length + " | console errors: " + errs.length + " =====");
  for (const e of [...new Set(errs)].slice(0, 8)) console.log("  ! " + e.slice(0, 160));
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
