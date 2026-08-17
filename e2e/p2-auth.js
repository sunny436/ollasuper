// Full auth E2E over Cloudflare HTTPS: signup+verify, reset, admin regression, google button.
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
// Verification and reset codes are delivered by email. Once a mail transport is
// configured (SMTP_HOST / RESEND_API_KEY) the providers stop echoing codes to the
// Convex log stream — that log fallback was an authentication bypass for anyone
// with log access, so it now exists only for local dev with no transport at all.
//
// Primary source is therefore the Mailpit inbox. The log path is kept as a
// fallback so a developer running with no SMTP configured is not stuck.
const MAILPIT = process.env.E2E_MAILPIT_URL || "http://127.0.0.1:8025";
const CONVEX_DIR = process.env.CONVEX_DIR || "/opt/myos/packages/backend";
const LOG_CMD =
  process.env.E2E_LOG_CMD ||
  "timeout 20 node /opt/myos/node_modules/convex/bin/main.js logs --history 200 || true";
const ts = Date.now();
const EMAIL = `authtest${ts}@myos.test`, PW = "TestUser#2026", NEWPW = "NewPass#2026";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
// Fallback is for the EPHEMERAL CI stack only; set ADMIN_PASSWORD for any
// internet-reachable deployment.
const ADMIN_PW = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const errs = [], results = []; let cur = BASE;
const step = async (n, f) => {
  try {
    const d = await f();
    results.push([true, n, d || ""]);
    console.log("PASS  " + n + (d ? " — " + d : ""));
  } catch (e) {
    const first = String(e.message).split(/\r?\n/)[0];
    results.push([false, n, first]);
    console.log("FAIL  " + n + " — " + first);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function codeFromMailpit(label, email) {
  const q = encodeURIComponent(`to:${email}`);
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${q}&limit=25`);
  if (!res.ok) return null;
  const { messages = [] } = await res.json();
  // Newest first: a resend must invalidate its predecessor, so an older code is
  // not merely stale, it is wrong.
  for (const m of messages) {
    const full = await fetch(`${MAILPIT}/api/v1/message/${m.ID}`);
    if (!full.ok) continue;
    const body = await full.json();
    const text = `${body.Subject || ""} ${body.Text || ""}`;
    if (!text.toLowerCase().includes(label.toLowerCase())) continue;
    const hit = text.match(/\b(\d{6,8})\b/);
    if (hit) return hit[1];
  }
  return null;
}

function codeFromLogs(label, email) {
  try {
    const out = execSync(LOG_CMD, { encoding: "utf8", cwd: CONVEX_DIR, stdio: ["ignore","pipe","ignore"] });
    const hits = out
      .split(/\r?\n/)
      .filter((l) => l.includes(`${label} code for ${email}`));
    const m = hits.length && hits[hits.length - 1].match(/code for .*?:\s*(\d{6,8})/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function getCode(label, email) {
  for (let i = 0; i < 12; i++) {
    const viaMail = await codeFromMailpit(label, email).catch(() => null);
    if (viaMail) return viaMail;
    const viaLog = codeFromLogs(label, email);
    if (viaLog) return viaLog;
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
  await step("Email verification (code from inbox)", async () => {
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
    await page.fill('input[type="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PW);
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
