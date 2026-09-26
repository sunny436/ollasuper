// Diagnostic companion to qa-security-remediation.js: which step do console
// errors come from, and is the session actually alive after each step?
const { chromium } = require("playwright");
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");
const { account } = require("./creds");

const BASE = "https://app.ollasuper.com";
const CVX = `${BASE}/__cvx`;
const { email: EMAIL, password: PASSWORD } = account();
let label = "boot";
const errors = [];

async function alive(ctx) {
  const jwt = (await ctx.cookies()).find((c) => c.name.endsWith("__convexAuthJWT"));
  if (!jwt) return "no-jwt-cookie";
  const c = new ConvexHttpClient(CVX);
  c.setAuth(jwt.value);
  const ws = await c.query(anyApi.orgs.myWorkspaces, {});
  return `workspaces=${ws.length}`;
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${label}] ${m.text().slice(0, 160)}`);
  });
  const mark = async (l) => {
    label = l;
    console.log(`${l}: url=${page.url().replace(BASE, "")} ${await alive(ctx)}`);
  };

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/);
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.waitForSelector("#chat-composer");
  await page.waitForTimeout(5000);
  await mark("after-login");

  await page.goto(`${BASE}/en/chat?code=unsolicited-x`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  await mark("after-code-link");

  const anon = new ConvexHttpClient(CVX);
  await anon.action(anyApi.authSessions.requestPasswordReset, { email: EMAIL });
  await page.waitForTimeout(5000);
  await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  await mark("after-reset-request");

  await page.getByRole("button", { name: "Account menu" }).first().click();
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForTimeout(8000);
  await mark("after-logout");

  console.log(`console errors (${errors.length}):`);
  for (const e of errors) console.log("  " + e);
  await browser.close();
})();
