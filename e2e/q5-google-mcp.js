// Google MCP connectors — real Google sign-in in headed Chrome, LIVE production.
//
//   node q5-google-mcp.js            # all six Google apps
//   GOOGLE_SLUGS=gmail node q5-google-mcp.js
//
// OllaSuper login: QA_EMAIL / QA_PASSWORD (env). Google login: read at runtime
// from the gitignored ../mcp_servers_creds.txt ("google auth details for
// testing" section). Neither is ever printed.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";
const CONNECTED_HINT = "OllaSuper can use this app's tools when a request needs them";

const APPS = [
  { slug: "gmail", name: "Gmail", ask: "Look at my Gmail and tell me the names of my Gmail labels." },
  { slug: "google-calendar", name: "Google Calendar", ask: "Check my Google Calendar and list which calendars I have." },
  { slug: "google-drive", name: "Google Drive", ask: "Look in my Google Drive and list my most recent files." },
  { slug: "google-docs", name: "Google Docs", ask: null },
  { slug: "google-sheets", name: "Google Sheets", ask: null },
  { slug: "google-maps", name: "Google Maps", ask: "Use Google Maps to find three coffee shops near Connaught Place, New Delhi." },
].filter((a) => !process.env.GOOGLE_SLUGS || process.env.GOOGLE_SLUGS.split(",").includes(a.slug));

function googleAccount() {
  const lines = fs
    .readFileSync(path.join(__dirname, "..", "mcp_servers_creds.txt"), "utf8")
    .split(/\r?\n/);
  const at = lines.findIndex((l) => /google auth details for testing/i.test(l));
  const rest = lines.slice(at + 1).map((l) => l.trim()).filter(Boolean);
  return { email: rest[0], password: rest[1] };
}
const GOOGLE = googleAccount();

const errs = [];
const results = [];
const notes = [];
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

async function login(page) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 25000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
}

const settle = async (page, expect) => {
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout: 40000 });
  if (expect) {
    await page.waitForFunction((n) => document.body.innerText.includes(n), expect, { timeout: 40000 });
  }
};

const visible = async (loc) => (await loc.count()) > 0 && (await loc.first().isVisible().catch(() => false));

/** Drive Google's sign-in + consent inside the popup until it lands on our callback. */
async function googleConsent(popup) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (popup.isClosed()) return "popup closed";
    const url = popup.url();
    if (url.includes("/__cvx-site/mcp/oauth/callback")) {
      await popup.waitForLoadState("domcontentloaded").catch(() => {});
      await popup.waitForTimeout(1500);
      return (await popup.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    }
    const text = (await popup.locator("body").innerText().catch(() => "")) || "";
    if (/browser or app may not be secure|Couldn.t sign you in/i.test(text)) {
      throw new Error("Google refused the automated browser: " + text.replace(/\s+/g, " ").slice(0, 160));
    }
    if (/2-Step Verification|Verify it.s you|confirm it.s you|Check your phone/i.test(text)) {
      throw new Error("Google asked for extra verification: " + text.replace(/\s+/g, " ").slice(0, 160));
    }
    if (/Access blocked|Error 400|Error 403|redirect_uri_mismatch|invalid_request|org_internal/i.test(text)) {
      throw new Error("Google error page: " + text.replace(/\s+/g, " ").slice(0, 220));
    }

    const chooser = popup.locator(`[data-identifier="${GOOGLE.email}"]`);
    const email = popup.locator('input[type="email"]');
    const password = popup.locator('input[type="password"]');
    if (await visible(chooser)) {
      await chooser.first().click();
    } else if (await visible(email)) {
      await email.first().fill(GOOGLE.email);
      await popup.locator("#identifierNext, button:has-text('Next')").first().click();
    } else if (await visible(password)) {
      await password.first().fill(GOOGLE.password);
      await popup.locator("#passwordNext, button:has-text('Next')").first().click();
    } else {
      // Unverified-app interstitial, granular consent ("Select all"), then Continue/Allow.
      const selectAll = popup.getByRole("checkbox", { name: /Select all/i });
      if (await visible(selectAll)) {
        if (!(await selectAll.first().isChecked().catch(() => true))) await selectAll.first().check().catch(() => {});
      }
      const advanced = popup.getByRole("link", { name: /^Advanced$/i });
      const unsafe = popup.getByRole("link", { name: /Go to .*\(unsafe\)/i });
      const go = popup.getByRole("button", { name: /^(Continue|Allow)$/i });
      if (await visible(unsafe)) await unsafe.first().click();
      else if (await visible(go)) await go.first().click();
      else if (await visible(advanced)) await advanced.first().click();
    }
    await popup.waitForTimeout(2500);
  }
  throw new Error("Google consent did not finish in 3 minutes at " + new URL(popup.url()).host + new URL(popup.url()).pathname);
}

