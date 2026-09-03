// The reported bug: "Create task" permanently disabled. Drives the exact
// sentence from the report and asserts the button is ENABLED with no manual
// editing, the time is 8 AM (not the 9 AM default), and the name is filled.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-schedule-create.js
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const SENTENCE = process.env.QA_SENTENCE || "create a schedular ai news daily at 8 am";

const errs = [], results = [];
const step = (ok, n, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);

  await page.goto(`${BASE}/en/scheduled`, { waitUntil: "domcontentloaded" });
  const composer = page.getByPlaceholder("Schedule a task");
  await composer.waitFor({ timeout: 15000 });
  await composer.fill(SENTENCE);
  await page.keyboard.press("Enter");

  const create = page.getByRole("button", { name: "Create task" });
  await create.waitFor({ timeout: 60000 });
  await page.waitForTimeout(2500); // let the parse land

  // THE bug: enabled without the user editing anything.
  step(await create.isEnabled(), "Create task is enabled with no manual editing");

  const name = await page.getByLabel("Task name").inputValue().catch(() => "");
  step(name.length > 0 && name !== SENTENCE,
    "the name is a real title, not the raw sentence", JSON.stringify(name));

  const body = await page.evaluate(() => document.body.innerText || "");
  step(/8:00\s*AM/i.test(body), "the time is 8:00 AM, not the 9:00 default",
    (body.match(/\d{1,2}:\d{2}\s*[AP]M/i) || ["none"])[0]);

  console.log(`\n===== SCHEDULE-CREATE: ${results.filter(Boolean).length}/${results.length} | console errors: ${errs.length} =====`);
  if (errs.length) console.log(errs.slice(0, 4).join("\n"));
  await b.close();
  process.exit(results.every(Boolean) && errs.length === 0 ? 0 : 1);
})();
