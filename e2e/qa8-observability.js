// QA-8 (prod) — OBSERVABILITY: can a real workflow be reconstructed, and does the
// UI agree with the backend? Real user, natural prompts. Three scenarios whose
// UI-vs-backend reconciliation is observable through headed Chrome; the rest of the
// 8 shapes (parallel/retry/approval/crash) are proven by the deterministic ledger
// suites (chat.events/durable/approvals.test.ts, test_ledger/recovery/parallel).
//
// The UI↔backend JOIN key is the threadId in the URL: journald `generation_finished`
// carries thread_id + stream_id + user_id + status, so each printed threadId can be
// matched to its fully-correlated backend record.
//
//   OBS1 COMPLETED-TOOL : a tool turn settles with EVERY run resolved (no run stuck
//                         "running") — the UI timeline reflects the backend terminal.
//   OBS2 SIMPLE         : a text-only answer settles coherently (its model-decision
//                         trace is backend-only; the UI timeline correctly shows none).
//   OBS3 STOP (H2)      : a stop mid-tool leaves NO dangling "running" run on the
//                         settled message — proving the refutation (abort purges events).
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const errs = [], net = [], results = [], threads = [];

const gen = (page) => page.getByRole("button", { name: "Stop generating" });
const settle = async (page, ms = 200000) => { const dl = Date.now() + ms; while (Date.now() < dl) { if ((await gen(page).count()) === 0) return true; await page.waitForTimeout(300); } return false; };
const tid = (page) => { const m = page.url().match(/\/chat\/([a-z0-9]+)/i); return m ? m[1] : null; };
const step = async (n, f) => { try { await f(); results.push(true); console.log("PASS  " + n); } catch (e) { results.push(false); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); } };

// The settled agent-activity subtree, and whether any run is still "running" (its
// label renders with a trailing "…" only while running — see agent-activity.tsx).
async function activity(page) {
  return await page.evaluate(() => {
    const el = document.querySelector("[data-agent-activity]");
    if (!el) return { present: false, text: "", running: 0 };
    const text = el.innerText || "";
    const running = (text.match(/…/g) || []).length;
    return { present: true, text, running };
  });
}

async function newChat(page) {
  await settle(page);
  await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
  await page.waitForTimeout(1000);
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
  console.log("QA8_START " + new Date().toISOString());

  await step("OBS1 COMPLETED-TOOL: timeline settles with no run stuck 'running'", async () => {
    await newChat(page);
    await page.locator("#chat-composer").fill(
      "What's the current weather in Tokyo right now?");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 }).catch(() => {});
    const id = tid(page); if (id) threads.push(["obs1-tool", id]);
    await gen(page).waitFor({ timeout: 25000 }).catch(() => {});
    if (!(await settle(page, 200000))) throw new Error("never settled");
    const a = await activity(page);
    console.log(`      ↳ [obs1] activity present=${a.present} running=${a.running}`);
    if (!a.present) throw new Error("no agent-activity timeline for a tool turn");
    if (a.running !== 0) throw new Error(`${a.running} run(s) stuck 'running' on a settled message`);
  });

  await step("OBS2 SIMPLE: text-only answer settles coherently (trace is backend-only)", async () => {
    await newChat(page);
    await page.locator("#chat-composer").fill("In one sentence, explain what a hash map is.");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 }).catch(() => {});
    const id = tid(page); if (id) threads.push(["obs2-simple", id]);
    await gen(page).waitFor({ timeout: 25000 }).catch(() => {});
    if (!(await settle(page, 120000))) throw new Error("never settled");
    const body = (await page.evaluate(() => document.body.innerText || "")).toLowerCase();
    const a = await activity(page);
    console.log(`      ↳ [obs2] activity present=${a.present} len=${body.length}`);
    if (!/hash|key|value|map|bucket/.test(body)) throw new Error("no coherent answer");
    // A text-only turn may show no timeline (MODEL_CALL is backend-only) — but if it
    // does show one, it too must be settled.
    if (a.present && a.running !== 0) throw new Error("simple turn left a run 'running'");
  });

  await step("OBS3 STOP (H2 refutation): no dangling 'running' run after a mid-tool stop", async () => {
    await newChat(page);
    await page.locator("#chat-composer").fill(
      "Search the web for the latest news about renewable energy and summarize the top items.");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 }).catch(() => {});
    const id = tid(page); if (id) threads.push(["obs3-stop", id]);
    // Wait until it is actually generating (a tool likely mid-flight), then STOP.
    await gen(page).waitFor({ timeout: 25000 });
    await page.waitForTimeout(3500); // let a tool start
    await gen(page).click().catch(() => {});
    if (!(await settle(page, 60000))) throw new Error("did not settle after stop");
    await page.waitForTimeout(1500); // let the aborted message repaint
    const a = await activity(page);
    console.log(`      ↳ [obs3] after stop: activity present=${a.present} running=${a.running}`);
    // The refutation: a stopped message purges its events → either no timeline, or
    // a timeline with NO run stuck 'running'. A permanent spinner would be the bug.
    if (a.running !== 0) throw new Error(`${a.running} run(s) stuck 'running' on a STOPPED message (H2 would-be bug)`);
  });

  console.log("QA8_END " + new Date().toISOString());
  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== QA8: ${passed}/${results.length} | console: ${errs.length} | net: ${net.length} =====`);
  for (const e of errs) console.log("  console: " + e);
  for (const n of net) console.log("  " + n);
  console.log("THREADS " + JSON.stringify(threads));
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