async function ask(page, text, waitMs = 150000) {
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea, [contenteditable='true']", { timeout: 20000 });
  const box = page.locator("textarea, [contenteditable='true']").first();
  await box.click();
  await box.fill(text);
  await page.keyboard.press("Enter");
  const started = Date.now();
  let last = "";
  let stable = 0;
  while (Date.now() - started < waitMs) {
    await page.waitForTimeout(3000);
    // An approval gate for an untrusted server's tool: approve it, as a user would.
    const approve = page.getByRole("button", { name: /^(Approve|Allow|Run|Allow once)$/i });
    if (await visible(approve)) {
      await approve.first().click();
      notes.push("approved a tool call for: " + text.slice(0, 40));
      stable = 0;
      continue;
    }
    const body = await page.locator("body").innerText();
    stable = body === last ? stable + 1 : 0;
    last = body;
    if (stable >= 3 && body.length > text.length + 150) break;
  }
  return last;
}

(async () => {
  if (!GOOGLE.email || !GOOGLE.password) throw new Error("google account section not found in creds file");
  const b = await chromium.launch({
    channel: "chrome",
    headless: false,
    slowMo: 20,
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) errs.push(`HTTP ${r.status()} ${r.url()}`);
  });

  try {
    await step("login to OllaSuper", () => login(page));

    for (const app of APPS) {
      await step(`${app.name}: connect with a real Google sign-in`, async () => {
        await page.goto(`${BASE}/en/settings/connectors/${app.slug}`, { waitUntil: "domcontentloaded" });
        await settle(page, app.name);
        if (
          process.env.GOOGLE_RECONNECT &&
          (await page.locator("body").innerText()).includes(CONNECTED_HINT)
        ) {
          // Start from disconnected so the real popup sign-in runs again.
          await page.getByRole("button", { name: /^Disconnect$/ }).first().click();
          await page.waitForTimeout(800);
          await page.getByRole("button", { name: /^Disconnect$/ }).last().click();
          await page.waitForFunction((h) => !document.body.innerText.includes(h), CONNECTED_HINT, {
            timeout: 30000,
          });
          notes.push(`${app.name}: disconnected first`);
        }
        if ((await page.locator("body").innerText()).includes(CONNECTED_HINT)) {
          notes.push(`${app.name}: already connected`);
          return;
        }
        const btn = page.getByRole("button").filter({ hasText: /^(Connect|Retry|Reconnect|Open authorization page)$/ }).first();
        await btn.waitFor({ timeout: 20000 });
        const opened = ctx.waitForEvent("page", { timeout: 90000 });
        await btn.click();
        const popup = await opened;
        const landed = await googleConsent(popup);
        notes.push(`${app.name} callback page: ${landed.slice(0, 120)}`);
        // A user closes the "You can close this window" page. Left open, the app
        // reuses this named window for the next connector and no new popup opens.
        if (!popup.isClosed()) await popup.close();
        if (/failed|could not/i.test(landed)) throw new Error("callback says: " + landed.slice(0, 160));
        await page.waitForFunction((h) => document.body.innerText.includes(h), CONNECTED_HINT, { timeout: 90000 });
      });

      await step(`${app.name}: real tools are listed`, async () => {
        await page.goto(`${BASE}/en/settings/connectors/${app.slug}`, { waitUntil: "domcontentloaded" });
        await settle(page, app.name);
        await page.waitForFunction(() => /\d+ tools?/.test(document.body.innerText), { timeout: 60000 });
        const m = (await page.locator("body").innerText()).match(/(\d+) tools?/);
        notes.push(`${app.name} tools: ${m && m[1]}`);
        if (!m || Number(m[1]) === 0) throw new Error("no tools");
      });
    }

    for (const app of APPS.filter((a) => a.ask)) {
      await step(`${app.name}: a chat turn uses it`, async () => {
        const out = await ask(page, app.ask);
        const tail = out.slice(-700).replace(/\s+/g, " ");
        notes.push(`${app.name} reply tail: ${tail.slice(-300)}`);
        if (/not connected|needs to be authorized|could not be reached|don.t have access|unable to|not enabled|Developer Preview|permission|isn.t available|failed/i.test(tail)) {
          throw new Error("reply reports a connector failure: " + tail.slice(-200));
        }
      });
    }

    await step("zero console errors on OllaSuper", async () => {
      if (errs.length) throw new Error(errs.slice(0, 3).join(" | "));
    });
  } finally {
    await b.close();
  }
  for (const n of notes) console.log("NOTE  " + n);
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
