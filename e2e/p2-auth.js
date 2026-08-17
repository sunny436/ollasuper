// Full auth E2E over Cloudflare HTTPS: signup+verify, reset, admin regression, google button.
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
// Verification and reset codes are console.warn'd by the auth providers as a dev
// fallback whenever SMTP is unset (packages/backend/convex/passwordProviders.ts).
// They land in the CONVEX LOG STREAM, not container stdout, so they are read back
// with the Convex CLI rather than by grepping a file.
//
// `convex logs --history N` prints the history and then keeps streaming, so it is
// wrapped in `timeout ... || true`: without that, execSync would block forever,
// and killing it on timeout would throw away the output we came for.
//
// This used to ssh to a hardcoded host and grep /tmp/cvxlogs.txt, which tied the
// suite to one particular dev box. Override E2E_LOG_CMD / CONVEX_DIR to point
// somewhere else.
const CONVEX_DIR = process.env.CONVEX_DIR || "/opt/myos/packages/backend";
const LOG_CMD =
  process.env.E2E_LOG_CMD ||
  "timeout 20 node /opt/myos/node_modules/convex/bin/main.js logs --history 200 || true";
const ts = Date.now();
const EMAIL = `authtest${ts}@myos.test`, PW = "TestUser#2026", NEWPW = "NewPass#2026";
const errs = [], results = []; let cur = BASE;
const step = async (n, f) => { try { const d = await f(); results.push([true, n, d || ""]); console.log("PASS  " + n + (d ? " — " + d : "")); } catch (e) { results.push([false, n, e.message.split("\n")[0]]); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getCode(label, email) {
  const needle = `${label} code for ${email}`;
  for (let i = 0; i < 12; i++) {
    try {
      const out = execSync(LOG_CMD, {
        encoding: "utf8",
        cwd: CONVEX_DIR,
        stdio: ["ignore", "pipe", "ignore"],
      });
      // Last match wins: a retried flow logs a fresh code and the old one is dead.
      const hits = out.split("\n").filter((l) => l.includes(needle));
      const m = hits.length && hits[hits.length - 1].match(/code for .*?:\s*(\d{6,8})/);
      if (m) return m[1];
    } catch (_) {}
    await sleep(1500);
  }
  throw new Error(`no ${label} code for ${email}`);
}
(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: process.env.CI ? 0 : 150 });
  const ctx = await b.newContext({ viewport: { width: 1366, height: 850 } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errs.push(`[${cur}] ${m.text()}`); });

  await step("login page renders AuthForm + Google", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 }); cur = page.url();
    if (!(await page.locator('button:has-text("Google")').isVisible())) throw new Error("no Google button");
  });

  await step("Sign up (password policy + verify required)", async () => {
    await page.click('button:has-text("Sign up")');
    await page.fill('input[name="name"]', "Auth Test");
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[name="code"]', { timeout: 15000 });
  });
  await step("Email verification (code from logs)", async () => {
    const code = await getCode("email verification", EMAIL);
    await page.fill('input[name="code"]', code);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    return code;
  });
  await step("Onboarding + dashboard (new tenant)", async () => {
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(2500); cur = page.url();
    if (/onboarding/.test(cur)) { await page.fill('input[placeholder="Username"]', `auth${String(ts).slice(-6)}`); await page.click('button:has-text("Continue")'); await page.waitForTimeout(3000); }
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(2000); cur = page.url();
    if (/login|onboarding/.test(cur)) throw new Error("not in dashboard: " + cur);
  });
  await step("Sign out", async () => {
    // The sidebar footer has a plain "Log out" button; the old selector
    // (nav button.rounded-full) described an avatar dropdown that no longer exists.
    await page.getByRole("button", { name: "Log out" }).click({ timeout: 8000 });
    await page.waitForTimeout(2500);
  });
  await step("Forgot password → reset → signed in with new password", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 15000 }); cur = page.url();
    await page.click('button:has-text("Forgot")');
    await page.fill('input[type="email"]', EMAIL);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[name="code"]', { timeout: 15000 });
    const code = await getCode("password reset", EMAIL);
    await page.fill('input[name="code"]', code);
    await page.fill('input[name="newPassword"]', NEWPW);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(2000); cur = page.url();
    if (/login/.test(cur)) throw new Error("reset login failed");
  });
  await step("Admin password sign-in still works (regression)", async () => {
    await page.getByRole("button", { name: "Log out" }).click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 15000 });
    await page.fill('input[type="email"]', "admin@myos.test");
    await page.fill('input[type="password"]', "MyosAdmin#2026");
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(2000); cur = page.url();
    if (/login|onboarding/.test(cur)) throw new Error("admin bounced: " + cur);
  });

  await b.close();
  const pass = results.filter((r) => r[0]).length;
  console.log(`\n========= AUTH E2E: ${pass}/${results.length} =========`);
  results.forEach((r) => console.log(`${r[0] ? "✓" : "✗"} ${r[1]}${r[2] ? " — " + r[2] : ""}`));
  console.log(`console errors: ${errs.length}`); errs.forEach((e) => console.log("  - " + e));
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
