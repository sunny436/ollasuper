// Slack MCP connector — OAuth in headed Chrome against the LIVE deployment.
//
//   node q6-slack-oauth.js                       # automated: up to Slack's sign-in page
//   SLACK_INTERACTIVE=1 node q6-slack-oauth.js   # a human signs in to Slack in the popup;
//                                                # then Connected, the tool list, a chat turn
//
// Slack's MCP server has no dynamic client registration, so this exercises the
// operator's Slack app seeded into the vault. Slack's own rule: only Marketplace
// or INTERNAL apps may use MCP — so the account signing in must belong to the
// workspace that owns the app. The automated run stops at Slack's sign-in page
// and never claims Connected on its own.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";
const INTERACTIVE = !!process.env.SLACK_INTERACTIVE;
const CALLBACK = `${BASE}/__cvx-site/mcp/oauth/callback`;
const CONNECTED_HINT = "OllaSuper can use this app's tools when a request needs them";
const ALLOWED = new Set([
  "channels:read", "channels:history", "groups:read", "groups:history", "im:read", "im:history",
  "mpim:read", "mpim:history", "chat:write", "users:read", "search:read.public",
  "search:read.private", "search:read.im", "search:read.mpim", "files:read", "reactions:read",
]);

// Read only to prove neither ever reaches the browser. Never printed.
let CLIENT_ID = null;
let SECRET = null;
try {
  const raw = fs.readFileSync(path.join(__dirname, "..", "mcp_servers_creds.txt"), "utf8");
  const slack = raw.slice(raw.search(/^Slack/m));
  CLIENT_ID = (slack.match(/Client ID\s+(\S+)/) || [])[1] || null;
  SECRET = (slack.match(/Client Secret\s+(\S+)/) || [])[1] || null;
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
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout: 40000 });
  if (expect) {
    await page.waitForFunction((n) => document.body.innerText.includes(n), expect, { timeout: 40000 });
  }
};
const visible = async (loc) => (await loc.count()) > 0 && (await loc.first().isVisible().catch(() => false));

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
  const replyOf = (body) => body.slice(body.lastIndexOf("Assistant"));
  while (Date.now() - started < waitMs) {
    await page.waitForTimeout(3000);
    const approve = page.getByRole("button", { name: /^(Approve|Allow|Run|Allow once)$/i });
    if (await visible(approve)) {
      await approve.first().click();
      notes.push("approved a tool call");
      stable = 0;
      continue;
    }
    const body = await page.locator("body").innerText();
    stable = body === last ? stable + 1 : 0;
    last = body;
    if (stable >= 3 && replyOf(body).length > 160) break;
  }
  if (replyOf(last).length <= 160) throw new Error("no assistant reply within " + waitMs / 1000 + "s");
  return replyOf(last);
}

