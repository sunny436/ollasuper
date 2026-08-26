// Phase-13 delegation probe — a single natural, multi-specialist task; capture the
// live agent-activity tool labels to see whether the orchestrated runtime delegated
// to a specialist sub-agent (delegate_to_agent) on prod. No agent is named to it.
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";

const gen = (page) => page.getByRole("button", { name: "Stop generating" });
const settle = async (page, ms = 240000) => { const dl = Date.now() + ms; while (Date.now() < dl) { if ((await gen(page).count()) === 0) return true; await page.waitForTimeout(300); } return false; };

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 10 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = []; page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]'); await page.waitForTimeout(3500);
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 15000 });

  await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
  await page.waitForTimeout(900);
  await page.locator("#chat-composer").fill(
    "This needs a few different kinds of expertise: first have someone research the current " +
    "adoption of WebAssembly on the server side, then have someone analyze the main performance " +
    "trade-offs, and finally have someone write it up as a concise recommendation. Coordinate it.");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 }).catch(() => {});
  const url = page.url();
  await gen(page).waitFor({ timeout: 25000 }).catch(() => {});
  await settle(page);

  // Read the rendered tool-activity labels.
  const runs = await page.evaluate(() => {
    const el = document.querySelector("[data-agent-activity]");
    if (!el) return [];
    return Array.from(el.querySelectorAll("*")).map((n) => n.textContent || "")
      .filter((t) => t && t.length < 60);
  });
  const activityText = runs.join(" | ").toLowerCase();
  const delegated = /delegat|agent/.test(activityText);
  const body = (await page.evaluate(() => document.body.innerText || "")).toLowerCase();
  console.log("URL " + url);
  console.log("DELEGATED " + delegated);
  console.log("ANSWER_SUBSTANTIVE " + (body.length > 500 && /webassembly|wasm|server|performance/.test(body)));
  console.log("CONSOLE_ERRORS " + errs.length);
  console.log("ACTIVITY " + JSON.stringify([...new Set(runs.map((r) => r.trim()).filter(Boolean))].slice(0, 12)));
  await b.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
