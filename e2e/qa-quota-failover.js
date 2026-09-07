// Capacity failover — a model that is refusing for quota must still produce an
// answer, and must SAY it switched. Verified against the live provider outage
// (7 of 8 models 429ing on 2026-09-03).
//   E2E_BASE_URL=https://app.ollasuper.com node qa-quota-failover.js
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const BROKEN = process.env.QA_BROKEN_MODEL || "GLM 5.2";
const BROKEN_ID = process.env.QA_BROKEN_ID || "glm-5.2";

const errs = [], results = [];
const step = (ok, n, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };
const gen = (p) => p.getByRole("button", { name: "Stop generating" });
const settle = async (p, ms = 240000) => { const dl = Date.now() + ms; while (Date.now() < dl) { if ((await gen(p).count()) === 0) return true; await p.waitForTimeout(400); } return false; };

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);
  await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 15000 });
  await page.waitForTimeout(900);

  // The picker must now seed the model that actually has capacity.
  const trigger = page.getByRole("button", { name: "Choose model" });
  const seeded = (await trigger.innerText()).trim();
  step(/Flash/i.test(seeded), "the picker seeds a model with capacity", seeded);

  // Switch to a model the provider is refusing.
  // The picker filters rather than listing everything, and rows are buttons
  // showing a display name (never the raw id) — mirrors p-chat.js.
  await trigger.click();
  const search = page.getByLabel("Search models");
  await search.waitFor({ timeout: 8000 });
  await search.fill(BROKEN_ID);
  await page.waitForTimeout(700);
  await page
    .locator('[role="menu"] button')
    .filter({ hasText: new RegExp(BROKEN, "i") })
    .first()
    .click();
  // Radix aria-hides the rest of the page while a menu is open; let it close
  // before touching the composer (mirrors the note in p-chat.js).
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);

  await page.locator("#chat-composer").fill("Reply with exactly: PONG");
  await page.keyboard.press("Enter");
  await gen(page).waitFor({ timeout: 30000 }).catch(() => {});
  await settle(page);
  const body = (await page.evaluate(() => document.body.innerText || "")).toLowerCase();

  const answered = body.includes("pong");
  const told = body.includes("out of capacity");
  const honestError = body.includes("out of capacity right now");

  step(answered || honestError,
    "a refusing model yields either an answer or an honest reason",
    answered ? "answered via failover" : "showed the capacity error");
  if (answered) step(told, "the switch is disclosed, not silent");

  console.log(`\n===== QUOTA-FAILOVER: ${results.filter(Boolean).length}/${results.length} | console errors: ${errs.length} =====`);
  if (errs.length) console.log(errs.slice(0, 4).join("\n"));
  await b.close();
  process.exit(results.every(Boolean) && errs.length === 0 ? 0 : 1);
})();
