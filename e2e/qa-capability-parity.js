// qa-capability-parity.js — the router chooses the brain; the chosen brain answers.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-capability-parity.js
//   QA_ONLY=easy QA_OUT=out/model-health/quarantine node qa-capability-parity.js
//
// QA_ONLY picks turns (comma list) so other steps — e.g. quarantining a model via
// /v1/models/health — can run between them; QA_OUT names the evidence folder.
//
// Three real turns on production, in an order that matters:
//   1. medium (skill)  — routes to the thread's DEFAULT model. Run first after a
//                        restart so its capacity refusal (if its upstream is
//                        limited) is observed live and the failover rescues it.
//   2. easy            — routes to a different model while the default model may
//                        now be marked exhausted: the P0 scenario. It must still
//                        be answered by the model the router chose.
//   3. complex (tools) — Ollagraph tools / MCP on the deepest tier.
//
// The UI shows no model, so each turn's thread id and UTC window are saved for
// correlation with the server's router.selected / generation_finished logs.
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";
const OUT = path.join(__dirname, process.env.QA_OUT || path.join("out", "capability-parity"));
const ONLY = (process.env.QA_ONLY || "").split(",").filter(Boolean);

const TURNS = [
  {
    // Worded so the tool it needs (readability) is NOT in the initial working set
    // (checked on the live registry): if the routed model fails over, the failover
    // must discover it via find_capabilities and still be able to call it.
    tier: "medium",
    text: "Write a product launch email for our analytics dashboard and objectively score how easy it is to read before sending it back.",
  },
  { tier: "easy", text: "What is a mutex?" },
  {
    // Skill (SEO audit) + Ollagraph tools + an MCP connector (Google Maps) in one
    // request. Which of them the brain actually calls is ITS decision; the logs and
    // Convex events say what ran.
    tier: "complex",
    text: "Audit the on-page SEO of https://example.com (headings, meta tags, broken links), and use Google Maps to find three coffee shops near Koramangala, Bangalore that would compete in local search. Give prioritised fixes with evidence.",
  },
].filter((t) => !ONLY.length || ONLY.includes(t.tier));

const errs = [];
const results = [];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!TURNS.length) throw new Error(`QA_ONLY matched no turn: ${ONLY.join(",")}`);
  const b = await chromium.launch({ channel: "chrome", headless: false, slowMo: 20 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push(`pageerror ${e.message}`));

  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);

    for (const t of TURNS) {
      const started = new Date();
      await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
      await page.locator("#chat-composer").fill(t.text);
      await page.keyboard.press("Enter");
      await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 30000 });
      const stop = page.getByRole("button", { name: "Stop generating" });
      await stop.waitFor({ timeout: 60000 }).catch(() => {});
      const deadline = Date.now() + 290000;
      while (Date.now() < deadline && (await stop.count()) > 0) await page.waitForTimeout(700);
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("div.my-5")];
        return rows[rows.length - 1]?.innerText || "";
      });
      const ended = new Date();
      const thread = page.url().split("/").pop();
      await page.screenshot({ path: path.join(OUT, `${t.tier}.png`), fullPage: false });
      const failed = /had a problem|took too long|could not complete|could not reach/i.test(text);
      const ok = text.length > 120 && !failed;
      const r = {
        ...t,
        ok,
        thread,
        startedUtc: started.toISOString(),
        endedUtc: ended.toISOString(),
        secs: ((ended - started) / 1000).toFixed(1),
        chars: text.length,
        failoverNotice: (text.match(/_?[\w.-]+ is out of capacity — answered with [\w.-]+ instead\._?/) || [null])[0],
        head: text.slice(0, 400),
      };
      results.push(r);
      console.log(`${ok ? "PASS" : "FAIL"}  ${t.tier.padEnd(8)} ${r.secs}s  ${r.chars} chars  thread ${thread}`);
      if (r.failoverNotice) console.log(`      notice: ${r.failoverNotice}`);
      if (!ok) console.log(`      ${text.slice(0, 200).replace(/\s+/g, " ")}`);
    }
  } finally {
    await b.close();
  }
  const benign = errs.filter((e) => !/favicon|third-party cookie/i.test(e));
  fs.writeFileSync(
    path.join(OUT, "browser.json"),
    JSON.stringify({ base: BASE, results, consoleErrors: benign }, null, 2),
  );
  console.log(`\n${results.filter((r) => r.ok).length}/${TURNS.length} answered · console errors: ${benign.length}`);
  for (const e of benign.slice(0, 5)) console.log(`  ${e.slice(0, 160)}`);
  process.exit(results.every((r) => r.ok) && !benign.length ? 0 : 1);
})();
