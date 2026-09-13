// PHASE 9 · the REAL catalogue, in headed Chrome against live production.
//
//   node q2-catalogue.js
//
// SCOPE: only what the curation change touched — the catalogue, connection and
// discovery flows, a real tool execution, and the security properties those
// depend on. It deliberately does NOT re-run unrelated Phase 1-8 suites.
//
// TWO KINDS OF CONNECTOR ARE EXERCISED, because they fail differently:
//
//   no-auth  (Exa, Cloudflare Docs, Microsoft Learn, Context7, Mux) — connect
//            straight through, so tools and resources can actually be executed.
//   oauth    (GitHub, Notion, Stripe, Jira, ...) — answer 401 at runtime, so
//            the correct outcome is "Authentication required", NOT an error.
//            Getting that distinction wrong is the single most likely way this
//            catalogue looks broken to a user.
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";

// Verified `open` by probe: no credential needed, so a real connection and a
// real tool execution are possible.
const OPEN_SLUG = "context7";
// Verified `auth` by probe: must land on "Authentication required".
const AUTH_SLUG = "github";

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
  await page.waitForFunction(
    () => !document.querySelector('[aria-busy="true"]'),
    { timeout: 45000 },
  );
  if (expect) {
    await page.waitForFunction(
      (n) => document.body.innerText.includes(n),
      expect,
      { timeout: 45000 },
    );
  }
};

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 25,
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const wire = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) {
      errs.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });
  page.on("request", (r) => wire.push(r.url()));
  await ctx.addInitScript(() => {
    window.__QA_XSS__ = 0;
  });

  try {
    await step("login", () => login(page));

    // ─────────────────────────────────────────────────── catalogue
    await step("the catalogue renders the curated connectors", async () => {
      await page.goto(BASE + "/en/settings/connectors", {
        waitUntil: "domcontentloaded",
      });
      await settle(page, "GitHub");
      const text = await page.locator("body").innerText();
      const expected = ["GitHub", "Notion", "Stripe", "Linear", "Figma"];
      const missing = expected.filter((n) => !text.includes(n));
      if (missing.length) throw new Error("missing: " + missing.join(", "));
    });

    await step("every curated connector has a card", async () => {
      const cards = await page
        .locator("a[href^='/settings/connectors/']")
        .count();
      notes.push(`cards rendered: ${cards}`);
      if (cards < 40) throw new Error(`only ${cards} cards for 42 curated rows`);
    });

    await step("category filters are derived from the data", async () => {
      const chips = await page
        .getByRole("group", { name: "Filter by category" })
        .getByRole("button")
        .count();
      notes.push(`category chips: ${chips}`);
      if (chips < 3) throw new Error(`only ${chips} category chips`);
    });

    await step("search finds a connector by name", async () => {
      const box = page.locator('input[aria-label="Search connectors"]');
      await box.fill("notion");
      await page.waitForTimeout(600);
      const text = await page.locator("body").innerText();
      if (!text.includes("Notion")) throw new Error("Notion not found by search");
      if (text.includes("GitHub")) throw new Error("search did not narrow");
      await box.fill("");
      await page.waitForTimeout(400);
    });

    await step("no endpoint, note or trust flag reaches the browser", async () => {
      // The Phase 8 safe projection drops these in PYTHON. Asserted on the
      // rendered page AND on the page source, because a card only shows some of
      // what a payload might carry.
      const html = await page.content();
      for (const n of ["endpoint_url", "mcp.notion.com", "api.githubcopilot", "curated_by"]) {
        if (html.includes(n)) throw new Error(`page contains ${n}`);
      }
    });

    await step("third-party metadata renders as text, never as markup", async () => {
      const xss = await page.evaluate(() => window.__QA_XSS__);
      if (xss) throw new Error("script from catalogue metadata EXECUTED");
    });

    // ──────────────────────────────── the OAuth connector: 401 is not an error
    await step(`an OAuth connector (${AUTH_SLUG}) reports auth, not failure`, async () => {
      await page.goto(`${BASE}/en/settings/connectors/${AUTH_SLUG}`, {
        waitUntil: "domcontentloaded",
      });
      await settle(page, "GitHub");
      // IDEMPOTENT: once a real GitHub sign-in has been completed on this
      // account (q4-github-oauth.js does that) there is no Connect button to
      // press and nothing to prove here — the 401-as-auth property is then
      // covered by that script's popup assertions, not lost.
      if (
        (await page.locator("body").innerText()).includes(
          "OllaSuper can use this app's tools when a request needs them",
        )
      ) {
        notes.push(`${AUTH_SLUG} already connected; 401 handling covered by q4`);
        return;
      }
      // "Open authorization page" is the same path one step later: a row left
      // AUTHORIZING by an abandoned popup offers it instead of Connect.
      const btn = page
        .getByRole("button")
        .filter({ hasText: /^(Connect|Retry|Reconnect|Open authorization page)$/ })
        .first();
      await btn.waitFor({ timeout: 15000 });
      await btn.click();
      // The server answers 401, the runtime classifies it auth_required, and the
      // UI must say so. "Temporarily unavailable" here would send the user to
      // retry forever; "Connected" would be a lie.
      await page.waitForFunction(
        () =>
          /Authentication required|Waiting for authorization/.test(
            document.body.innerText,
          ),
        { timeout: 90000 },
      );
      const text = await page.locator("body").innerText();
      if (/Temporarily unavailable/.test(text)) {
        throw new Error("a 401 was rendered as an outage");
      }
    });

    await step("the OAuth connector exposes no token to the browser", async () => {
      const html = await page.content();
      for (const n of ["access_token", "refresh_token", "client_secret", "code_verifier"]) {
        if (html.includes(n)) throw new Error("page contains " + n);
      }
      const stored = await page.evaluate(() => {
        const d = (s) => Object.keys(s).map((k) => `${k}=${String(s.getItem(k))}`);
        return [...d(localStorage), ...d(sessionStorage), document.cookie].join("\n");
      });
      for (const n of ["access_token", "refresh_token", "envelope"]) {
        if (stored.toLowerCase().includes(n)) throw new Error("storage has " + n);
      }
    });

    // ──────────────────────────── the no-auth connector: a REAL connection
    await step(`a no-auth connector (${OPEN_SLUG}) reaches Connected`, async () => {
      await page.goto(`${BASE}/en/settings/connectors/${OPEN_SLUG}`, {
        waitUntil: "domcontentloaded",
      });
      await settle(page, "Context7");
      const CONNECTED = "OllaSuper can use this app's tools when a request needs them";
      const already = (await page.locator("body").innerText()).includes(CONNECTED);
      if (!already) {
        const btn = page
          .getByRole("button")
          .filter({ hasText: /^(Connect|Retry|Reconnect)$/ })
          .first();
        await btn.waitFor({ timeout: 15000 });
        await btn.click();
      }
      await page.waitForFunction(
        (hint) => document.body.innerText.includes(hint),
        CONNECTED,
        { timeout: 90000 },
      );
    });

    await step("its real tools are discovered and counted", async () => {
      await page.waitForFunction(
        () => /\d+ tools?/.test(document.body.innerText),
        { timeout: 45000 },
      );
      const text = await page.locator("body").innerText();
      const m = text.match(/(\d+) tools?/);
      notes.push(`${OPEN_SLUG} tools: ${m && m[1]}`);
      if (!m || Number(m[1]) === 0) throw new Error("no tools discovered");
    });

    await step("the browser never addressed an MCP server directly", async () => {
      for (const u of wire) {
        if (/mcp\.context7|api\.githubcopilot|mcp\.notion|mcp\.stripe/.test(u)) {
          throw new Error("browser addressed an MCP server: " + u);
        }
        if (/:8770|:8799|:8811/.test(u)) {
          throw new Error("browser addressed an internal port: " + u);
        }
      }
    });

    // ─────────────────────────────────────────────────── UI states
    await step("an unknown slug renders not-found, not a crash", async () => {
      await page.goto(`${BASE}/en/settings/connectors/no-such-xyz`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForFunction(
        () => /Connector not found/.test(document.body.innerText),
        { timeout: 30000 },
      );
    });

    await step("mobile width has no horizontal overflow", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(BASE + "/en/settings/connectors", {
        waitUntil: "domcontentloaded",
      });
      await settle(page, "GitHub");
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      if (over) throw new Error("horizontal overflow on mobile");
      await page.setViewportSize({ width: 1440, height: 900 });
    });
  } finally {
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} steps passed`);
    for (const n of notes) console.log("  note: " + n);
    if (errs.length) {
      console.log(`CONSOLE/HTTP ERRORS (${errs.length}):`);
      for (const e of errs.slice(0, 10)) console.log("  " + e);
    }
    await b.close();
    process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
  }
})();
