// Ad-hoc prod check: does the login page's "Sign in with Google" button start the
// OAuth flow cleanly with the LOGIN redirect_uri (not a mismatch/invalid_client)?
// Google's consent itself can't be scripted, so this verifies everything up to it.
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EXPECT_REDIRECT = "https://app.ollasuper.com/__cvx-site/api/auth/callback/google";

(async () => {
  const b = await chromium.launch({ headless: !!process.env.HEADLESS });
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  let ok = false;
  try {
    await page.goto(BASE + "/en/login", { waitUntil: "domcontentloaded", timeout: 30000 });
    // The Google button renders a <span>Google</span> (oauth-row.tsx).
    const btn = page.getByRole("button", { name: "Google" });
    await btn.waitFor({ state: "visible", timeout: 15000 });
    console.log("login page loaded, Google button visible");
    await Promise.all([
      page.waitForURL(/accounts\.google\.com/, { timeout: 25000 }),
      btn.click(),
    ]);
    const url = new URL(page.url());
    const redirect = url.searchParams.get("redirect_uri") || "";
    const clientId = url.searchParams.get("client_id") || "";
    const errParam = url.searchParams.get("error") || "";
    const title = await page.title().catch(() => "");
    console.log("landed on:", url.host + url.pathname);
    console.log("client_id:", clientId.slice(0, 32) + "…");
    console.log("redirect_uri:", redirect);
    console.log("page title:", title);
    console.log("error param:", errParam || "(none)");
    const mismatch = /error|redirect_uri_mismatch|invalid_client/i.test(
      redirect + " " + errParam + " " + title,
    );
    ok =
      url.host === "accounts.google.com" &&
      redirect === EXPECT_REDIRECT &&
      !errParam &&
      !mismatch;
  } catch (e) {
    console.log("FAILED:", String(e).split("\n")[0]);
  } finally {
    console.log("console errors on login page:", errors.length);
    await b.close();
  }
  console.log(ok ? "RESULT: PASS — Google OAuth starts with the correct login redirect_uri" : "RESULT: FAIL");
  process.exit(ok ? 0 : 1);
})();
