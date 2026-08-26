// QA — File Generation System (prod, headed Chrome, real user, NATURAL prompts).
// For each format: ask naturally → the assistant generates the file → a download card
// appears → click Download → capture + SAVE the real bytes. A separate Python step
// (validate_downloads.py) then OPENS each file and asserts its structure — a passed
// HTTP request alone is NOT a pass. Zero console-error + network-4xx/5xx gates throughout.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const OUT = process.env.FILEGEN_OUT || path.join(__dirname, "filegen-downloads");
const errs = [], net = [], results = [], manifest = [];

// [tag, extension, natural prompt] — covers the required matrix incl. embedded charts,
// large multi-page/multi-row/multi-slide, and images.
const CASES = [
  ["pdf", "pdf", "Write a short PDF report titled 'Renewable Energy' with a one-paragraph intro, a section with 3 bullet points, and a small 2-column table of two sources."],
  ["docx", "docx", "Create a Word document (DOCX) with a title 'Remote Work' and two sections, each a short paragraph."],
  ["xlsx", "xlsx", "Make an Excel spreadsheet (XLSX) with a sheet of 5 rows, columns Month and Revenue (Jan..May with numbers), and add a line chart of it."],
  ["pptx", "pptx", "Create a PowerPoint (PPTX) with a title slide and three content slides about the inner planets, each with two bullet points."],
  ["csv", "csv", "Export a CSV with three fruits and their colors (columns Fruit, Color)."],
  ["json", "json", "Give me a JSON file listing three programming languages, each with its name and creator."],
  ["md", "md", "Create a Markdown document titled 'Water Cycle' with two sections."],
  ["html", "html", "Generate an HTML page summarizing three rules of chess in a short list."],
  ["png", "png", "Draw a bar chart as a PNG image of monthly rainfall for Jan, Feb, Mar with values 10, 20, 15 mm."],
  ["jpeg", "jpg", "Make a JPEG image of a pie chart of a budget split: Rent 50, Food 30, Savings 20."],
  ["svg", "svg", "Create an SVG line chart of the values 3, 5, 4, 8 over four weeks."],
  ["chartdoc", "pdf", "Write a PDF that includes a bar chart of quarterly revenue (Q1..Q4 = 10,14,9,16) and a paragraph explaining the trend."],
  ["largepdf", "pdf", "Write a detailed multi-section PDF report on the history of computing with at least 6 sections, each a couple of paragraphs."],
  ["largexlsx", "xlsx", "Make an XLSX spreadsheet with a sheet of 40 rows: column N from 1 to 40 and column N_squared with each value squared."],
  ["multislide", "pptx", "Create a PowerPoint with 6 slides, one per day of a 6-day trip itinerary, each with two bullet points."],
  ["yaml", "yaml", "Export a YAML file describing three books with title and author."],
];

const gen = (page) => page.getByRole("button", { name: "Stop generating" });
const settle = async (page, ms = 220000) => { const dl = Date.now() + ms; while (Date.now() < dl) { if ((await gen(page).count()) === 0) return true; await page.waitForTimeout(300); } return false; };
const step = async (n, f) => { try { await f(); results.push(true); console.log("PASS  " + n); } catch (e) { results.push(false); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); } };

async function run(page, tag, ext, prompt) {
  await settle(page);
  await page.getByRole("button", { name: "New chat" }).click().catch(() => {});
  await page.waitForTimeout(900);
  await page.locator("#chat-composer").fill(prompt);
  const t0 = Date.now();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 }).catch(() => {});
  await gen(page).waitFor({ timeout: 25000 }).catch(() => {});
  if (!(await settle(page))) throw new Error("never settled");
  // The ARTIFACT download card specifically (not a code-block download button).
  const btn = page.locator("[data-artifact-download]").last();
  await btn.waitFor({ timeout: 15000 });
  const dlPromise = page.waitForEvent("download", { timeout: 40000 });
  await btn.click();
  const download = await dlPromise;
  const dest = path.join(OUT, `${tag}.${ext}`);
  await download.saveAs(dest);
  const size = fs.statSync(dest).size;
  if (size <= 0) throw new Error("downloaded file is empty");
  manifest.push({ tag, ext, format: tag, path: dest, size });
  console.log(`      ↳ [${tag}] ${Date.now() - t0}ms saved ${size}B → ${path.basename(dest)}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
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
  console.log("QA_FILEGEN_START " + new Date().toISOString());

  for (const [tag, ext, prompt] of CASES) {
    await step(`${tag} (${ext})`, () => run(page, tag, ext, prompt));
  }

  console.log("QA_FILEGEN_END " + new Date().toISOString());
  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== QA-FILEGEN: ${passed}/${results.length} | console: ${errs.length} | net: ${net.length} =====`);
  for (const e of errs) console.log("  console: " + e);
  for (const n of net) console.log("  " + n);
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("MANIFEST " + path.join(OUT, "manifest.json") + ` (${manifest.length} files)`);
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
