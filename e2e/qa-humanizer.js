// qa-humanizer.js — the A/B for the internal humanize stage, on production.
//
//   QA_EMAIL=… QA_PASSWORD=… LABEL=off node qa-humanizer.js
//   (flip AI_HUMANIZER_ENABLED on the VM, restart, then LABEL=on again)
//
// Asks for the SAME two pieces each run — one blog post (the Blog Assistant's
// research→write→score loop) and one non-blog content piece (a one-shot writing
// turn, a different surface) — and writes each answer to
// e2e/out/humanizer-<label>-<slug>.md so the deterministic detector can score
// all four texts afterwards. Also captures the execution pill, so "did the
// stage actually run" is answered from the UI as well as from the server log.
//
// Asserts the SILENCE contract on every run: no humanization score, section or
// mention may appear in the answer.
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";
const LABEL = process.env.LABEL || "run";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 600000);
const OUT = path.join(__dirname, "out");

// Chosen from REAL skill discovery (SkillRegistry.discover with prod flags), so
// each piece exercises the content path it claims to. Discovery is wording-
// sensitive: a longer blog brief ("…titled '…'. Around 900 words. Target
// keyword: …") matched NO skill at all, which would have silently A/B-tested the
// shared guidance instead of the Blog skill's stage.
const PROMPTS = [
  {
    slug: "blog", // -> blog-assist
    text:
      "Write a blog post about why incident retrospectives keep producing the " +
      "same action items. Target keyword: incident retrospectives.",
  },
  {
    slug: "email", // -> marketing (+ sales)
    text:
      "Write a product launch email for our new analytics feature. Audience: " +
      "existing customers. About 200 words. Say it cuts report build time from " +
      "45 minutes to 5 minutes.",
  },
];
// With the flag on, one non-deliverable too: the stage must NOT fire on it.
if (process.env.LABEL === "on") {
  PROMPTS.push({ slug: "trivial", text: "What is a mutex?" });
}

const errs = [];
const results = [];
const step = async (n, f) => {
  try {
    await f();
    results.push(true);
    console.log("PASS  " + n);
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + n + " — " + String(e.message).split("\n")[0]);
  }
};

const answer = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    return rows[rows.length - 1]?.innerText || "";
  });
const pillText = (page) =>
  page.evaluate(() => {
    const els = [...document.querySelectorAll("[data-agent-activity]")];
    return els.map((e) => e.innerText).join("\n");
  });

const settle = async (page, ms) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ timeout: 60000 }).catch(() => {});
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && (await stop.count()) > 0)
    await page.waitForTimeout(1000);
  await page.waitForTimeout(1500);
};

async function ask(page, prompt) {
  await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
  await page.locator("#chat-composer").fill(prompt);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 30000 });
}

// The stage is INTERNAL: none of this may reach the reader.
const BANNED = [
  /human[- ]?voice score/i,
  /humaniz(?:ation|er)\s*(?:score|pass|stage|check)/i,
  /humanize_check/i,
  /ai[- ]?writing score/i,
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ channel: "chrome", headless: false, slowMo: 20 });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 950 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon"))
      errs.push(`HTTP ${r.status()} ${r.url()}`);
  });

  try {
    await step("login", async () => {
      await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
      await page.waitForURL(/login/, { timeout: 20000 });
      await page.locator('input[type="email"]').first().fill(EMAIL);
      await page.locator('input[type="password"]').first().fill(PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(4000);
    });

    for (const p of PROMPTS) {
      await step(`${p.slug}: generate (${LABEL})`, async () => {
        await ask(page, p.text);
        await settle(page, WAIT_MS);
        const text = await answer(page);
        const pill = await pillText(page);
        const floor = p.slug === "trivial" ? 40 : 400;
        if (text.length < floor) throw new Error(`answer too short: ${text.length} chars`);
        if (/had a problem|took too long|something went wrong|could not complete/i.test(text))
          throw new Error(`turn failed: ${text.slice(0, 120)}`);
        fs.writeFileSync(path.join(OUT, `humanizer-${LABEL}-${p.slug}.md`), text);
        fs.writeFileSync(path.join(OUT, `humanizer-${LABEL}-${p.slug}.pill.txt`), pill);
        console.log(
          `      ${p.slug}: ${text.length} chars, url ${page.url().split("/").pop()}`,
        );
      });

      await step(`${p.slug}: the stage stays silent`, async () => {
        const text = fs.readFileSync(
          path.join(OUT, `humanizer-${LABEL}-${p.slug}.md`),
          "utf8",
        );
        for (const rx of BANNED) {
          if (rx.test(text)) throw new Error(`answer mentions the stage: ${rx}`);
        }
      });
    }
  } finally {
    await b.close();
  }

  const benign = errs.filter((e) => !/favicon|third-party cookie/i.test(e));
  console.log(`\n${results.filter(Boolean).length}/${results.length} steps passed`);
  console.log(`console/network errors: ${benign.length}`);
  for (const e of benign.slice(0, 8)) console.log("  " + e.slice(0, 200));
  process.exit(results.includes(false) || benign.length ? 1 : 0);
})();
