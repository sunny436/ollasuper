// Fan-out benchmark (prod, headed-capable). Asks for N INDEPENDENT lookups in one
// message and reports what the system actually did: wall-clock, the tool-run count
// the execution pill reports, and (server-side) typed events vs ingress round-trips.
//
// The model chooses the real fan-out, so this measures the SYSTEM under a wide
// batch — not a promise that N tool calls are emitted. Read it alongside the
// `generation_finished` log line for the same thread.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-fanout-bench.js
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const SIZES = (process.env.QA_SIZES || "20,50,200").split(",").map(Number);
const errs = [];

const gen = (page) => page.getByRole("button", { name: "Stop generating" });
const settle = async (page, ms) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if ((await gen(page).count()) === 0) return true; await page.waitForTimeout(400); }
  return false;
};
const tid = (page) => { const m = page.url().match(/\/chat\/([a-z0-9]+)/i); return m ? m[1] : null; };

// Distinct, independent, cheap targets — no dependency between them, so a correct
// agent batches them rather than serializing.
const TARGETS = (n) => Array.from({ length: n }, (_, i) => `https://example.com/?probe=${i + 1}`);

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 0 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]'); await page.waitForTimeout(3500);
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 15000 });
  console.log("BENCH_START " + new Date().toISOString());

  for (const n of SIZES) {
    await settle(page, 240000);
    await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
    await page.waitForTimeout(1200);
    const prompt =
      `Fetch each of these ${n} urls and give me a one-line note per url. ` +
      `They are completely independent of each other, so fetch them ALL IN PARALLEL in as few steps as possible. ` +
      `Do not skip any. Urls:\n` + TARGETS(n).join("\n");
    await page.locator("#chat-composer").fill(prompt);
    const t0 = Date.now();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 20000 }).catch(() => {});
    const id = tid(page);
    await gen(page).waitFor({ timeout: 40000 }).catch(() => {});
    const done = await settle(page, 900000);
    const ms = Date.now() - t0;
    // The execution pill's settled/total counter is the real tool-run count.
    let runs = "n/a";
    try {
      const pill = await page.locator("[data-agent-activity] .tabular-nums").first().innerText({ timeout: 4000 });
      runs = pill.trim();
    } catch { /* a turn with <=1 run renders no counter */ }
    console.log(`BENCH n=${n} settled=${done} wall_ms=${ms} pill_runs=${runs} thread=${id}`);
  }

  console.log("BENCH_END " + new Date().toISOString());
  console.log(`console errors: ${errs.length}`);
  if (errs.length) console.log(errs.slice(0, 5).join("\n"));
  await b.close();
  process.exit(errs.length ? 1 : 0);
})();
