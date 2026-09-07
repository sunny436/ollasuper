// Phase-13 verification — run AFTER enabling AI_ORCHESTRATED_RUNTIME_ENABLED on prod.
// Proves the orchestrated runtime is live WITHOUT regressing the basics:
//   V1 research+report task → substantive structured answer + tool activity (skills
//      should activate; the model may delegate to a specialist — checked via journald).
//   V2 trivial task → still answered directly (no over-orchestration).
//   V3 streaming preserved → the answer is non-trivial and the turn used >1 flush
//      (checked server-side: generation_finished.flushes > 1).
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const errs = [], net = [], results = [], threads = [];

const gen = (page) => page.getByRole("button", { name: "Stop generating" });
const settle = async (page, ms = 240000) => { const dl = Date.now() + ms; while (Date.now() < dl) { if ((await gen(page).count()) === 0) return true; await page.waitForTimeout(300); } return false; };
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
  console.log("P13_START " + new Date().toISOString());

  await step("V1 research+report task → substantive structured answer", async () => {
    const { body, acted } = await ask(page, "v1-research",
      "Research the main differences between HTTP/2 and HTTP/3, compare their trade-offs, " +
      "and give me a short actionable recommendation for a new web API.");
    if (!acted && body.length < 400) throw new Error("no tool activity and thin answer");
    if (!/http\/?3|quic|http\/?2|latency|multiplex/.test(body)) throw new Error("not a substantive comparison");
    if (/task failed|something went wrong|unable to complete/.test(body)) throw new Error("orchestrated turn surfaced a bare failure");
  });

  await step("V2 trivial task → answered directly (no over-orchestration)", async () => {
    const { body, acted } = await ask(page, "v2-simple", "What is 2 + 2?");
    if (!/\b4\b|four/.test(body)) throw new Error("wrong answer");
    if (acted) throw new Error("over-orchestrated a trivial arithmetic ask");
  });

  console.log("P13_END " + new Date().toISOString());
  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== P13: ${passed}/${results.length} | console: ${errs.length} | net: ${net.length} =====`);
  for (const e of errs) console.log("  console: " + e);
  for (const n of net) console.log("  " + n);
  console.log("THREADS " + JSON.stringify(threads));
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
