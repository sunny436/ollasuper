// Auth edge cases against a REAL inbox, on the deployed stack.
//
// p2-auth.js walks the happy path. These are the cases where a mail transport
// change is most likely to do damage without anyone noticing: a code that must
// be rejected, a resend that must invalidate its predecessor, and the per-address
// send cap that must throttle without ever throwing.
//
//   OLLASTACK_MAIL_TOKEN=... OLLASTACK_E2E_MAILBOX_ID=... node p-auth-edges.js

const { chromium } = require("playwright");
const ollastack = require("./_lib/ollastack");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const PW = "TestUser#2026";

const results = [];
const errs = [];
let cur = BASE;
const step = async (n, f) => {
  try {
    const d = await f();
    results.push([true, n, d || ""]);
    console.log("PASS  " + n + (d ? " — " + d : ""));
    return d;
  } catch (e) {
    const first = String(e.message).split(/\r?\n/)[0];
    results.push([false, n, first]);
    console.log("FAIL  " + n + " — " + first);
    return null;
  }
};
const must = (c, m) => {
  if (!c) throw new Error(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!ollastack.enabled()) {
    console.log("SKIP: needs OLLASTACK_MAIL_TOKEN + OLLASTACK_E2E_MAILBOX_ID");
    process.exit(1);
  }
  const TAG = ollastack.newTag();
  const address = await ollastack.mailboxAddress();
  const EMAIL = ollastack.taggedAddress(address, TAG);
  console.log(`inbox  ${EMAIL}`);

  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 60,
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(`[${cur}] ${m.text()}`);
  });

  await step("sign up reaches the code screen", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 30000 });
    await page.click('button:has-text("Create an account")');
    await page.fill('input[name="name"]', "Edge Test");
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[name="code"]', { timeout: 30000 });
    cur = page.url();
  });

  let firstCode = null;
  await step("the first code arrives in the real inbox", async () => {
    firstCode = await ollastack.codeFromOllastack(TAG, "email verification", 120000);
    must(firstCode, "no code arrived");
    must(/^\d{8}$/.test(firstCode), `code is not 8 digits: ${firstCode}`);
    return firstCode;
  });

  await step("a WRONG code is rejected and does not sign anyone in", async () => {
    // Deliberately not the real code, same shape.
    const wrong = firstCode === "00000000" ? "11111111" : "00000000";
    await page.fill('input[name="code"]', wrong);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    cur = page.url();
    must(/login/.test(cur), `a wrong code got in: ${cur}`);
    return "rejected";
  });

  let secondCode = null;
  await step("a resend delivers a NEW code", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.click('button:has-text("Create an account")');
    await page.fill('input[name="name"]', "Edge Test");
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[name="code"]', { timeout: 30000 });
    // Wait for a code that is genuinely different from the first.
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const c = await ollastack.codeFromOllastack(TAG, "email verification", 20000);
      if (c && c !== firstCode) {
        secondCode = c;
        return c;
      }
      await sleep(4000);
    }
    throw new Error("no second, distinct code arrived");
  });

  await step("the OLD code is now dead — a resend invalidates its predecessor", async () => {
    must(firstCode && secondCode, "need both codes");
    await page.fill('input[name="code"]', firstCode);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    cur = page.url();
    must(
      /login/.test(cur),
      `the superseded code still worked — that is a real auth defect: ${cur}`,
    );
    return "old code rejected";
  });

  await step("the NEWEST code verifies and signs in", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.click('button:has-text("Create an account")');
    await page.fill('input[name="name"]', "Edge Test");
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[name="code"]', { timeout: 30000 });
    const latest = await ollastack.codeFromOllastack(TAG, "email verification", 120000);
    must(latest, "no current code");
    await page.fill('input[name="code"]', latest);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4500);
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    cur = page.url();
    must(!/login/.test(cur), `still not signed in: ${cur}`);
    return cur;
  });

  await step("a refresh mid-session keeps the user signed in", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    cur = page.url();
    must(!/login/.test(cur), `refresh signed the user out: ${cur}`);
    return cur;
  });

  /**
   * authProbe.recordSend caps emailed codes at 6/hour per normalised address
   * and SKIPS silently past the cap — never throws, so the response stays
   * constant. The property under test is that rapid requests neither error nor
   * sign anyone out; a 7th producing no email is CORRECT, not a defect.
   */
  await step("rapid reset requests throttle without erroring", async () => {
    const before = errs.length;
    for (let i = 0; i < 4; i++) {
      await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(800);
      const forgot = page.getByText(/Forgot/i).first();
      if ((await forgot.count()) === 0) break;
      await forgot.click();
      await page.waitForTimeout(600);
      const box = page.locator('input[type="email"]').first();
      if ((await box.count()) === 0) break;
      await box.fill(EMAIL);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(1500);
    }
    must(
      errs.length === before,
      `throttling produced console errors: ${errs.slice(before).join(" | ")}`,
    );
    return "no errors, constant response";
  });

  const pass = results.filter((r) => r[0]).length;
  console.log(`\n========= AUTH EDGES: ${pass}/${results.length} =========`);
  for (const [ok, n, d] of results) {
    console.log(`${ok ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`);
  }
  console.log("console errors:", errs.length);
  for (const e of errs.slice(0, 5)) console.log("  " + e);
  await b.close();
  process.exit(pass === results.length && errs.length === 0 ? 0 : 1);
})();
