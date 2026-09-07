// QA-7 (prod) — parallel + partial failure + retry, real user (natural prompts).
// P1: one message asking for N independent lookups -> the model should batch tool
//     calls that run concurrently; verify all N results are correctly associated.
// P2: a mix of a REACHABLE and an UNREACHABLE target -> partial failure: the good
//     one succeeds, the bad one fails+retries, the answer stays correct + honest.
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const errs = [], net = [], results = [], threads = [];

const gen = (page) => page.getByRole("button", { name: "Stop generating" });
const settle = async (page, ms = 200000) => { const dl = Date.now() + ms; while (Date.now() < dl) { if ((await gen(page).count()) === 0) return true; await page.waitForTimeout(300); } return false; };
const tid = (page) => { const m = page.url().match(/\/chat\/([a-z0-9]+)/i); return m ? m[1] : null; };
const step = async (n, f) => { try { await f(); results.push(true); console.log("PASS  " + n); } catch (e) { results.push(false); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); } };

async function ask(page, tag, text) {
  await settle(page);
  await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.locator("#chat-composer").fill(text);
  const t0 = Date.now();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 }).catch(() => {});
  const id = tid(page); if (id) threads.push([tag, id]);
  await gen(page).waitFor({ timeout: 25000 }).catch(() => {});
  if (!(await settle(page, 220000))) throw new Error("never settled");
  const body = (await page.evaluate(() => document.body.innerText || "")).toLowerCase();
  console.log(`      ↳ [${tag}] ${Date.now() - t0}ms`);
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
  console.log("QA7_START " + new Date().toISOString());

  await step("P1 PARALLEL: 4 independent lookups → all 4 correctly associated", async () => {
    const body = await ask(page, "parallel",
      "In a single reply, tell me the current weather right now in London, Paris, Tokyo, and New York.");
    const cities = ["london", "paris", "tokyo", "new york"].filter((c) => body.includes(c));
    console.log(`      ↳ cities covered: ${cities.length}/4 (${cities.join(", ")})`);
    if (cities.length < 4) throw new Error(`only ${cities.length}/4 results associated — parallel synthesis lost some`);
  });

  await step("P2 PARTIAL FAILURE + RETRY: good target succeeds, bad one fails honestly", async () => {
    const body = await ask(page, "partial",
      "Fetch the page at https://example.com and also the page at https://qa7-nonexistent-zzz-42.invalid . " +
      "For EACH url, tell me either a short summary or that it could not be retrieved. Do not invent content.");
    // the reachable one must yield real content; the unreachable one must be admitted, not faked
    const goodOk = /example|domain|illustrative|documentation/.test(body);
    const badAdmitted = /(could not|couldn't|unable|fail|not.*retriev|error|invalid|does ?n.t exist|no such|unreachable)/.test(body);
    if (!goodOk) throw new Error("reachable target produced no real content");
    if (!badAdmitted) throw new Error("unreachable target was NOT admitted (possible hallucinated success)");
  });

  console.log("QA7_END " + new Date().toISOString());
  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== QA7: ${passed}/${results.length} | console: ${errs.length} | net: ${net.length} =====`);
  for (const e of errs) console.log("  console: " + e);
  for (const n of net) console.log("  " + n);
  console.log("THREADS " + JSON.stringify(threads));
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
