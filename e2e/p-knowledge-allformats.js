// All-format cross-chat knowledge recall.
//
// For every file type: attach in one chat (paperclip -> Option-B knowledge
// upload -> ingest), wait until it is Ready in the Files dropdown, then open a
// BRAND-NEW chat and ask a natural-language question whose answer only exists
// inside that file. Passing proves parse -> chunk -> embed -> cross-chat
// retrieval works for that format.
//
//   KDIR=<dir with the generated files>  node p-knowledge-allformats.js
const path = require("path");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const KDIR = process.env.KDIR;
if (!KDIR) throw new Error("set KDIR to the generated-files directory");

const CASES = [
  { file: "zephyr.txt",      q: "When is the Zephyr rocket launch scheduled? Answer from my files.", token: "march 14" },
  { file: "falcon.md",       q: "What budget did the board approve for the Falcon initiative?",       token: "88 lakh" },
  { file: "widgets.csv",     q: "What is the price of the QuantumWidget in my data?",                  token: "4242" },
  { file: "nimbus.json",     q: "In the JSON config file I uploaded, what exact value is in the 'owner' field? Answer only from my file.", token: "priya sharma" },
  { file: "sundarbans.html", q: "How many tigers remain according to the Sundarbans page I saved?",    token: "96" },
  { file: "report.pdf",      q: "What is the secret passphrase in the report I uploaded?",             token: "crimson-elephant-77" },
  { file: "findings.docx",   q: "What did revenue grow to in Q3 per my findings document?",            token: "512 crore" },
  { file: "sales.xlsx",      q: "What were the sales for Kerala in my spreadsheet?",                   token: "9931" },
  { file: "roadmap.pptx",    q: "By when should we ship the Orion release per my roadmap deck?",       token: "december 2026" },
  { file: "badge.png",       q: "What is the access code shown in the image I uploaded?",              token: "5150" },
];

const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const RUN = ONLY ? CASES.filter((c) => ONLY.includes(c.file)) : CASES;

const results = [];
const consoleErrors = [];

const settle = async (page, ms = 90000) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await stop.count()) === 0) return true;
    await page.waitForTimeout(300);
  }
  return false;
};

async function ensureFilesOpen(page) {
  if ((await page.locator("div.max-h-64").count()) === 0) {
    await page.getByRole("button", { name: /Files/ }).first().click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function waitReady(page, fileName) {
  const row = page.locator("div.group").filter({ hasText: fileName }).first();
  const deadline = Date.now() + 150000; // OCR/scan paths can be slow
  while (Date.now() < deadline) {
    await ensureFilesOpen(page);
    const txt = (await row.innerText().catch(() => "")) || "";
    if (/Ready/i.test(txt)) return "ready";
    if (/Failed/i.test(txt)) return "FAILED (" + txt.replace(/\s+/g, " ").slice(0, 60) + ")";
    await page.waitForTimeout(1500);
  }
  return "timeout-not-ready";
}

async function freshChat(page) {
  // Full reload -> brand-new React tree: composer is clean, so an unsent
  // attachment from the previous step cannot leak into this send.
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 15000 });
}

async function sendMsg(page, text) {
  await page.locator("#chat-composer").fill(text);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Enter");
    const started = await page
      .getByRole("button", { name: "Stop generating" })
      .waitFor({ timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (started) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 40,
  });
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  // login
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 15000 });
  await ensureFilesOpen(page);

  for (const c of RUN) {
    const label = c.file;
    try {
      // 1) fresh chat, attach -> Option-B knowledge upload + ingest. waitReady
      //    only returns once ingestion finished, so the later reload is safe.
      await freshChat(page);
      await page.locator('input[type="file"]').first().setInputFiles(path.join(KDIR, c.file));
      const ready = await waitReady(page, c.file);
      if (ready !== "ready") throw new Error("ingest " + ready);

      // 2) BRAND-NEW chat (full reload = clean composer, no leaked attachment),
      //    ask a question answerable ONLY from the file.
      await freshChat(page);
      const sent = await sendMsg(page, c.q);
      if (!sent) throw new Error("send did not start");
      await settle(page, 90000);

      // 3) assert the distinctive answer token is present (case-insensitive).
      //    The tokens (4242, crimson-elephant-77, 512 crore, ...) never appear
      //    in filenames/sizes, so body text is safe.
      const ok = await page.waitForFunction((tok) => {
        // strip commas so "9,931" matches token "9931" (number formatting)
        const t = (document.body.innerText || "").toLowerCase().replace(/,/g, "");
        return t.includes(tok);
      }, c.token, { timeout: 10000 }).then(() => true).catch(() => false);

      if (!ok) {
        const got = await page.evaluate(() => (document.body.innerText || "").slice(-400));
        throw new Error(`recall missing "${c.token}" — tail: ${got.replace(/\s+/g, " ").slice(-160)}`);
      }
      results.push([label, true, ""]);
      console.log("PASS  " + label + "  (recalled '" + c.token + "')");
    } catch (e) {
      results.push([label, false, e.message.split("\n")[0]]);
      console.log("FAIL  " + label + " — " + e.message.split("\n")[0]);
    }
  }

  const passed = results.filter((r) => r[1]).length;
  console.log("\n==== all-format cross-chat recall ====");
  for (const [n, ok, msg] of results) console.log((ok ? "  ok  " : "  XX  ") + n + (msg ? "  — " + msg : ""));
  console.log(`\n${passed}/${results.length} formats recalled across chats`);
  console.log("console errors: " + consoleErrors.length);
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 8).map((e) => "   ! " + e).join("\n"));

  await browser.close();
  process.exit(passed === results.length && consoleErrors.length === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
