// EVIDENCE capture for the WRITE 95+ loop — no regex "proof". Traces the ordered
// tool-execution sequence (to detect a real score→fix→rescore loop = scoring tools
// running >1x), polls the pill header live mid-stream, and captures the FULL final
// output (article + score block). Prints raw evidence for a human to read.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-blog-trace.js
const { chromium } = require("playwright");
const fs = require("node:fs");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 600000);
const OUT = process.env.QA_OUT || "/tmp/blog-trace.txt";
const PROMPT = process.env.QA_PROMPT ||
  "Write a high-quality, well-researched blog post about the benefits of server-side rendering for SEO. Research it first, score it, and improve it until it is excellent.";

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 20 });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 950 } })
  ).newPage();
  const errs = [];
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);

  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
  await page.locator("#chat-composer").fill(PROMPT);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });

  // Live poll: record the pill header (aggregate) + row snapshot over time.
  const timeline = [];
  const stop = page.getByRole("button", { name: "Stop generating" });
  const t0 = Date.now();
  await stop.waitFor({ timeout: 40000 }).catch(() => {});
  let last = "";
  while (Date.now() - t0 < WAIT_MS) {
    const running = (await stop.count()) > 0;
    const snap = await page.evaluate(() => {
      const pill = document.querySelector("[data-agent-activity]");
      if (!pill) return { header: "", rows: [] };
      const header = (pill.querySelector("summary")?.innerText || "").replace(/\s+/g, " ").trim();
      const rows = [...pill.querySelectorAll("details div.my-5, [data-agent-activity] .my-5")];
      return { header, rows: rows.length };
    });
    const line = `${Math.round((Date.now() - t0) / 1000)}s | header="${snap.header}"`;
    if (line !== last) {
      timeline.push(line);
      last = line;
    }
    if (!running) break;
    await page.waitForTimeout(3000);
  }

  // Expand the pill and read the FULL ordered tool trace (label + status).
  await page.locator("[data-agent-activity] summary").first().click().catch(() => {});
  await page.waitForTimeout(800);
  const trace = await page.evaluate(() => {
    const pill = document.querySelector("[data-agent-activity]");
    if (!pill) return [];
    // each ToolRun row: the first line of its innerText is the label; icons carry state.
    const rows = [...pill.querySelectorAll(":scope details > div > div.text-xs, :scope details div.text-xs")];
    return rows.map((r) => (r.innerText || "").split("\n")[0].replace(/\s+/g, " ").trim()).filter(Boolean);
  });

  // Full final message (whole article + score block), not sliced.
  const full = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    return rows[rows.length - 1]?.innerText || "";
  });

  await b.close();

  // Count how many times a SCORING tool ran — >1 for a metric ⇒ a real rescore.
  const low = trace.join("\n").toLowerCase();
  const count = (re) => (low.match(re) || []).length;
  const readability = count(/readab/g);
  const keywords = count(/keyword/g);
  const heading = count(/heading/g);
  const schema = count(/schema/g);
  const originality = count(/originality|similarit/g);
  const rescored = Math.max(readability, keywords, heading, schema, originality) >= 2;

  const report = [
    "===== LIVE PILL HEADER TIMELINE (mid-stream) =====",
    ...timeline,
    "",
    "===== ORDERED TOOL TRACE (expanded pill) =====",
    ...trace.map((t, i) => `${i + 1}. ${t}`),
    "",
    "===== SCORING-TOOL RUN COUNTS =====",
    `readability=${readability} keywords=${keywords} heading=${heading} schema=${schema} originality=${originality}`,
    `RESCORE DETECTED (a scoring tool ran >=2x): ${rescored}`,
    "",
    "===== FULL FINAL OUTPUT =====",
    full,
    "",
    `console errors: ${errs.length}`,
  ].join("\n");
  fs.writeFileSync(OUT, report);
  console.log(report);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
