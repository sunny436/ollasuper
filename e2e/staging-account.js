// A second, disposable account on the STAGING stack (deploy/staging).
//
//   node staging-account.js <credsFile>
//
// Staging has no mail transport on purpose (it holds a copy of every real
// user's data; a transport there could email a real person). Its Convex runs
// with AUTH_LOG_CODES=1, so a sign-up code is read from STAGING's own log over
// SSH — never production's, which has a transport and never logs codes.
//
// The password is generated here, written to a 0600 file, and never printed.
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3400";
const VM = process.env.STAGING_VM || "root@172.16.70.25";
if (!/localhost|127\.0\.0\.1/.test(BASE)) throw new Error("staging-account.js only runs against a local staging edge");

const out = process.argv[2];
if (!out) throw new Error("usage: node staging-account.js <credsFile>");

function codeFor(email) {
  const cmd =
    ". /opt/myos-staging/.staging.env && cd /opt/myos-staging/src/packages/backend && " +
    'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3310 CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" ' +
    "timeout 20 node ../../node_modules/convex/bin/main.js logs --history 200 2>/dev/null || true";
  const logs = execFileSync("ssh", ["-o", "BatchMode=yes", VM, cmd], { encoding: "utf8", maxBuffer: 16 << 20 });
  const re = new RegExp(`code for ${email.replace(/[.+]/g, "\\$&")}: (\\d{6,8})`, "g");
  let m;
  let last = null;
  while ((m = re.exec(logs))) last = m[1];
  return last;
}

(async () => {
  const tag = crypto.randomBytes(4).toString("hex");
  const email = `staging-b-${tag}@agent.ollastack.com`;
  const password = `Sb-${crypto.randomBytes(9).toString("base64url")}!9a`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error("  console.error:", m.text().slice(0, 300));
  });
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  // The same steps as qa-throwaway.js: wait for hydration, then sign up.
  await page.waitForFunction(
    () => {
      const f = document.querySelector("form");
      return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber"));
    },
    null,
    { timeout: 30000 },
  );
  await page.click('button:has-text("Create an account")');
  await page.fill('input[name="name"]', "Staging B");
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('input[name="code"]', { timeout: 30000 });
  let code = null;
  for (let i = 0; i < 10 && !code; i++) {
    await page.waitForTimeout(2000);
    code = codeFor(email);
  }
  if (!code) throw new Error("no code in the staging log");
  await page.fill('input[name="code"]', code);
  await page.click('button[type="submit"]');
  try {
    await page.waitForURL(/\/chat/, { timeout: 60000 });
  } catch (e) {
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 400);
    throw new Error(`still on ${page.url()} - page says: ${text}`);
  }
  fs.writeFileSync(out, JSON.stringify({ email, password }), { mode: 0o600 });
  console.log(`staging account ready (${email}); password written to ${out}`);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
