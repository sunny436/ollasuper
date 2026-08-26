// QA-6 (prod) — context correctness + graceful limits, real user.
// The point isn't "did it answer" — it's: under large context does it KEEP the
// instruction, and do limits degrade GRACEFULLY (coherent answer, not silent fail)?
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const errs = [], net = [], results = [], threads = [];
const FILLER = ("The archival ledger notes routine maintenance and nothing of substance. ").repeat(560); // ~40k chars

const gen = (page) => page.getByRole("button", { name: "Stop generating" });
const settle = async (page, ms = 150000) => { const dl = Date.now() + ms; while (Date.now() < dl) { if ((await gen(page).count()) === 0) return true; await page.waitForTimeout(300); } return false; };
const tid = (page) => { const m = page.url().match(/\/chat\/([a-z0-9]+)/i); return m ? m[1] : null; };
const step = async (n, f) => { try { await f(); results.push(true); console.log("PASS  " + n); } catch (e) { results.push(false); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); } };

async function ask(page, tag, text) {
  await settle(page);
  await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.locator("#chat-composer").fill(text);
  const t0 = Date.now();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 20000 }).catch(() => {});
  const id = tid(page); if (id) threads.push([tag, id]);
  await gen(page).waitFor({ timeout: 25000 }).catch(() => {});
  if (!(await settle(page, 200000))) throw new Error("never settled (possible hang/overflow)");
  const body = await page.evaluate(() => document.body.innerText || "");
  console.log(`      ↳ [${tag}] ${Date.now() - t0}ms len=${body.length}`);
  return body;
}

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: process.env.CI ? 0 : 15 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("favicon")) net.push(`HTTP ${r.status()} ${r.url().replace(BASE, "")}`); });

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]'); await page.waitForTimeout(3500);
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 15000 });
  });
  console.log("QA6_START " + new Date().toISOString());

  await step("CC1: instruction at START survives ~40k of filler", async () => {
    const body = await ask(page, "cc1",
      "IMPORTANT RULE: end your entire reply with the exact token QA6KEEPA.\n\n" + FILLER +
      "\n\nNow, ignoring the filler above, name one primary color in a short sentence.");
    if (!/QA6KEEPA/.test(body)) throw new Error("lost the START instruction under large context");
  });

  await step("CC2: RECENT instruction (after ~40k filler) is honored", async () => {
    const body = await ask(page, "cc2",
      FILLER + "\n\nIMPORTANT RULE: end your entire reply with the exact token QA6KEEPB. " +
      "Also, name one ocean in the same reply.");
    if (!/QA6KEEPB/.test(body)) throw new Error("lost the RECENT instruction under large context");
  });

  await step("CC3: huge ~60k message → bounded, completes, no overflow/crash", async () => {
    const huge = FILLER + FILLER.slice(0, 20000); // ~60k, over the 48k turn cap → must be bounded
    const body = await ask(page, "cc3", huge + "\n\nIn one word, what is 2+2?");
    if (!/\b4\b|four/i.test(body)) throw new Error("no coherent answer after a huge bounded input");
  });

  await step("LIMIT: complex many-step task → GRACEFUL bounded answer (not 'Task failed')", async () => {
    const body = await ask(page, "limit",
      "Research and compare the current prices, key specifications, and general reception of several popular " +
      "laptops suitable for AI development, then give me a clear recommendation with reasoning.");
    if (/task failed|something went wrong|i (?:was )?unable to complete|error occurred/i.test(body))
      throw new Error("limit surfaced as a bare failure, not a graceful bounded answer");
    if (body.length < 400) throw new Error("no substantive synthesis produced under the step limit");
  });

  console.log("QA6_END " + new Date().toISOString());
  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== QA6: ${passed}/${results.length} | console: ${errs.length} | net: ${net.length} =====`);
  for (const e of errs) console.log("  console: " + e);
  for (const n of net) console.log("  " + n);
  console.log("THREADS " + JSON.stringify(threads));
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
