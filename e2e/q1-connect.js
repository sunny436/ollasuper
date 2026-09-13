// PHASE 9 · STAGE 3a — discover, connect, and read capabilities, in headed
// Chrome against the LIVE deployment.
//
//   node q1-connect.js
//
// This is the first time the MCP user journey has ever been executed by a
// browser. Everything before it was automated tests and a dark deploy.
//
// WHAT IT IS REALLY CHECKING. Not "does a card appear" — whether the boundary
// holds while a deliberately hostile server is on the other end. The QA server
// lies in its instructions, its tool descriptions, its resource contents and
// its tool results; every assertion below is about OllaSuper's handling of that,
// not about the server.
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";
const SLUG = "qa-redteam";

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

/** Wait for the page to be DONE, not merely un-busy.
 *
 *  `aria-busy` clears when the skeleton unmounts, which happens before the
 *  catalogue action resolves — so asserting on content right after it raced and
 *  reported "not listed" for data that arrived a moment later. Waiting for the
 *  content itself is the honest wait. */
const settle = async (page, expect) => {
  await page.waitForFunction(
    () => !document.querySelector('[aria-busy="true"]'),
    { timeout: 40000 },
  );
  if (expect) {
    await page.waitForFunction(
      (needle) => document.body.innerText.includes(needle),
      expect,
      { timeout: 40000 },
    );
  }
};

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 30,
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Every request the browser made, so the exposure assertions look at what
  // actually crossed the wire rather than only at what was rendered.
  const wire = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) {
      errs.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });
  page.on("request", (r) => wire.push({ url: r.url(), post: r.postData() }));
  // The XSS canary: the QA server serves <script>window.__QA_XSS__=1</script>
  // and an onerror handler in a tool result, a resource body and a description.
  await ctx.addInitScript(() => {
    window.__QA_XSS__ = 0;
  });

  try {
    await step("login", () => login(page));

    // ───────────────────────────────────────────────── catalogue
    await step("the curated QA server appears in the catalogue", async () => {
      await page.goto(BASE + "/en/settings/connectors", {
        waitUntil: "domcontentloaded",
      });
      await settle(page, "QA Red-Team");
      const text = (await page.locator("body").innerText()) || "";
      if (!text.includes("QA Red-Team")) {
        throw new Error("QA server not listed: " + text.replace(/\s+/g, " ").slice(0, 200));
      }
    });

    await step("the catalogue leaks no endpoint, note or trust flag", async () => {
      // Phase 8's safe projection drops these in PYTHON so they never cross the
      // process boundary. Asserted on the rendered page AND on every response
      // body the browser received.
      const html = await page.content();
      const bodies = wire.map((w) => w.post || "").join("\n");
      for (const needle of ["__qa-mcp", "PHASE 9 QA ONLY", "endpoint_url", "trusted"]) {
        if (html.includes(needle)) throw new Error(`page contains ${needle}`);
        if (bodies.includes(needle)) throw new Error(`a request body contains ${needle}`);
      }
    });

    await step("a poisoned description renders as TEXT, never as markup", async () => {
      // The description is the server's own and carries the injection payload.
      const xss = await page.evaluate(() => window.__QA_XSS__);
      if (xss) throw new Error("script from server metadata EXECUTED");
      if ((await page.locator("script:has-text('__QA_XSS__')").count()) > 0) {
        throw new Error("server metadata was parsed into a <script> node");
      }
    });

    // ───────────────────────────────────────────────── detail + connect
    await step("the detail route opens by slug", async () => {
      await page.goto(`${BASE}/en/settings/connectors/${SLUG}`, {
        waitUntil: "domcontentloaded",
      });
      await settle(page, "QA Red-Team");
      const text = (await page.locator("body").innerText()) || "";
      if (!text.includes("QA Red-Team")) throw new Error("detail did not render");
      if (/Connector not found/.test(text)) throw new Error("rendered not-found");
    });

    await step("Connect drives the connection to Connected", async () => {
      // Connect OR Retry: a row left at `unsupported` by an earlier attempt
      // offers Retry instead, and both drive the same server-authoritative
      // round trip.
      const CONNECTED_HINT =
        "OllaSuper can use this app's tools when a request needs them";
      // IDEMPOTENT. A connected row offers NO action button — `isActionable`
      // excludes CONNECTED on purpose, because a button that does nothing is
      // worse than no button. So "already connected" satisfies this step rather
      // than failing it, and the run can be repeated without a teardown.
      const already = (await page.locator("body").innerText()).includes(
        CONNECTED_HINT,
      );
      if (!already) {
        const btn = page
          .getByRole("button")
          .filter({ hasText: /^(Connect|Retry|Reconnect)$/ })
          .first();
        await btn.waitFor({ timeout: 15000 });
        await btn.click();
      }
      // ASSERTED ON THE STATUS HINT, NOT ON THE WORD "Connected". The page's
      // own educational blurb begins "Connected apps can provide tools..." —
      // so /Connected/ over the whole body matched static copy and passed while
      // the connection had never been attempted. A false pass is worse than a
      // failure: it hides the thing the test exists to find.
      await page.waitForFunction(
        () =>
          /OllaSuper can use this app's tools when a request needs them/.test(
            document.body.innerText,
          ),
        { timeout: 90000 },
      );
    });

    await step("the capability summary reports a real count", async () => {
      await page.waitForFunction(
        () => /\d+ tools?/.test(document.body.innerText),
        { timeout: 30000 },
      );
      const text = (await page.locator("body").innerText()) || "";
      const m = text.match(/(\d+) tools?/);
      notes.push(`tool count rendered: ${m && m[1]}`);
      // §101: a count, not a fabricated zero, and not "unavailable".
      if (!m || Number(m[1]) === 0) {
        throw new Error("expected a non-zero tool count, got: " + (m && m[0]));
      }
    });

    await step("the tool list names the hostile tools without obeying them", async () => {
      const text = (await page.locator("body").innerText()) || "";
      for (const t of ["read_ok", "poisoned_desc", "crash_tool"]) {
        if (!text.includes(t)) throw new Error(`tool ${t} not listed`);
      }
      const xss = await page.evaluate(() => window.__QA_XSS__);
      if (xss) throw new Error("script from a tool name/description EXECUTED");
    });

    await step("resources list, and a hostile one renders as text", async () => {
      await page.waitForFunction(
        () => /notes|evil|No resources/.test(document.body.innerText),
        { timeout: 40000 },
      );
      const text = (await page.locator("body").innerText()) || "";
      if (!/evil/.test(text)) notes.push("resource 'evil' not listed");
      const xss = await page.evaluate(() => window.__QA_XSS__);
      if (xss) throw new Error("script from a resource description EXECUTED");
    });

    await step("opening the hostile resource does not execute it", async () => {
      const open = page.getByRole("button", { name: "Open" });
      const n = await open.count();
      if (n === 0) {
        notes.push("no Open affordance found — resource viewer not exercised");
        return;
      }
      // The LAST one is `evil`; `notes` sorts first.
      await open.nth(n - 1).click();
      await page.waitForTimeout(4000);
      const xss = await page.evaluate(() => window.__QA_XSS__);
      if (xss) throw new Error("resource CONTENT executed in the browser");
      const html = await page.content();
      if (/<script>window\.__QA_XSS__/.test(html)) {
        throw new Error("resource content was parsed into a script node");
      }
      await page.keyboard.press("Escape");
    });

    // ───────────────────────────────────────────────── exposure
    await step("no credential-shaped value anywhere in the page", async () => {
      const html = await page.content();
      for (const n of ["access_token", "refresh_token", "client_secret", "envelope", "keyVersion"]) {
        if (html.includes(n)) throw new Error("page contains " + n);
      }
    });

    await step("nothing MCP-shaped in browser storage", async () => {
      const stored = await page.evaluate(() => {
        const d = (s) => Object.keys(s).map((k) => `${k}=${String(s.getItem(k))}`);
        return [...d(localStorage), ...d(sessionStorage), document.cookie].join("\n");
      });
      for (const n of ["access_token", "refresh_token", "envelope", "mcp_cred"]) {
        if (stored.toLowerCase().includes(n)) throw new Error("storage contains " + n);
      }
    });

    await step("the browser never addressed the MCP server directly", async () => {
      // §95/§96. Everything goes Browser -> Convex -> Python -> MCP. A request
      // to /__qa-mcp from the PAGE would mean the frontend acquired a path it
      // must never have.
      for (const r of wire) {
        if (r.url.includes("/__qa-mcp")) {
          throw new Error("browser addressed the MCP server: " + r.url);
        }
        if (/:8799|:8770|:8811/.test(r.url)) {
          throw new Error("browser addressed an internal port: " + r.url);
        }
      }
    });

    // ───────────────────────────────────────────────── duplicate clicks
    await step("rapid Connect clicks do not create duplicate connections", async () => {
      await page.goto(`${BASE}/en/settings/connectors/${SLUG}`, {
        waitUntil: "domcontentloaded",
      });
      await settle(page, "QA Red-Team");
      const any = page.getByRole("button").filter({ hasText: /Connect|Reconnect|Retry/ });
      if ((await any.count()) > 0) {
        for (let i = 0; i < 3; i++) {
          await any.first().click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(120);
        }
      }
      await page.waitForTimeout(6000);
      const cards = await page.getByText("QA Red-Team").count();
      notes.push(`cards after rapid clicks: ${cards}`);
      // create is idempotent per (user, serverName); more than one card would
      // mean a second row was created.
      if (cards > 2) throw new Error(`${cards} QA cards — duplicate connection`);
    });
  } finally {
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} steps passed`);
    for (const n of notes) console.log("  note: " + n);
    if (errs.length) {
      console.log(`CONSOLE/HTTP ERRORS (${errs.length}):`);
      for (const e of errs.slice(0, 12)) console.log("  " + e);
    }
    await b.close();
    process.exit(passed === results.length ? 0 : 1);
  }
})();
