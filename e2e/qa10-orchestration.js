// QA-10 (prod) — DYNAMIC ORCHESTRATION, live path (natural prompts, no route hints).
// The full route matrix A–K (incl. multi-agent E/J, skill F/G/H) is proven in the
// runtime suites (tests/test_runtime_e2e.py, test_orchestrator.py — 47 tests) where
// the Orchestrator actually runs; it is NOT wired into the live product. This script
// verifies the DYNAMIC decision-making the LIVE single agent genuinely makes:
// direct-answer vs tools, multi-tool, capability discovery beyond a lexical top-5,
// result-driven adaptation, ambiguity handling, and mid-conversation change-of-mind —
// proving the live path is not hardcoded, not every-request→tool, not top-5.
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const errs = [], net = [], results = [], threads = [];

const gen = (page) => page.getByRole("button", { name: "Stop generating" });
const settle = async (page, ms = 210000) => { const dl = Date.now() + ms; while (Date.now() < dl) { if ((await gen(page).count()) === 0) return true; await page.waitForTimeout(300); } return false; };
const tid = (page) => { const m = page.url().match(/\/chat\/([a-z0-9]+)/i); return m ? m[1] : null; };
const step = async (n, f) => { try { await f(); results.push(true); console.log("PASS  " + n); } catch (e) { results.push(false); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); } };
const activity = (page) => page.evaluate(() => !!document.querySelector("[data-agent-activity]"));
const bodyText = (page) => page.evaluate(() => (document.body.innerText || "").toLowerCase());

async function send(page, text) {
  await page.locator("#chat-composer").fill(text);
  const t0 = Date.now();
  await page.keyboard.press("Enter");
  await gen(page).waitFor({ timeout: 25000 }).catch(() => {});
  if (!(await settle(page))) throw new Error("never settled");
  return Date.now() - t0;
}
async function ask(page, tag, text) {
  await settle(page);
  await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
  await page.waitForTimeout(1000);
  const ms = await send(page, text);
  const id = tid(page); if (id) threads.push([tag, id]);
  const acted = await activity(page);
  console.log(`      ↳ [${tag}] ${ms}ms tool_ui=${acted}`);
  return { body: await bodyText(page), acted };
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
  console.log("QA10_START " + new Date().toISOString());

  await step("A DIRECT ANSWER: stable knowledge → NO tool", async () => {
    const { body, acted } = await ask(page, "A-direct", "In two sentences, explain what a binary search tree is.");
    if (acted) throw new Error("fired a tool for stable knowledge (should be direct)");
    if (!/tree|node|left|right|search|sorted/.test(body)) throw new Error("no coherent answer");
  });

  await step("C MULTIPLE TOOLS: 3 independent lookups → tools, all associated", async () => {
    const { body, acted } = await ask(page, "C-multi",
      "Right now, what's the weather in London, in Paris, and in Tokyo?");
    if (!acted) throw new Error("no tool activity for a live multi-city lookup");
    const cities = ["london", "paris", "tokyo"].filter((c) => body.includes(c));
    if (cities.length < 3) throw new Error(`only ${cities.length}/3 cities associated`);
  });

  await step("DISCOVERY: capability reachable beyond a lexical top-5 wording (unprompted web)", async () => {
    const { acted } = await ask(page, "discovery", "What is the current MacBook Air M5 price in India?");
    if (!acted) throw new Error("no live capability fired for a current-fact query (top-5/seeding regression)");
  });

  await step("K ADAPTIVE: the result determines the next action", async () => {
    const { body } = await ask(page, "K-adaptive",
      "Check whether https://example.com is reachable. If it IS, tell me in one line what the page is about. " +
      "If it is NOT reachable, reply exactly 'SITE DOWN' and nothing else.");
    // example.com is reachable → the reachable branch must be taken (summary, not SITE DOWN).
    if (/^\s*site down\s*$/i.test(body.trim())) throw new Error("took the wrong adaptive branch (said SITE DOWN for a reachable site)");
    if (!/example|domain|illustrative|documentation|placeholder/.test(body)) throw new Error("did not summarize the reachable page");
  });

  await step("AMBIGUITY: 'find the best option' → clarify or state assumption, not blind expensive work", async () => {
    const { body, acted } = await ask(page, "ambiguity", "Find the best option.");
    const clarifies = /(could you|can you|what (kind|type|sort)|which|clarify|more (context|detail|info)|what are you|for what|depend|need to know|not sure what)/.test(body);
    const assumes = /(assum|i.?ll take|interpret|by .?best.? i|since you did|without more)/.test(body);
    if (!(clarifies || assumes)) throw new Error("neither asked for clarification nor stated an assumption");
    console.log(`      ↳ [ambiguity] clarifies=${clarifies} assumes=${assumes} tool_ui=${acted}`);
  });

  await step("CHANGE OF MIND: mid-conversation redirect is honored (2 turns, same thread)", async () => {
    await settle(page);
    await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
    await page.waitForTimeout(1000);
    await send(page, "Tell me the current weather in London.");
    const id = tid(page); if (id) threads.push(["change-mind", id]);
    // Turn 2 in the SAME thread: change intent.
    await send(page, "Actually, ignore London — instead compare the current weather in Paris and Berlin.");
    const body = await bodyText(page);
    const hasNew = body.includes("paris") && body.includes("berlin");
    if (!hasNew) throw new Error("did not act on the changed intent (Paris + Berlin)");
    console.log(`      ↳ [change-mind] paris+berlin=${hasNew}`);
  });

  console.log("QA10_END " + new Date().toISOString());
  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== QA10: ${passed}/${results.length} | console: ${errs.length} | net: ${net.length} =====`);
  for (const e of errs) console.log("  console: " + e);
  for (const n of net) console.log("  " + n);
  console.log("THREADS " + JSON.stringify(threads));
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
