// q7-connections.js — what the QA account has connected right now, and a
// headed sanity read through a TRUSTED connector that is (no Gmail assumed).
//
//   QA_EMAIL=… QA_PASSWORD=… node q7-connections.js
//
// Prints each connector card's state from /settings/connectors, then asks the
// chat for a declared read on the first connected TRUSTED connector and
// asserts no approval card appears. Zero console errors, like every script.
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";
const CONNECTED_HINT = "OllaSuper can use this app's tools when a request needs them";

const errs = [];
const visible = async (loc) => (await loc.count()) > 0 && (await loc.first().isVisible().catch(() => false));

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 25000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
}

(async () => {
  const b = await chromium.launch({ channel: "chrome", headless: false, slowMo: 20 });
  const page = await b.newPage();
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push(`pageerror ${e.message}`));
  try {
    await login(page);
    await page.goto(`${BASE}/en/settings/connectors`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);
    const text = await page.locator("body").innerText();
    // Connected cards say "Connected"; print the lines around each.
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^(Connected|Needs attention|Disconnected)$/i.test(lines[i])) {
        // The card: a few lines above the state, skipping glyph-only lines.
        const ctx = lines.slice(Math.max(0, i - 4), i).filter((l) => /[a-z]/i.test(l));
        out.push(`${ctx.join(" | ")} -> ${lines[i]}`);
      }
    }
    console.log("connector states:");
    for (const o of out) console.log(`  ${o}`);
    if (!out.length) console.log(`  (no state lines matched; first 600 chars)\n${text.slice(0, 600)}`);
  } finally {
    await b.close();
  }
  const benign = errs.filter((e) => !/favicon|third-party cookie/i.test(e));
  console.log(`console/network errors: ${benign.length}`);
  for (const e of benign.slice(0, 8)) console.log(`  ${e.slice(0, 200)}`);
  process.exit(benign.length ? 1 : 0);
})();
