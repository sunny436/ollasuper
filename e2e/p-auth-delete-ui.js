// The delete-account UI, driven in a real browser against production.
//
// The backend guard is proven by p-auth-deletion.js. This checks the half that
// only a browser can: that the settings page actually asks for the factor, that
// a wrong one surfaces an error instead of silently deleting, and that the right
// one completes and signs the user out.
//
//   OLLASTACK_MAIL_TOKEN=... OLLASTACK_E2E_MAILBOX_ID=... node p-auth-delete-ui.js

const { chromium } = require("playwright");
const ollastack = require("./_lib/ollastack");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const PW = "Del3teUI#2026";

const errs = [];
const results = [];
const step = (ok, name, detail) => {
  results.push([ok, name, detail || ""]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

(async () => {
  if (!ollastack.enabled()) {
    console.log("SKIP: needs OLLASTACK_MAIL_TOKEN + OLLASTACK_E2E_MAILBOX_ID");
    process.exit(1);
  }
  const email = ollastack.taggedAddress(
    await ollastack.mailboxAddress(),
    ollastack.newTag(),
  );
  console.log(`address: ${email}`);

  const b = await chromium.launch({ headless: false, slowMo: 120 });
  const page = await b.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });

  try {
    // ── register ────────────────────────────────────────────────────────────
    // Same selectors p2-auth.js uses — they track the real markup.
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.click('button:has-text("Create an account")');
    await page.fill('input[name="name"]', "Delete UI");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[name="code"]', { timeout: 20000 });

    const code = await ollastack.codeForAddress(email, "verification", 120000);
    if (!code) throw new Error("no verification code arrived");
    await page.fill('input[name="code"]', code);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/chat/, { timeout: 60000 });
    step(true, "registered and signed in");

    // ── the delete card must ASK for something ──────────────────────────────
    await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const secret = page.locator('input[placeholder="Your password"]');
    step(
      (await secret.count()) === 1,
      "the delete card asks for the password",
      `found ${await secret.count()} field(s)`,
    );

    // useDoubleCheck swaps the label to "Are you sure?" on the first click, so a
    // /delete/i locator stops matching exactly when the second click needs it.
    const deleteBtn = page
      .getByRole("button", { name: /delete account|are you sure/i })
      .last();
    step(
      await deleteBtn.isDisabled(),
      "delete is disabled until a password is typed",
    );

    // ── a WRONG password must not delete ────────────────────────────────────
    await secret.fill("N0tMyPassw0rd!");
    await deleteBtn.click(); // arms useDoubleCheck
    await deleteBtn.click(); // confirms
    await page.waitForTimeout(4000);
    const stillOnSettings = /\/settings/.test(page.url());
    step(
      stillOnSettings,
      "a wrong password leaves the user on settings, still signed in",
      page.url(),
    );
    const toast = await page
      .locator("text=/Incorrect password/i")
      .count()
      .catch(() => 0);
    step(toast > 0, "the wrong password surfaces an error", `${toast} toast(s)`);

    // ── the RIGHT password completes ────────────────────────────────────────
    //
    // Reload first. useDoubleCheck is still ARMED from the refused attempt, so
    // clicking twice here would fire the deletion twice — the second call
    // arriving after the row is gone. Reloading restores the real user journey
    // (arm, then confirm) instead of testing a state no user would be in.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const secret2 = page.locator('input[placeholder="Your password"]');
    await secret2.fill(PW);
    const confirmBtn = page
      .getByRole("button", { name: /delete account|are you sure/i })
      .last();
    await confirmBtn.click();
    await confirmBtn.click();
    await page.waitForURL(/\/login/, { timeout: 60000 });
    step(true, "the correct password deletes the account and signs out", page.url());

    // ── and the old credential is dead ──────────────────────────────────────
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(5000);
    step(
      !/\/chat/.test(page.url()),
      "the deleted account cannot sign back in",
      page.url(),
    );
  } catch (e) {
    step(false, "unexpected failure", String(e.message ?? e).slice(0, 200));
  } finally {
    await b.close();
  }

  // A rejected Convex call logs console.error, and this script deliberately
  // provokes one — the wrong-password attempt MUST be refused server-side. That
  // single expected rejection is excluded by its exact message; everything else
  // still fails the run, which is the gate every other e2e script relies on.
  const unexpected = errs.filter((e) => !/Incorrect password/.test(e));
  step(
    unexpected.length === 0,
    "zero unexpected console errors",
    unexpected.slice(0, 3).join(" | "),
  );
  step(
    errs.some((e) => /Incorrect password/.test(e)),
    "the wrong password was refused by the SERVER, not the form",
  );

  const pass = results.filter((r) => r[0]).length;
  console.log(`\n===== DELETE UI: ${pass}/${results.length} =====`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
