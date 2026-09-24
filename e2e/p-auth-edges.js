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
  // REWRITTEN 2026-09-24. These two steps used to assert that signing up again
  // with the same address delivers a SECOND code and kills the first. That
  // behaviour was removed on purpose, and re-adding it would reopen an account
  // takeover: an unverified account belongs to whoever squatted the address, and
  // verifyCodeAndSignIn patches emailVerified onto it, so the real owner
  // completing an emailed code ACTIVATES the squatter's password on their own
  // account. convex/passwordProvider.ts now returns the shape of a fresh
  // sign-up and touches nothing — "COLLISION. Touch NOTHING and send NOTHING."
  //
  // So the invariant worth pinning is the opposite one, and it is the security
  // property: a repeat sign-up is SILENT, and it does not disturb the code the
  // real owner is already holding. Reset is the documented recovery path for a
  // squatted address, and the step after this proves a live code still works.
  await step("a repeat sign-up is silent — no second code, and no takeover", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.click('button:has-text("Create an account")');
    await page.fill('input[name="name"]', "Edge Test");
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    // The UI is deliberately identical to a fresh sign-up — it must NOT reveal
    // that the address is taken — so the code screen still appears.
    await page.waitForSelector('input[name="code"]', { timeout: 30000 });
    // Give a second code every chance to show up; none may.
    const deadline = Date.now() + 45000;
    let extra = null;
    while (Date.now() < deadline) {
      const c = await ollastack.codeFromOllastack(TAG, "email verification", 15000);
      if (c && c !== firstCode) {
        extra = c;
        break;
      }
      await sleep(4000);
    }
    must(
      extra === null,
      `a repeat sign-up delivered a second code (${extra}) — that is the account-takeover path convex/passwordProvider.ts closes`,
    );
    return "silent, as designed";
  });

  await step("the owner's existing code still works after that repeat sign-up", async () => {
    must(firstCode, "need the first code");
    await page.fill('input[name="code"]', firstCode);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    cur = page.url();
    must(
      !/login/.test(cur),
      `the real owner's code stopped working after someone else signed up over the address: ${cur}`,
    );
    return "owner's code intact";
  });

  // "the NEWEST code verifies and signs in" used to live here. It signed out,
  // signed up a third time to force a fresh code, and verified with it. Both of
  // its halves are now covered upstream and it can no longer run as written: the
  // step above verifies with a live code and LEAVES THE USER SIGNED IN, so this
  // one's waitForURL(/login/) could never match. Merged rather than repaired —
  // a third sign-up over the same address is exactly the takeover attempt the
  // provider refuses, so it would have been asserting the old behaviour again.

  await step("a refresh mid-session keeps the user signed in", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    cur = page.url();
    must(!/login/.test(cur), `refresh signed the user out: ${cur}`);
    return cur;
  });

  /**
   * The THIRD auth email flow (`resend-otp`), reachable from the sign-in panel
   * as "Sign in with a one-time email code". It has its own template heading,
   * and until now nothing exercised it end to end.
   */
  await step("magic OTP: sign in with a one-time email code", async () => {
    // The previous step left this context SIGNED IN, so /login would just
    // redirect to /chat and the entry point would look missing.
    await ctx.clearCookies();
    await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.waitForTimeout(1200);
    const link = page.getByText("Sign in with a one-time email code");
    must(await link.count(), "no one-time-code entry point on the sign-in panel");
    await link.first().click();
    await page.waitForTimeout(800);
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[name="code"]', { timeout: 30000 });
    // Its subject carries the "OTP" label, which is also how the template
    // selects the "Sign in to OllaSuper" heading.
    const code = await ollastack.codeFromOllastack(TAG, "OTP", 120000);
    must(code, "no one-time sign-in code arrived");
    must(/^\d{8}$/.test(code), `code is not 8 digits: ${code}`);
    await page.fill('input[name="code"]', code);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4500);
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    cur = page.url();
    must(!/login/.test(cur), `one-time code did not sign in: ${cur}`);
    return code;
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
