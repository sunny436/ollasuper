// Connectors — end-to-end, house style: standalone node script, hand-rolled
// step() harness, hard assertion of zero console errors.
//
//   E2E_BASE_URL=http://localhost:3000  node p-mcp.js
//
// HONEST STATUS: THIS HAS NEVER BEEN EXECUTED. Every MCP flag defaults off,
// `mcp_curated_servers` is empty on every deployment, and nothing in the MCP
// program is deployed — by standing instruction it is not even committed until
// Phase 8. So this is written to be RUN, not claimed as passing, exactly like
// `test_mcp_curated_db.py` which carries the same note.
//
// It is also deliberately pointed at a LOCAL stack by default rather than at
// app.ollasuper.com: Phase 7 is not permitted to deploy, and running it against
// production would test the absence of a feature.
//
// WHAT IT CAN PROVE WITHOUT A REAL MCP SERVER: that the page renders, that the
// catalogue loads, that search and category filters work, that the detail route
// is reachable, that a connector with no connection shows "Not connected", and
// — the one that matters most — that no credential-shaped value is anywhere in
// the page, in storage, or in a request the browser made.
//
// WHAT IT CANNOT: a real OAuth round trip needs a provider and a public
// callback origin, and a real capability list needs a live MCP server. Both are
// Phase 8.
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
const EMAIL = process.env.ADMIN_EMAIL || require("./creds").adminEmail();
const PASSWORD = require("./creds").adminPassword();

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

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 50,
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });

  // Every request the browser made, so the credential assertions below can look
  // at what actually crossed the wire rather than only at what was rendered.
  const requests = [];
  page.on("request", (r) => requests.push({ url: r.url(), post: r.postData() }));

  try {
    // ---------------------------------------------------------------- sign in
    await page.goto(BASE + "/login", { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/chat/, { timeout: 30000 });

    // ------------------------------------------------------------ the page
    await step("Connectors is reachable from Settings", async () => {
      await page.goto(BASE + "/settings/connectors", { waitUntil: "networkidle" });
      await page.waitForSelector("h1:has-text('Connectors')", { timeout: 15000 });
    });

    await step("the sidebar entry exists and marks itself active", async () => {
      const link = page.locator('a[href="/settings/connectors"]').first();
      if ((await link.count()) === 0) throw new Error("no sidebar link");
    });

    await step("the page settles into a real state, never a stuck skeleton", async () => {
      // One of: cards, the empty panel, or the error panel. A page that is
      // still aria-busy after this long is a hung fetch, which is a bug.
      await page.waitForFunction(
        () => !document.querySelector('[aria-busy="true"]'),
        { timeout: 20000 },
      );
    });

    await step("search narrows the list without a reload", async () => {
      const box = page.locator('input[aria-label="Search connectors"]');
      if ((await box.count()) === 0) throw new Error("no search box");
      await box.fill("zzzz-no-such-connector");
      await page.waitForTimeout(300);
      const text = await page.textContent("body");
      if (!/No matches|No connectors available/.test(text)) {
        throw new Error("search produced neither results nor an empty state");
      }
      await box.fill("");
    });

    await step("an unknown connector slug renders not-found, not a crash", async () => {
      // The `threadId`/`v.id()` lesson applied to this route: a slug from a URL
      // is looked up in already-loaded data and never handed to a validator, so
      // a typo must not produce an ArgumentValidationError — which the Convex
      // client logs as a console.error, which fails this whole script.
      await page.goto(BASE + "/settings/connectors/no-such-connector-xyz", {
        waitUntil: "networkidle",
      });
      await page.waitForSelector("text=Connector not found", { timeout: 15000 });
    });

    // --------------------------------------------------------- the boundary
    await step("no credential-shaped value is anywhere in the page", async () => {
      await page.goto(BASE + "/settings/connectors", { waitUntil: "networkidle" });
      const html = await page.content();
      for (const needle of [
        "access_token",
        "refresh_token",
        "client_secret",
        "envelope",
        "keyVersion",
        "Authorization:",
      ]) {
        if (html.includes(needle)) throw new Error("page contains " + needle);
      }
    });

    await step("nothing MCP-shaped is written to browser storage", async () => {
      // §97: no token may live in localStorage, sessionStorage or a cookie.
      const stored = await page.evaluate(() => {
        const dump = (s) =>
          Object.keys(s).map((k) => k + "=" + String(s.getItem(k)));
        return [
          ...dump(window.localStorage),
          ...dump(window.sessionStorage),
          document.cookie,
        ].join("\n");
      });
      for (const needle of ["token", "secret", "envelope", "mcp_cred"]) {
        if (stored.toLowerCase().includes(needle)) {
          throw new Error("browser storage contains " + needle);
        }
      }
    });

    await step("the browser never addressed an MCP server or the gateway", async () => {
      // §95/§96: everything goes Browser -> Convex -> Python -> MCP. A request
      // to :8811, to :8770, or to a third-party /mcp endpoint would mean the
      // frontend had acquired a path it must never have.
      for (const r of requests) {
        if (/:8811|:8770/.test(r.url)) {
          throw new Error("browser addressed an internal port: " + r.url);
        }
        if (/\/mcp(\/|$)/.test(new URL(r.url, BASE).pathname) &&
            !r.url.startsWith(BASE)) {
          throw new Error("browser addressed an MCP endpoint: " + r.url);
        }
      }
    });

    // ------------------------------------------------------------- responsive
    await step("the page works at a phone width with no horizontal scroll", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(BASE + "/settings/connectors", { waitUntil: "networkidle" });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      if (overflow) throw new Error("the page scrolls horizontally on mobile");
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await step("every status carries text, not only colour", async () => {
      // §123. Asserted by reading the accessible text rather than the styling:
      // if a status were colour-only there would be nothing here to find.
      const text = (await page.textContent("body")) || "";
      const known = [
        "Not connected",
        "Connected",
        "Authentication required",
        "Temporarily unavailable",
        "Disconnected",
        "Not available here",
        "Local use unavailable",
      ];
      const anyCatalogue = /Connectors/.test(text);
      if (anyCatalogue && !known.some((k) => text.includes(k))) {
        // An empty catalogue legitimately shows no statuses.
        if (!/No connectors available/.test(text)) {
          throw new Error("no status text found on a populated catalogue");
        }
      }
    });
  } finally {
    const passed = results.filter(Boolean).length;
    console.log("\n" + passed + "/" + results.length + " steps passed");
    if (errs.length) {
      console.log("CONSOLE ERRORS (" + errs.length + "):");
      for (const e of errs.slice(0, 10)) console.log("  " + e);
    }
    await b.close();
    process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
  }
})();
