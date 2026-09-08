// Red-team QA for the security fixes in 76657e4 / 06d8752 / d62e314, run
// against PRODUCTION in a real browser.
//
// This is an ATTACK script, not a smoke test. Every step tries to break a
// boundary the fixes claim to close, plus the regressions those fixes could
// plausibly have caused — the getUser projection feeds the account rail, and
// the accountStatus check now sits in requireRole, which every workspace
// surface funnels through, so a mistake there takes out files/projects/keys.
//
//   E2E_EMAIL=... E2E_PASSWORD=... node qa-redteam-security.js
//
// Use a DEDICATED test account. The username attacks WRITE to whoever is
// signed in, and a username cannot be cleared once set.
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.E2E_EMAIL || require("./creds").adminEmail();
const PASSWORD = process.env.E2E_PASSWORD || require("./creds").adminPassword();

// Deliberate refusals are the POINT of this suite: a rejected Convex mutation
// always logs console.error, so a blanket zero-errors gate would count our own
// successful attacks as failures. Allowlist the exact refusals we provoke and
// keep the gate strict about everything else.
const EXPECTED_REFUSALS = [
  /That username isn't available\./,
  /Username is already taken\./,
  /Username must be at least 3 characters\./,
  /Username must be 32 characters or fewer\./,
  /Username may only contain letters and numbers\./,
];

const errs = [];
const results = [];
const notes = [];

const step = async (n, fn) => {
  try {
    const r = await fn();
    if (r === "SKIP") {
      results.push(["skip", n]);
      console.log("SKIP  " + n);
      return;
    }
    results.push([true, n]);
    console.log("PASS  " + n);
  } catch (e) {
    results.push([false, n]);
    console.log("FAIL  " + n + " — " + String(e.message).split("\n")[0]);
  }
};

/**
 * Put a username in the field and press Save; return the resulting toast text.
 *
 * Never touches sonner's DOM. An earlier version removed toast nodes directly,
 * which tore React-owned nodes out from under the reconciler and produced a
 * genuine-looking `insertBefore` NotFoundError plus a cascade of click
 * timeouts — a test artefact that reads exactly like an app bug. Wait the
 * toast out instead.
 */
async function trySaveUsername(page, value) {
  await page
    .locator("[data-sonner-toast]")
    .first()
    .waitFor({ state: "detached", timeout: 8000 })
    .catch(() => {});
  const input = page.locator("#username").first();
  await input.click();
  await input.fill(value);
  const save = page.getByRole("button", { name: /^save$/i }).first();
  if (await save.isDisabled()) return "(unchanged - save disabled)";
  await save.click();
  const toast = page.locator("[data-sonner-toast]").first();
  await toast.waitFor({ state: "visible", timeout: 10000 });
  return (await toast.innerText()).trim();
}

async function currentUsername(page) {
  await page.goto(BASE + "/en/settings", { waitUntil: "domcontentloaded" });
  const input = page.locator("#username").first();
  await input.waitFor({ state: "visible", timeout: 20000 });
  await page.waitForTimeout(800);
  return await input.inputValue();
}

