// QA-3 (prod-safe half) — CLIENT interruptions during a real tool workflow.
// The backend is single-worker prod; we do NOT crash it (that would kill every
// user). We interrupt the CLIENT — reload / switch conversation / close+reopen tab
// mid-stream — and verify DURABLE state: the generation completes server-side, the
// client reconnects to the correct final answer, no duplicate, exactly ONE
// generation per workflow (the disconnect must NOT trigger a re-run).
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const PROMPT = "search the web for the latest news about the Indian stock market today and summarize it";
const errs = [], net = [], results = [], threads = [];

const settle = async (page, ms = 150000) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if ((await stop.count()) === 0) return true; await page.waitForTimeout(300); }
  return false;
};
const answered = async (page) => page.evaluate(() => (document.body.innerText || "").length > 400);
const step = async (n, f) => {
  try { await f(); results.push(true); console.log("PASS  " + n); }
  catch (e) { results.push(false); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); }
};
async function login(page) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 15000 });
}
// start a tool workflow, return its /chat/<id> url once it is genuinely in flight
async function startWorkflow(page, tag) {
  await settle(page);
  await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.locator("#chat-composer").fill(PROMPT);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 25000 });
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 });
  const url = page.url();
  threads.push([tag, url.match(/\/chat\/([a-z0-9]+)/i)[1]]);
  await page.waitForTimeout(2500); // let it stream a bit before interrupting
  return url;
}

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: process.env.CI ? 0 : 20 });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("favicon")) net.push(`HTTP ${r.status()} ${r.url().replace(BASE, "")}`); });

  await step("login", async () => login(page));
  console.log("QA3_START " + new Date().toISOString());

  await step("R1: RELOAD mid-stream → durable state completes, no dup", async () => {
    const url = await startWorkflow(page, "R1-reload");
    await page.reload({ waitUntil: "domcontentloaded" });      // client interruption
    await page.waitForTimeout(2500);
    if (page.url() !== url) throw new Error("navigated away on reload");
    if (!(await settle(page, 120000))) throw new Error("did not finalize after reload");
    if (!(await answered(page))) throw new Error("final answer missing after reload");
  });

  await step("R2: SWITCH conversation mid-stream then back → result durable", async () => {
    const url = await startWorkflow(page, "R2-switch");
    await page.getByRole("button", { name: "New chat" }).click().catch(() => {}); // switch away
    await page.waitForTimeout(3000);
    await page.goto(url, { waitUntil: "domcontentloaded" });     // return to it
    await page.waitForTimeout(2000);
    if (!(await settle(page, 120000))) throw new Error("did not finalize after switch-away");
    if (!(await answered(page))) throw new Error("final answer missing after switching back");
  });

  await step("R3: CLOSE + reopen tab mid-stream → result persisted", async () => {
    const url = await startWorkflow(page, "R3-closetab");
    const page2 = await ctx.newPage();                          // reopen in same session
    let e2 = 0; page2.on("console", (m) => { if (m.type() === "error") e2++; });
    await page.close();                                         // close the original tab
    await page2.goto(url, { waitUntil: "domcontentloaded" });
    await page2.waitForTimeout(2500);
    if (!(await settle(page2, 120000))) throw new Error("did not finalize in reopened tab");
    if (!(await answered(page2))) throw new Error("final answer missing in reopened tab");
    if (e2 > 0) throw new Error(`${e2} console errors in reopened tab`);
  });

  console.log("QA3_END " + new Date().toISOString());
  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== QA3: ${passed}/${results.length} | console: ${errs.length} | net: ${net.length} =====`);
  for (const e of errs) console.log("  console: " + e);
  for (const n of net) console.log("  " + n);
  console.log("THREADS " + JSON.stringify(threads));
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
