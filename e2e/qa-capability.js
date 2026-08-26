// Capability-decision matrix — verifies AUTONOMOUS source selection on prod.
// NATURAL prompts only (no "search on web" / "use RAG" hints). Balanced:
// as many "must NOT use a tool" as "must use a tool" (over-use is a regression).
//   E2E_BASE_URL=https://app.ollasuper.com  node qa-capability.js   (headed)
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const errs = [], net = [], results = [], threads = [];

const settle = async (page, ms = 150000) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if ((await stop.count()) === 0) return true; await page.waitForTimeout(300); }
  return false;
};
const tid = (page) => { const m = page.url().match(/\/chat\/([a-z0-9]+)/i); return m ? m[1] : null; };

async function ask(page, label, text) {
  await settle(page);
  await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.waitForSelector("#chat-composer", { timeout: 10000 });
  await page.locator("#chat-composer").fill(text);
  const t0 = Date.now();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 }).catch(() => {});
  const id = tid(page); if (id) threads.push([label, id]);
  await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 25000 }).catch(() => {});
  let toolUI = false;
  const dl = Date.now() + 50000;
  while (Date.now() < dl) {
    if ((await page.locator("[data-agent-activity]").count()) > 0) { toolUI = true; break; }
    if ((await page.getByRole("button", { name: "Stop generating" }).count()) === 0 && Date.now() - t0 > 6000) break;
    await page.waitForTimeout(500);
  }
  await settle(page, 160000);
  const body = await page.evaluate(() => document.body.innerText || "");
  console.log(`      ↳ [${label}] tool_ui=${toolUI} ${Date.now() - t0}ms thread=${id}`);
  return { toolUI, body };
}

// expectTool=true  -> the model MUST autonomously use a tool (no hint given)
// expectTool=false -> the model MUST NOT use a tool (answer directly / from context)
function check(label, prompt, expectTool, bodyMust) {
  return async (page) => {
    const r = await ask(page, label, prompt);
    if (expectTool && !r.toolUI)
      throw new Error("expected an autonomous tool call, but NONE ran (under-use / the reported bug)");
    if (!expectTool && r.toolUI)
      throw new Error("a tool ran for stable knowledge (OVER-use regression)");
    if (bodyMust && !bodyMust.test(r.body))
      throw new Error("answer content check failed");
  };
}

const step = async (n, f, page) => {
  try { await f(page); results.push(true); console.log("PASS  " + n); }
  catch (e) { results.push(false); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); }
};

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: process.env.CI ? 0 : 25 });
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
  }, page);

  // ---- MUST autonomously use the web (natural prompts, NO hint) ----
  await step("current price → web (THE reported bug)",
    check("macbook", "what is the current macbook air m5 price in india", true), page);
  await step("live weather → web",
    check("weather", "what's the weather in Delhi right now", true), page);
  await step("latest news → web",
    check("news", "what is the latest news about SpaceX today", true), page);

  // ---- MUST NOT use a tool (over-use guard) ----
  await step("stable knowledge → direct (no tool)",
    check("capital", "what is the capital of Japan", false, /tokyo/i), page);
  await step("arithmetic → direct (no tool)",
    check("math", "what is 17 times 23", false, /391/), page);
  await step("concept explanation → direct (no tool)",
    check("recursion", "explain recursion simply in two sentences", false), page);

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== CAPABILITY: ${passed}/${results.length} | console: ${errs.length} | net: ${net.length} =====`);
  for (const e of errs) console.log("  console: " + e);
  for (const n of net) console.log("  " + n);
  console.log("THREADS " + JSON.stringify(threads));
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
