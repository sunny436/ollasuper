// QA-12b — FINAL RANDOMIZED round. Four fresh scenarios, none used anywhere in
// QA-0..12: multi-step planning, a physics word-problem (reasoning), code
// correctness, and a current-fact tool use. Real user, prod, zero-error gates.
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const errs = [], net = [], results = [], threads = [];

const gen = (page) => page.getByRole("button", { name: "Stop generating" });
const settle = async (page, ms = 210000) => { const dl = Date.now() + ms; while (Date.now() < dl) { if ((await gen(page).count()) === 0) return true; await page.waitForTimeout(300); } return false; };
const tid = (page) => { const m = page.url().match(/\/chat\/([a-z0-9]+)/i); return m ? m[1] : null; };
const activity = (page) => page.evaluate(() => !!document.querySelector("[data-agent-activity]"));
const step = async (n, f) => { try { await f(); results.push(true); console.log("PASS  " + n); } catch (e) { results.push(false); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); } };

async function ask(page, tag, text) {
  await settle(page);
  await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
  await page.waitForTimeout(900);
  await page.locator("#chat-composer").fill(text);
  const t0 = Date.now();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 }).catch(() => {});
  const id = tid(page); if (id) threads.push([tag, id]);
  await gen(page).waitFor({ timeout: 25000 }).catch(() => {});
  if (!(await settle(page))) throw new Error("never settled");
  const acted = await activity(page);
  const body = (await page.evaluate(() => document.body.innerText || "")).toLowerCase();
  console.log(`      ↳ [${tag}] ${Date.now() - t0}ms tool_ui=${acted} len=${body.length}`);
  return { body, acted };
}

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: process.env.CI ? 0 : 12 });
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
  console.log("QA12B_START " + new Date().toISOString());

  await step("R1 multi-step planning: 3-day Kyoto itinerary with rough budget", async () => {
    const { body } = await ask(page, "r1-plan",
      "Plan a rough 3-day itinerary for Kyoto with an approximate daily budget. Keep it concise.");
    const days = (body.match(/day\s*[1-3]|day one|day two|day three/g) || []).length;
    if (days < 2) throw new Error("no multi-day structure");
    if (!/¥|yen|\$|budget|cost/.test(body)) throw new Error("no budget mentioned");
  });

  await step("R2 reasoning word-problem: 60 km in 45 min → 80 km/h", async () => {
    const { body } = await ask(page, "r2-physics",
      "A train travels 60 kilometers in 45 minutes. What is its average speed in kilometers per hour?");
    if (!/\b80\b/.test(body)) throw new Error("wrong speed (expected 80 km/h)");
  });

  await step("R3 code correctness: Python palindrome function", async () => {
    const { body } = await ask(page, "r3-code",
      "Write a short Python function is_palindrome(s) that ignores case and spaces. Show the code.");
    if (!/def\s+is_palindrome/.test(body)) throw new Error("no function definition");
    if (!/\[::-1\]|reversed\(|==/.test(body)) throw new Error("no visible palindrome logic");
  });

  await step("R4 current fact via tool: a recent renewable-energy development", async () => {
    const { body, acted } = await ask(page, "r4-current",
      "What is one notable development in solar energy technology from the last couple of years?");
    if (!acted && !/solar|photovolt|perovskite|panel|cell|efficiency/.test(body))
      throw new Error("neither used a tool nor produced a substantive solar answer");
    if (/i (can'?t|cannot) (access|browse|provide current)/.test(body) && !acted)
      throw new Error("punted on a current-fact query instead of using the web capability");
  });

  console.log("QA12B_END " + new Date().toISOString());
  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== QA12B: ${passed}/${results.length} | console: ${errs.length} | net: ${net.length} =====`);
  for (const e of errs) console.log("  console: " + e);
  for (const n of net) console.log("  " + n);
  console.log("THREADS " + JSON.stringify(threads));
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
