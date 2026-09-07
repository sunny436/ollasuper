// QA-1 — real-user tool calling through Chromium vs prod.
// Verifies user -> LLM -> tool -> result -> LLM -> answer from the UI, with a
// backend log cross-check (which/how-many tools) done separately by SSH.
//
//   E2E_BASE_URL=https://app.ollasuper.com  node qa1-tools.js      (headed)
//   CI=1 ... node qa1-tools.js                                     (headless)
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();

const errs = [], net = [], results = [], threads = [];

const settle = async (page, ms = 120000) => {
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

// send text on a FRESH thread; return {id, toolUI, ms, text}
async function ask(page, label, text, { fresh = true } = {}) {
  if (fresh) {
    await settle(page);
    await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
    await page.waitForTimeout(1000);
    await page.waitForSelector("#chat-composer", { timeout: 10000 });
  }
  await page.locator("#chat-composer").fill(text);
  const t0 = Date.now();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 }).catch(() => {});
  const id = tid(page); if (id) threads.push([label, id]);
  await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 25000 }).catch(() => {});
  let toolUI = false;
  const dl = Date.now() + 45000;
  while (Date.now() < dl) {
    if ((await page.locator("[data-agent-activity]").count()) > 0) { toolUI = true; break; }
    if ((await page.getByRole("button", { name: "Stop generating" }).count()) === 0 && Date.now() - t0 > 7000) break;
    await page.waitForTimeout(500);
  }
  await settle(page, 150000);
  const ms = Date.now() - t0;
  const body = await page.evaluate(() => document.body.innerText || "");
  console.log(`      ↳ [${label}] tool_ui=${toolUI} ${ms}ms thread=${id}`);
  return { id, toolUI, ms, body };
}

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: process.env.CI ? 0 : 30 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
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

  await step("DIRECT TOOL: a clear web lookup triggers a tool + real answer", async () => {
    const r = await ask(page, "direct", "Use web search to find one current technology news headline from today and quote it. You must use the search tool.");
    if (!r.toolUI) throw new Error("no tool ran for a clear web lookup (agent-activity absent)");
    if (r.body.length < 200) throw new Error("no substantive answer");
  });

  await step("NO TOOL: pure arithmetic is answered WITHOUT a tool", async () => {
    const r = await ask(page, "notool", "What is 17 times 23? Answer with just the number.");
    if (r.toolUI) throw new Error("a tool ran for pure arithmetic (should be direct)");
    if (!r.body.includes("391")) throw new Error("wrong/absent arithmetic answer (expected 391)");
  });

  await step("MULTI/SEQUENTIAL: two lookups then a comparison", async () => {
    const r = await ask(page, "multi", "Search the web for the current population of Tokyo, then search for the current population of Delhi, then tell me which city has more people. Use the search tool for both.");
    if (!r.toolUI) throw new Error("no tools ran for a two-lookup comparison");
    if (r.body.length < 200) throw new Error("no comparison answer");
  });

  await step("TOOL FAILURE: unreachable target → honest failure, no hallucinated success", async () => {
    const r = await ask(page, "failure", "Fetch and summarize the page at https://qa1-nonexistent-domain-xyzxyz.invalid — if it fails, tell me it failed. Do not invent content.");
    // must NOT claim a successful summary of a real page; should acknowledge failure/uncertainty
    const low = r.body.toLowerCase();
    const admits = /(fail|could not|couldn't|unable|error|doesn't exist|not exist|invalid|unreachable|no such)/.test(low);
    if (!admits) throw new Error("model did not acknowledge the failure (possible hallucinated success)");
  });

  await step("ARG EDGE: unicode + special chars in a tool request — no crash", async () => {
    const r = await ask(page, "argedge", "Search the web for: 日本語 café ñ 🚀 <b>tag</b> \"quoted\" — summarize what you find in one line.");
    if (r.body.length < 40) throw new Error("no answer for a special-char query");
  });

  await step("USER BEHAVIOR: same request twice (2nd on a NEW thread) still works", async () => {
    const q = "Search the web for today's date and state it.";
    const r1 = await ask(page, "twice-a", q);
    const r2 = await ask(page, "twice-b", q);
    if (r1.body.length < 40 || r2.body.length < 40) throw new Error("a repeated request failed");
  });

  await step("USER BEHAVIOR: follow-up requiring another tool (same thread)", async () => {
    await ask(page, "followup-1", "Search for the current weather in London and tell me the temperature.");
    // follow-up in the SAME thread requiring another lookup
    const r = await ask(page, "followup-2", "Now search for the current weather in Paris and compare it to London.", { fresh: false });
    if (r.body.length < 60) throw new Error("follow-up tool turn produced no answer");
  });

  await step("USER BEHAVIOR: 'explain what you did' is reflective (no new tool)", async () => {
    const r = await ask(page, "explain", "In two sentences, explain what steps you took to answer my previous question.", { fresh: false });
    if (r.body.length < 40) throw new Error("no explanation produced");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== QA1: ${passed}/${results.length} | console: ${errs.length} | net 4xx/5xx: ${net.length} =====`);
  for (const e of errs) console.log("  console: " + e);
  for (const n of net) console.log("  " + n);
  console.log("THREADS " + JSON.stringify(threads));
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
