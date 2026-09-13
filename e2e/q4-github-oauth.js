// GitHub MCP connector — OAuth in headed Chrome against the LIVE deployment.
//
//   node q4-github-oauth.js                    # automated: up to GitHub's sign-in
//   GH_INTERACTIVE=1 node q4-github-oauth.js   # a human signs in to GitHub in the
//                                              # popup; then Connected + tools
//
// GitHub has no dynamic client registration, so this exercises the
// pre-registered client seeded into the vault. The automated run stops at
// GitHub's sign-in page because finishing needs a real GitHub account; it never
// claims Connected on its own.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";
const INTERACTIVE = !!process.env.GH_INTERACTIVE;
const CALLBACK = `${BASE}/__cvx-site/mcp/oauth/callback`;
// A public identifier — it is in every authorization URL. NOT the secret.
const CLIENT_ID = "Ov23likTBXUR9Ivr5tiT";
const ALLOWED = new Set([
  "repo", "read:org", "read:user", "user:email", "notifications", "gist", "read:project",
]);
const CONNECTED_HINT = "OllaSuper can use this app's tools when a request needs them";

// The secret is read only to prove it never reaches the browser. Never printed.
let SECRET = null;
try {
  const raw = fs.readFileSync(path.join(__dirname, "..", "mcp_servers_creds.txt"), "utf8");
  SECRET = (raw.match(/client sec\S*\s+(\S+)/i) || [])[1] || null;
} catch {}

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
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), {
    timeout: 40000,
  });
  if (expect) {
    await page.waitForFunction((n) => document.body.innerText.includes(n), expect, {
      timeout: 40000,
    });
  }
};

/** GitHub bounces an anonymous browser to /login?return_to=<authorize URL>. */
function authorizeUrlOf(popupUrl) {
  const u = new URL(popupUrl);
  if (u.pathname === "/login" && u.searchParams.get("return_to")) {
    return new URL("https://github.com" + u.searchParams.get("return_to"));
  }
  return u;
}

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: process.env.CI ? 0 : 30 });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const wire = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) errs.push(`HTTP ${r.status()} ${r.url()}`);
  });
  page.on("request", (r) => wire.push(r.url() + "\n" + (r.postData() || "")));
  page.on("websocket", (ws) => {
    ws.on("framesent", (f) => wire.push(String(f.payload)));
    ws.on("framereceived", (f) => wire.push(String(f.payload)));
  });

  let popup = null;
  try {
    await step("login", () => login(page));

    await step("GitHub is in the connector catalogue", async () => {
      await page.goto(BASE + "/en/settings/connectors", { waitUntil: "domcontentloaded" });
      await settle(page, "GitHub");
    });

    await step("the GitHub detail page opens", async () => {
      await page.goto(BASE + "/en/settings/connectors/github", { waitUntil: "domcontentloaded" });
      await settle(page, "GitHub");
      const text = await page.locator("body").innerText();
      if (/Connector not found/.test(text)) throw new Error("rendered not-found");
    });

    const already = (await page.locator("body").innerText()).includes(CONNECTED_HINT);
    if (already) notes.push("GitHub was already Connected for this account");

    if (!already) {
      await step("Connect opens GitHub's authorization in a popup", async () => {
        const btn = page
          .getByRole("button")
          .filter({ hasText: /^(Connect|Retry|Reconnect|Open authorization page)$/ })
          .first();
        await btn.waitFor({ timeout: 20000 });
        const opened = ctx.waitForEvent("page", { timeout: 90000 });
        await btn.click();
        popup = await opened;
        await popup.waitForLoadState("domcontentloaded");
        if (new URL(popup.url()).host !== "github.com") {
          throw new Error("popup is not github.com: " + new URL(popup.url()).host);
        }
      });

      await step("the authorization request is exactly the registered one", async () => {
        const a = authorizeUrlOf(popup.url());
        const q = a.searchParams;
        if (a.pathname !== "/login/oauth/authorize") throw new Error("path " + a.pathname);
        if (q.get("client_id") !== CLIENT_ID) throw new Error("client_id " + q.get("client_id"));
        if (q.get("redirect_uri") !== CALLBACK) throw new Error("redirect_uri " + q.get("redirect_uri"));
        if (q.get("response_type") !== "code") throw new Error("response_type");
        if (q.get("code_challenge_method") !== "S256") throw new Error("PKCE is not S256");
        if ((q.get("code_challenge") || "").length < 43) throw new Error("no PKCE challenge");
        if ((q.get("state") || "").length < 32) throw new Error("state too short");
        const scopes = (q.get("scope") || "").split(" ").filter(Boolean);
        const extra = scopes.filter((s) => !ALLOWED.has(s));
        if (!scopes.length || extra.length) throw new Error("scope not narrowed: " + extra.join(","));
        notes.push("requested scope: " + scopes.join(" "));
      });

      await step("GitHub accepts the client (sign-in page, no OAuth error)", async () => {
        await popup.waitForLoadState("load");
        const text = await popup.locator("body").innerText();
        if (/not associated with this application|application suspended|404/i.test(text)) {
          throw new Error("GitHub error page: " + text.replace(/\s+/g, " ").slice(0, 160));
        }
        const m = text.match(/to continue to\s+([^\n]+)/i);
        notes.push("GitHub page: " + (m ? "continue to " + m[1].trim() : text.split("\n")[0]));
      });

      await step("OllaSuper shows the waiting-for-authorization state", async () => {
        await page.waitForFunction(
          () => /Waiting for authorization|Finish signing in/.test(document.body.innerText),
          { timeout: 20000 },
        );
      });
    }

    if (INTERACTIVE && !already) {
      console.log("\n>>> Sign in to GitHub in the popup and click Authorize (10 min) <<<\n");
      await step("after GitHub consent the connector reaches Connected", async () => {
        await page.waitForFunction((h) => document.body.innerText.includes(h), CONNECTED_HINT, {
          timeout: 600000,
        });
      });
    }

    if (INTERACTIVE || already) {
      await step("GitHub's real tools are listed", async () => {
        await page.waitForFunction(() => /\d+ tools?/.test(document.body.innerText), {
          timeout: 60000,
        });
        const m = (await page.locator("body").innerText()).match(/(\d+) tools?/);
        notes.push("tool count: " + (m && m[1]));
        if (!m || Number(m[1]) === 0) throw new Error("no tools");
      });
    } else if (popup) {
      await step("closing the popup leaves a retryable state, not a false Connected", async () => {
        await popup.close();
        await page.waitForTimeout(6000);
        const text = await page.locator("body").innerText();
        if (text.includes(CONNECTED_HINT)) throw new Error("claims Connected without consent");
        const btn = page
          .getByRole("button")
          .filter({ hasText: /^(Connect|Retry|Reconnect|Open authorization page)$/ });
        if ((await btn.count()) === 0) throw new Error("no way to try again");
      });
    }

    await step("the client secret never reaches the browser", async () => {
      if (!SECRET) throw new Error("creds file unreadable, cannot run this check");
      const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
      const cookies = JSON.stringify(await ctx.cookies());
      const where = [
        ["page", await page.content()],
        ["network + websocket", wire.join("\n")],
        ["storage", storage],
        ["cookies", cookies],
        ["popup url", popup ? popup.url() : ""],
      ].filter(([, v]) => v.includes(SECRET) || v.includes("client_secret"));
      if (where.length) throw new Error("secret material found in: " + where.map(([k]) => k).join(", "));
    });

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