(async () => {
  const b = await chromium.launch({ channel: "chrome", headless: false, slowMo: 20 });
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

    await step("Slack is in the connector catalogue", async () => {
      await page.goto(BASE + "/en/settings/connectors", { waitUntil: "domcontentloaded" });
      await settle(page, "Slack");
    });

    await step("the Slack detail page opens", async () => {
      await page.goto(BASE + "/en/settings/connectors/slack", { waitUntil: "domcontentloaded" });
      await settle(page, "Slack");
      if (/Connector not found/.test(await page.locator("body").innerText())) throw new Error("not-found");
    });

    const already = (await page.locator("body").innerText()).includes(CONNECTED_HINT);
    if (already) notes.push("Slack was already Connected for this account");

    if (!already) {
      await step("Connect opens Slack's authorization in a popup", async () => {
        const btn = page
          .getByRole("button")
          .filter({ hasText: /^(Connect|Retry|Reconnect|Open authorization page)$/ })
          .first();
        await btn.waitFor({ timeout: 20000 });
        const opened = ctx.waitForEvent("page", { timeout: 90000 });
        await btn.click();
        popup = await opened;
        await popup.waitForLoadState("domcontentloaded");
        if (!/(^|\.)slack\.com$/.test(new URL(popup.url()).host)) {
          throw new Error("popup is not slack.com: " + new URL(popup.url()).host);
        }
      });

      await step("the authorization request is exactly the registered one", async () => {
        // Slack bounces the popup to its workspace sign-in (/oauth?...) before
        // the page settles, so the popup's URL is no longer the SDK's. The
        // authorization URL crossed the wire in the oauth.start response, and
        // that is what is checked.
        const joined = wire.join("\n").split("\\/").join("/").split("\\u0026").join("&");
        const m = joined.match(/https:\/\/slack\.com\/oauth\/v2_user\/authorize\?[^"\s\\]+/);
        if (!m) throw new Error("no slack authorize URL in the oauth.start response");
        const authorize = new URL(m[0]);
        const q = authorize.searchParams;
        if (authorize.pathname !== "/oauth/v2_user/authorize") throw new Error("path " + authorize.pathname);
        if (q.get("client_id") !== CLIENT_ID) throw new Error("client_id " + q.get("client_id"));
        if (q.get("redirect_uri") !== CALLBACK) throw new Error("redirect_uri " + q.get("redirect_uri"));
        if (q.get("code_challenge_method") !== "S256") throw new Error("PKCE is not S256");
        if ((q.get("state") || "").length < 32) throw new Error("state too short");
        const scopes = (q.get("scope") || "").split(" ").filter(Boolean);
        const extra = scopes.filter((s) => !ALLOWED.has(s));
        if (!scopes.length || extra.length) throw new Error("scope not narrowed: " + extra.join(","));
        notes.push(`requested ${scopes.length} scopes`);
      });

      await step("Slack shows its sign-in, not an OAuth error", async () => {
        await popup.waitForLoadState("load");
        const text = await popup.locator("body").innerText();
        if (/invalid_client_id|bad_redirect_uri|invalid_scope|not allowed|is not permitted/i.test(text)) {
          throw new Error("Slack error page: " + text.replace(/\s+/g, " ").slice(0, 200));
        }
        notes.push("Slack page: " + text.replace(/\s+/g, " ").slice(0, 100));
      });

      await step("OllaSuper shows the waiting-for-authorization state", async () => {
        await page.waitForFunction(
          () => /Waiting for authorization|Finish signing in/.test(document.body.innerText),
          { timeout: 20000 },
        );
      });
    }

    if (INTERACTIVE && !already) {
      console.log("\n>>> Sign in to Slack in the popup and click Allow (10 min) <<<\n");
      await step("after Slack consent the connector reaches Connected", async () => {
        await page.waitForFunction((h) => document.body.innerText.includes(h), CONNECTED_HINT, {
          timeout: 600000,
        });
      });
    }

    if (INTERACTIVE || already) {
      await step("Slack's real tools are listed", async () => {
        await page.goto(BASE + "/en/settings/connectors/slack", { waitUntil: "domcontentloaded" });
        await settle(page, "Slack");
        await page.waitForFunction(() => /\d+ tools?/.test(document.body.innerText), { timeout: 60000 });
        const m = (await page.locator("body").innerText()).match(/(\d+) tools?/);
        notes.push("tool count: " + (m && m[1]));
        if (!m || Number(m[1]) === 0) throw new Error("no tools");
      });

      await step("a chat turn reads real Slack data", async () => {
        const out = await ask(page, "Look at my Slack workspace and list the channels I'm in.");
        const tail = out.replace(/\s+/g, " ");
        notes.push("reply: " + tail.slice(0, 300));
        if (/not connected|needs to be authorized|could not be reached|don.t have access|unable to|not enabled|not allowed|permission|failed|isn.t available/i.test(tail)) {
          throw new Error("reply reports a connector failure: " + tail.slice(0, 200));
        }
      });
    } else if (popup) {
      await step("closing the popup leaves a retryable state, not a false Connected", async () => {
        await popup.close();
        await page.waitForTimeout(6000);
        const text = await page.locator("body").innerText();
        if (text.includes(CONNECTED_HINT)) throw new Error("claims Connected without consent");
      });
    }

    await step("the client secret never reaches the browser", async () => {
      if (!SECRET) throw new Error("creds file unreadable, cannot run this check");
      const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
      const where = [
        ["page", await page.content()],
        ["network + websocket", wire.join("\n")],
        ["storage", storage],
        ["cookies", JSON.stringify(await ctx.cookies())],
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
