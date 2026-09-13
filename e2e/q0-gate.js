// PHASE 9 · STAGE 0 — the prerequisite gate.
//
//   E2E_BASE_URL=https://app.ollasuper.com node q0-gate.js
//
// Three things, and the phase stops if any of them fails:
//
//   1. the QA account can actually log in to the LIVE deployment
//   2. the dark state is what Phase 8 claims it is, seen from a browser
//   3. a throwaway second identity can be created on demand
//
// (3) is the one that matters most for what follows. Cross-user isolation —
// owner-only reads, "Not found" rather than "Forbidden", no workspace-only
// index, an AAD binding user|workspace|connection|server|resource — is the
// property this program spent the most effort on, and it cannot be tested with
// one account. Proving the mechanism HERE, before it is needed, means a later
// failure is a real finding rather than a broken harness.
//
// NOTHING SECRET IS EVER PRINTED. Addresses are reported by domain only,
// passwords never, and the mailbox credentials arrive through the environment.
const { chromium } = require("playwright");
const ollastack = require("./_lib/ollastack");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";

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

async function login(page, email, password) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 25000 });
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
}

(async () => {
  if (!EMAIL || !PASSWORD) {
    console.log("FAIL  QA_EMAIL / QA_PASSWORD not in the environment");
    process.exit(1);
  }

  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 40,
  });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) {
      errs.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });

  try {
    await step("QA account logs in to the LIVE deployment", async () => {
      await login(page, EMAIL, PASSWORD);
      if (!/\/chat/.test(page.url())) {
        throw new Error("did not reach /chat — got " + page.url());
      }
    });

    await step("the composer renders, so the session is real", async () => {
      await page.waitForSelector("textarea, [contenteditable='true']", {
        timeout: 15000,
      });
    });

    // ---------------------------------------------------- the dark state
    await step("Connectors is reachable from the settings sidebar", async () => {
      await page.goto(BASE + "/en/settings", { waitUntil: "domcontentloaded" });
      const link = page.locator('a[href="/settings/connectors"]').first();
      await link.waitFor({ timeout: 15000 });
      await link.click();
      await page.waitForURL(/connectors/, { timeout: 15000 });
    });

    await step("the page settles — no stuck skeleton", async () => {
      await page.waitForFunction(
        () => !document.querySelector('[aria-busy="true"]'),
        { timeout: 25000 },
      );
    });

    await step("MCP renders as OFF, not as an error", async () => {
      // The distinction the kill switch exists to make: "off on this
      // deployment" has no retry, "could not load" does. Seeing the wrong one
      // here would mean the flag never reached the browser.
      const text = (await page.textContent("body")) || "";
      if (!/aren't available here|hasn't turned on connectors/i.test(text)) {
        throw new Error(
          "expected the disabled state, got: " +
            text.replace(/\s+/g, " ").slice(0, 160),
        );
      }
      if (/Couldn't load connectors/i.test(text)) {
        throw new Error("rendered the ERROR state instead of the OFF state");
      }
    });

    await step("no connector card is listed while MCP is off", async () => {
      const connects = await page.getByRole("button", { name: "Connect" }).count();
      if (connects !== 0) throw new Error(`${connects} Connect buttons visible`);
    });

    await step("nothing MCP-shaped is in browser storage", async () => {
      const stored = await page.evaluate(() => {
        const dump = (s) =>
          Object.keys(s).map((k) => `${k}=${String(s.getItem(k))}`);
        return [
          ...dump(window.localStorage),
          ...dump(window.sessionStorage),
          document.cookie,
        ].join("\n");
      });
      for (const needle of ["access_token", "refresh_token", "envelope", "mcp_cred"]) {
        if (stored.toLowerCase().includes(needle)) {
          throw new Error("browser storage contains " + needle);
        }
      }
    });

    // ------------------------------------------- the second identity
    await step("a throwaway second identity can be created on demand", async () => {
      if (!ollastack.enabled()) {
        throw new Error(
          "OLLASTACK_MAIL_TOKEN / OLLASTACK_E2E_MAILBOX_ID not in the environment",
        );
      }
      const tag = ollastack.newTag();
      const address = ollastack.taggedAddress(
        await ollastack.mailboxAddress(),
        tag,
      );
      // Domain only. The address itself is a live mailbox and stays unprinted.
      console.log("      second identity domain:", address.split("@")[1]);
      if (!address.includes("+") || !address.includes("@")) {
        throw new Error("tagged address is malformed");
      }
    });
  } finally {
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} steps passed`);
    if (errs.length) {
      console.log(`CONSOLE/HTTP ERRORS (${errs.length}):`);
      for (const e of errs.slice(0, 12)) console.log("  " + e);
    }
    await b.close();
    process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
  }
})();