(async () => {
  const b = await chromium.launch({ headless: false, slowMo: 40 });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("console: " + m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon"))
      errs.push(`HTTP ${r.status()} ${r.url()}`);
  });

  let baseline = null;

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 25000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(5000);
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    if (/login/.test(page.url())) throw new Error("still on /login after submit");
  });

  await step("M7 regression: the account rail still renders after the projection", async () => {
    await page.waitForSelector("#chat-composer", { timeout: 25000 });
    const t = await page.evaluate(() => document.body.innerText || "");
    if (!t.trim()) throw new Error("chat shell rendered empty");
    if ((await page.locator("aside button, nav button").count()) === 0)
      throw new Error("no account trigger in the rail");
  });

  await step("regression: /en/files loads (userFiles.list behind isActiveUser)", async () => {
    await page.goto(BASE + "/en/files", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    if (/login/.test(page.url())) throw new Error("bounced to login");
    const t = await page.evaluate(() => document.body.innerText || "");
    if (/something went wrong|forbidden/i.test(t))
      throw new Error("files page shows an error state");
  });

  await step("settings loads and exposes the profile form", async () => {
    baseline = await currentUsername(page);
    notes.push(`username on this account at start: ${JSON.stringify(baseline)}`);
  });

  // A username cannot be cleared once set, so establish a known-good baseline
  // FIRST. This doubles as the happy-path test: if the security rules also
  // reject legitimate names, the fix is a denial of service.
  await step("happy path: a valid unused username is accepted", async () => {
    if (baseline && baseline.length >= 3) {
      notes.push(`account already has "${baseline}"; using it as the baseline`);
      return;
    }
    const candidate = "qaprobe" + Date.now().toString().slice(-7);
    const t = await trySaveUsername(page, candidate);
    if (!/profile updated/i.test(t)) throw new Error("VALID NAME REJECTED: " + t);
    baseline = candidate;
    notes.push(`claimed baseline username: ${candidate}`);
  });

  // ---- The attacks. Each must be refused AND must leave the baseline intact.
  const attacks = [
    ["H4: reserved 'admin' is refused", "admin"],
    ["H4: case variant 'AdMiN' is refused", "AdMiN"],
    ["H4: reserved 'root' is refused", "root"],
    ["H4: reserved 'support' is refused", "support"],
    ["M5: padded short name '  a  ' is refused", "  a  "],
    ["M5: padded '  ab  ' is refused", "  ab  "],
    ["M5: 'ab' (2 chars) is refused", "ab"],
    ["charset: 'a-b' is refused", "a-b"],
    ["charset: 'a b' is refused", "a b"],
    ["length: 33 chars is refused", "a".repeat(33)],
  ];
  for (const [name, value] of attacks) {
    await step(name, async () => {
      const t = await trySaveUsername(page, value);
      if (/profile updated/i.test(t))
        throw new Error(`ACCEPTED ${JSON.stringify(value)}: ${t}`);
      if (/uncaught convexerror|at handler|\.ts:\d+/i.test(t))
        throw new Error("RAW SERVER ERROR IN UI: " + JSON.stringify(t));
    });
  }

  await step("the attacks did not corrupt the stored username", async () => {
    const now = await currentUsername(page);
    if (now !== baseline)
      throw new Error(`username changed from ${baseline} to ${now}`);
  });

  // ---- d62e314: grandfathering must cover the name you already hold. Typing
  // your OWN name in a different case is dirty (so Save is enabled) but
  // normalises to what you already have, which must be a no-op, not a refusal.
  await step("d62e314: re-claiming your OWN username in a different case is allowed", async () => {
    if (!baseline || baseline.length < 3) return "SKIP";
    const variant = baseline.toUpperCase();
    if (variant === baseline) return "SKIP";
    const t = await trySaveUsername(page, variant);
    if (/isn't available|already taken/i.test(t))
      throw new Error("ONE-WAY DOOR STILL PRESENT: " + t);
    if (!/profile updated|unchanged/i.test(t))
      throw new Error("unexpected result: " + t);
  });

  await step("username survives a full page reload (it really persisted)", async () => {
    const now = await currentUsername(page);
    if (now !== baseline) throw new Error(`after reload: ${now} != ${baseline}`);
  });

  await step("regression: chat still generates after the requireRole change", async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    const composer = page.locator("#chat-composer");
    await composer.waitFor({ timeout: 25000 });
    await composer.click();
    await page.keyboard.type("Reply with exactly: REDTEAMOK");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => /REDTEAMOK/i.test(document.body.innerText || ""),
      { timeout: 120000 },
    );
  });

  await step("regression: every settings sub-page loads", async () => {
    for (const p of [
      "/en/settings/billing",
      "/en/settings/files",
      "/en/settings/memories",
      "/en/settings/personalization",
      "/en/settings/shared",
      "/en/settings/archived",
    ]) {
      await page.goto(BASE + p, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      const t = await page.evaluate(() => document.body.innerText || "");
      if (/something went wrong|forbidden|not authenticated/i.test(t))
        throw new Error(`${p} shows an error state`);
    }
  });

  console.log("\n--- notes ---");
  for (const n of notes) console.log("  " + n);

  const uniq = [...new Set(errs)];
  const expected = uniq.filter((e) => EXPECTED_REFUSALS.some((r) => r.test(e)));
  const unexpected = uniq.filter((e) => !EXPECTED_REFUSALS.some((r) => r.test(e)));
  console.log(
    `\n--- console/network errors: ${unexpected.length} unexpected, ` +
      `${expected.length} expected refusals (our own attacks) ---`,
  );
  for (const e of unexpected.slice(0, 20)) console.log("  UNEXPECTED " + e.slice(0, 300));

  const passed = results.filter(([ok]) => ok === true).length;
  const failed = results.filter(([ok]) => ok === false);
  const skipped = results.filter(([ok]) => ok === "skip").length;
  console.log(
    `\nRESULT ${passed} passed, ${failed.length} failed, ${skipped} skipped, ` +
      `${unexpected.length} unexpected console errors`,
  );
  for (const [, n] of failed) console.log("  FAILED: " + n);
  await b.close();
  process.exit(failed.length === 0 && unexpected.length === 0 ? 0 : 1);
})();
