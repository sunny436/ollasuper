// QA — model catalogue + Gemini tool-schema fix (prod, headed Chrome, real user).
//
// Guards the two defects fixed on 2026-08-27:
//   1. `generate_file` declared a bare inner `{"type":"array"}`, which Gemini's
//      function-declaration validator rejects — every Gemini turn died on turn 1
//      with the generic "Something went wrong" card. The filegen prompt below is
//      the exact shape that failed, so a pass proves the schema is accepted.
//   2. Ollima's /v1/models advertises ~63 ids of which ~29 answer. The picker
//      offered all of them, so most picks were dead on arrival.
//
// A plain reply is NOT sufficient evidence for (1): the tool must actually be
// bound and its schema accepted, which only the download-card case proves.
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const errs = [], net = [], results = [];

// Ids measured unservable on prod. Any of these in the picker is a regression.
const MUST_BE_ABSENT = [
  "claude-haiku-4.5", "claude-sonnet-4.6", "gemma3-4b", "gemma3-12b",
  "gemma3-27b", "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "gpt-4o-mini",
  "gpt-5-mini", "gpt-5-nano", "gpt-5.4-nano", "deepseek-v3.1", "deepseek-v3.2",
  "devstral", "devstral-small", "qwen3-coder", "qwen3-next-80b", "gemma4",
  "gpt-oss-20b", "nemotron-nano", "minimax-m2.1", "ministral-3b",
];
const SPOT_CHECK = ["gpt-5.6-luna", "deepseek-v4", "qwen3.5", "minimax-m3"];

const gen = (page) => page.getByRole("button", { name: "Stop generating" });
const settle = async (page, ms = 200000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    if ((await gen(page).count()) === 0) return true;
    await page.waitForTimeout(300);
  }
  return false;
};
const step = async (n, f) => {
  try { await f(); results.push(true); console.log("PASS  " + n); }
  catch (e) { results.push(false); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); }
};

async function openPicker(page) {
  await page.getByRole("button", { name: "Choose model" }).click();
  await page.getByRole("textbox", { name: "Search models" }).waitFor({ timeout: 8000 });
}

async function listedIds(page) {
  await openPicker(page);
  const ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll("span.font-geist-mono")).map((n) => n.textContent.trim())
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  return ids.filter(Boolean);
}

async function pick(page, modelId) {
  await openPicker(page);
  await page.getByRole("textbox", { name: "Search models" }).fill(modelId);
  await page.waitForTimeout(500);
  await page.locator("button", { hasText: modelId }).last().click();
  await page.waitForTimeout(600);
}

async function ask(page, prompt) {
  await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
  await page.waitForTimeout(900);
  await page.locator("#chat-composer").fill(prompt);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 }).catch(() => {});
  await gen(page).waitFor({ timeout: 25000 }).catch(() => {});
  if (!(await settle(page))) throw new Error("never settled");
  const body = await page.evaluate(() => document.body.innerText);
  if (/Something went wrong/i.test(body)) throw new Error("error card rendered");
  return body;
}

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: process.env.CI ? 0 : 10 });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
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

  let ids = [];
  await step("catalogue offers only serving models", async () => {
    ids = await listedIds(page);
    console.log(`      ↳ picker lists ${ids.length}: ${ids.join(", ")}`);
    if (ids.length === 0) throw new Error("picker empty");
    const bad = MUST_BE_ABSENT.filter((d) => ids.includes(d));
    if (bad.length) throw new Error("dead ids still offered: " + bad.join(", "));
    if (ids.length > 40) throw new Error(`still unfiltered (${ids.length} ids)`);
    if (!ids.includes("gemini-3.1-flash-lite")) throw new Error("gemini-3.1-flash-lite missing");
  });

  await step("gemini-3.1-flash-lite — plain prompt streams", async () => {
    await pick(page, "gemini-3.1-flash-lite");
    const body = await ask(page, "In one short sentence, what is the capital of France?");
    if (!/paris/i.test(body)) throw new Error("no substantive answer: " + body.slice(-160));
  });

  await step("gemini-3.1-flash-lite — filegen tool (the schema that 400'd)", async () => {
    const body = await ask(page,
      "Make an Excel spreadsheet with a sheet of 5 rows, columns Month and Revenue (Jan..May with numbers).");
    const card = await page.locator("[data-artifact-download]").count();
    if (card === 0) throw new Error("no download card — tool not invoked: " + body.slice(-200));
    console.log("      ↳ download card present (tool schema accepted)");
  });

  for (const m of SPOT_CHECK) {
    await step(`spot-check ${m}`, async () => {
      await pick(page, m);
      const body = await ask(page, "Reply with exactly the word: READY");
      if (!/ready/i.test(body)) throw new Error("no answer: " + body.slice(-160));
    });
  }

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== QA-MODELS: ${passed}/${results.length} | console: ${errs.length} | net: ${net.length} =====`);
  for (const e of errs) console.log("  console: " + e);
  for (const n of net) console.log("  " + n);
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
