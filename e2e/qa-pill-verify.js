// Prod acceptance for the unified execution-status pill. Headed Chrome:
//  - tool activity renders as ONE pill (data-agent-activity), not N banners
//  - NO raw endpoint/tool names ("Endpoint", "Find Capabilities") anywhere in it
//  - the pill shows a human-readable aggregate; expand reveals per-run rows
//  - parallel tools appear together; completion → "Done"; final answer renders
//  - zero console errors
//   E2E_BASE_URL=https://app.ollasuper.com node qa-pill-verify.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const TARGET = process.env.QA_TARGET || "https://www.networkershome.com/";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 300000);

const errs = [];
const results = [];
const step = async (n, f) => {
  try {
    await f();
    results.push(true);
    console.log("PASS  " + n);
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + n + " — " + e.message.split("\n")[0]);
  }
};
const need = (c, m) => {
  if (!c) throw new Error(m);
};
const pillText = (page) =>
  page.evaluate(() => {
    const el = document.querySelector("[data-agent-activity]");
    return el ? el.innerText : "";
  });

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 30 });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 950 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon"))
      errs.push("HTTP " + r.status() + " " + r.url());
  });

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
  });

  await step("send an SEO audit (fires many parallel tools)", async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
    await page.locator("#chat-composer").fill(
      `Check the technical SEO of ${TARGET} — robots, redirects, headers, mixed content, SSL.`,
    );
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 20000 });
  });

  await step("ONE pill appears (not per-tool banners)", async () => {
    await page.waitForSelector("[data-agent-activity]", { timeout: 40000 });
    // Exactly one execution pill container per assistant message.
    const count = await page.locator("[data-agent-activity]").count();
    need(count === 1, `${count} activity containers (expected 1)`);
    // The pill is a single top-level <details> (the row "View result" details are
    // nested inside it, so count direct children of the activity container).
    const topDetails = await page.evaluate(() => {
      const el = document.querySelector("[data-agent-activity]");
      return el ? [...el.children].filter((c) => c.tagName === "DETAILS").length : -1;
    });
    need(topDetails === 1, `${topDetails} top-level pills (expected 1)`);
  });

  let midText = "";
  await step("no raw endpoint/tool names in the pill (mid-stream)", async () => {
    midText = await pillText(page);
    console.log("    pill (mid): " + JSON.stringify(midText.replace(/\n/g, " · ").slice(0, 160)));
    const low = midText.toLowerCase();
    need(!low.includes("endpoint"), "raw 'Endpoint' leaked into the pill");
    need(!low.includes("find capabilities"), "'Find Capabilities' not suppressed");
    // shows a human aggregate/verb
    const human = ["working", "checking", "analyzing", "crawling", "searching",
      "auditing", "fetching", "mapping", "reading", "extracting", "validating", "done"];
    need(human.some((h) => low.includes(h)), "no human-readable status in pill: " + midText.slice(0, 80));
  });

  await step("expand the pill → per-run rows with friendly labels", async () => {
    const summary = page.locator("[data-agent-activity] summary").first();
    await summary.click();
    await page.waitForTimeout(600);
    const expanded = await pillText(page);
    const low = expanded.toLowerCase();
    need(!low.includes("endpoint"), "raw 'Endpoint' visible after expand");
    // multiple distinct rows / verbs present (parallel tools shown together)
    need(expanded.length > midText.length || /checking|analyzing|mapping|crawling/.test(low),
      "expanded pill has no detail rows");
  });

  await step("streams to completion → 'Done', final answer renders", async () => {
    const stop = page.getByRole("button", { name: "Stop generating" });
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline && (await stop.count()) > 0)
      await page.waitForTimeout(500);
    const finalPill = (await pillText(page)).toLowerCase();
    need(finalPill.includes("done") || finalPill.includes("step"), "pill did not settle to Done");
    need(!finalPill.includes("endpoint"), "raw 'Endpoint' in settled pill");
    const answer = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("div.my-5")];
      return rows[rows.length - 1]?.innerText || "";
    });
    need(answer.length > 40, "no final answer rendered below the pill");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log("\n===== PILL-VERIFY: " + passed + "/" + results.length +
    " | console errors: " + errs.length + " =====");
  for (const e of [...new Set(errs)].slice(0, 10)) console.log("  ! " + e.slice(0, 160));
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
