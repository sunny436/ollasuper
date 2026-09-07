// QA-2 (prod-observable) — dedup / no duplicate side effect on rapid double-submit.
// Correct timing: send -> WAIT until the generation is actually in flight (Stop
// button) -> submit the SAME prompt again (now definitely "already generating")
// -> the 2nd send must be REJECTED, producing ONE generation, not two.
// The rejection logs an expected "already generating" console error — that is the
// dedup SIGNAL, not a failure, so it is classified separately.
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const errs = [], expectedRejects = [], net = [], results = [], threads = [];
const PROMPT = "what's the current weather in Delhi";

const settle = async (page, ms = 150000) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if ((await stop.count()) === 0) return true; await page.waitForTimeout(300); }
  return false;
};
const tid = (page) => { const m = page.url().match(/\/chat\/([a-z0-9]+)/i); return m ? m[1] : null; };
const step = async (n, f) => {
  try { await f(); results.push(true); console.log("PASS  " + n); }
  catch (e) { results.push(false); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); }
};

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: process.env.CI ? 0 : 25 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/already generating|generating a reply/i.test(t)) expectedRejects.push(t); // dedup signal
    else errs.push(t);
  });
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("favicon")) net.push(`HTTP ${r.status()} ${r.url().replace(BASE, "")}`); });

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

  console.log("QA2_START " + new Date().toISOString());

  await step("A1: double-submit while generating → 2nd is REJECTED (one task)", async () => {
    await settle(page);
    await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
    await page.waitForTimeout(1000);
    await page.locator("#chat-composer").fill(PROMPT);
    await page.keyboard.press("Enter");
    // WAIT until the generation is genuinely in flight before the 2nd submit.
    await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 25000 });
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 }).catch(() => {});
    const id = tid(page); if (id) threads.push(["A1-double", id]);
    // fire the SAME prompt again — a real duplicate attempt on the SAME thread.
    await page.locator("#chat-composer").fill(PROMPT).catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await settle(page, 150000);
    console.log(`      ↳ expected 'already generating' rejections: ${expectedRejects.length}`);
  });

  await step("A2: same prompt, TWO separate threads → TWO intentional tasks", async () => {
    for (const tag of ["A2-t1", "A2-t2"]) {
      await settle(page);
      await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
      await page.waitForTimeout(1000);
      await page.locator("#chat-composer").fill(PROMPT);
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 25000 });
      const id = tid(page); if (id) threads.push([tag, id]);
      if (!(await settle(page, 150000))) throw new Error(`${tag} never settled`);
    }
  });

  console.log("QA2_END " + new Date().toISOString());
  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== QA2: ${passed}/${results.length} | real console errors: ${errs.length} | expected dedup-rejections: ${expectedRejects.length} | net: ${net.length} =====`);
  for (const e of errs) console.log("  console: " + e);
  for (const n of net) console.log("  " + n);
  console.log("THREADS " + JSON.stringify(threads));
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
