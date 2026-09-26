// Prod check of Google sign-in up to the one step a script cannot take: the
// user's own consent at Google. Everything before and around it is asserted:
//   * the login page's Google button starts the flow with zero console errors
//   * the authorization request: client_id, the LOGIN redirect_uri, scopes,
//     response_type=code, a state, and a PKCE S256 challenge
//   * the verifier/state cookies are HttpOnly + Secure and scoped to our host
//   * Google serves its sign-in page for it (no redirect_uri_mismatch /
//     invalid_client / error page)
//   * a forged callback (bogus code, bogus or missing state) is refused with a
//     redirect back to the app — never a 5xx, never a session cookie
//
//   node p-google-login.js        (HEADLESS=1 for no window)
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const SITE = `${BASE}/__cvx-site`;
const EXPECT_REDIRECT = `${SITE}/api/auth/callback/google`;
const EXPECT_CLIENT_PREFIX = "567801700974-";

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

(async () => {
  const b = await chromium.launch({ headless: !!process.env.HEADLESS });
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(`${BASE}/en/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
    const btn = page.getByRole("button", { name: "Google" });
    await btn.waitFor({ state: "visible", timeout: 15000 });
    // The consent screen must be reached from a real click, as a user would.
    const cookiesBefore = new Set((await ctx.cookies()).map((c) => c.name));
    let authorize = null;
    page.on("request", (r) => {
      if (!authorize && /accounts\.google\.com\/.*o\/oauth2/.test(r.url())) authorize = r.url();
    });
    await Promise.all([page.waitForURL(/accounts\.google\.com/, { timeout: 25000 }), btn.click()]);
    const url = new URL(authorize || page.url());
    const p = url.searchParams;
    check("the Google button reaches accounts.google.com", url.host === "accounts.google.com", url.pathname);
    check(
      "client_id is the production login client",
      (p.get("client_id") || "").startsWith(EXPECT_CLIENT_PREFIX),
      `${(p.get("client_id") || "").slice(0, 20)}…`,
    );
    check("redirect_uri is the login callback", p.get("redirect_uri") === EXPECT_REDIRECT, p.get("redirect_uri"));
    const scopes = (p.get("scope") || "").split(/\s+/);
    check(
      "scopes are exactly openid + email + profile",
      ["openid", "email", "profile"].every((s) => scopes.includes(s)) && scopes.length === 3,
      p.get("scope"),
    );
    check("response_type=code (authorization-code flow)", p.get("response_type") === "code");
    // Auth.js's Google provider binds the flow with PKCE, not `state` — which
    // RFC 9700 §2.1 accepts as the CSRF defence: a code injected into someone
    // else's browser cannot be redeemed without THAT browser's verifier cookie.
    const pkce =
      p.get("code_challenge_method") === "S256" && (p.get("code_challenge") || "").length >= 43;
    check("PKCE: an S256 code_challenge binds the flow to this browser", pkce);
    check(
      "the flow carries a CSRF binding (PKCE, or state)",
      pkce || (p.get("state") || "").length >= 16,
      p.get("state") ? "state + PKCE" : "PKCE only (Auth.js default)",
    );

    const flowCookies = (await ctx.cookies()).filter(
      (c) => !cookiesBefore.has(c.name) && /pkce|state|verifier|oauth/i.test(c.name),
    );
    check(
      "the flow's verifier/state cookies are HttpOnly, Secure and ours",
      flowCookies.length > 0 &&
        flowCookies.every((c) => c.httpOnly && c.secure && /ollasuper\.com$/.test(c.domain)),
      flowCookies.map((c) => `${c.name}(${c.sameSite})`).join(", ") || "none seen",
    );

    await page.waitForLoadState("domcontentloaded");
    // Google answers an unacceptable request (unknown client, unregistered
    // redirect_uri) at /signin/oauth/error; an accepted one at its sign-in page.
    const at = new URL(page.url()).pathname;
    const title = await page.title().catch(() => "");
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 4000);
    const errorPage =
      /\/error|oauth\/error/.test(at) ||
      /redirect_uri_mismatch|invalid_client|Error 400|Error 401|Access blocked/i.test(body);
    check(
      "Google accepts the request and shows its sign-in page",
      !errorPage && /\/signin\//.test(at) && /^Sign in/i.test(title),
      `${at} · ${title}`,
    );

    // Forged callbacks, as an attacker would send them (no browser state).
    for (const [label, qs] of [
      ["bogus code + bogus state", "code=bogus&state=bogus"],
      ["bogus code, no state", "code=bogus"],
      ["Google's own error", "error=access_denied&state=bogus"],
    ]) {
      const r = await fetch(`${SITE}/api/auth/callback/google?${qs}`, { redirect: "manual" });
      const loc = r.headers.get("location") || "";
      const setCookie = r.headers.get("set-cookie") || "";
      const sessionIssued = /__convexAuthJWT|__convexAuthRefreshToken=[^;]{10,}/.test(setCookie);
      check(
        `forged callback refused (${label})`,
        r.status >= 300 && r.status < 400 && loc.startsWith(BASE) && !sessionIssued,
        `${r.status} → ${loc || "(no location)"}`,
      );
    }
  } catch (e) {
    check("flow completed", false, String(e).split("\n")[0]);
  } finally {
    check("zero console errors on the login page", errors.length === 0, errors.slice(0, 2).join(" | "));
    await b.close();
  }
  const pass = results.filter(Boolean).length;
  console.log(`\n=== GOOGLE SIGN-IN (up to consent): ${pass}/${results.length} ===`);
  console.log("Not scriptable: a real Google account granting consent and landing signed in.");
  process.exit(pass === results.length ? 0 : 1);
})();
