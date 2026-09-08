// Red-team QA for the security fixes in 76657e4 + 06d8752, against PRODUCTION.
//
// This is an ATTACK script, not a smoke test. Every step tries to break a
// boundary I claimed to have closed, plus the regressions those fixes could
// plausibly have caused (the getUser projection feeding the sidebar, and the
// accountStatus check newly sitting in requireRole — which every workspace
// surface funnels through, so a mistake there takes out files/projects/keys).
//
//   ADMIN_PASSWORD=... node qa-redteam-security.js
//
// Headed by default (set CI=1 for headless). Zero console errors is a gate:
// a rejected Convex call logs console.error, which is how a broken authz check
// shows up even when the UI still looks fine.
const { chromium } = require("playwright");
const { adminEmail, adminPassword } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = adminEmail();
const PASSWORD = adminPassword();

// Mirror of convex/profilePolicy.ts: would the server accept this name back?
const RESERVED = new Set([
  "admin", "administrator", "root", "system", "support", "api", "www", "null",
  "undefined", "me", "self", "help", "billing", "security", "owner", "staff",
  "moderator", "mod", "official", "team", "ollasuper", "myos",
]);
function isRestorable(name) {
  if (!name) return false;
  const v = name.trim().toLowerCase();
  return (
    v.length >= 3 && v.length <= 32 && /^[a-z0-9]+$/.test(v) && !RESERVED.has(v)
  );
}

const errs = [];
const results = [];
const notes = [];

const step = async (n, fn) => {
  try {
    await fn();
    results.push([true, n]);
    console.log("PASS  " + n);
  } catch (e) {
    results.push([false, n]);
    console.log("FAIL  " + n + " — " + String(e.message).split("\n")[0]);
  }
};

/** Type a username into the profile form and press Save. Returns the toast text. */
async function trySaveUsername(page, value) {
  const input = page.locator('input[name="username"], #username').first();
  await input.click();
  await input.fill("");
  await input.type(value, { delay: 15 });
  // Save is only enabled when the form is dirty.
  const save = page.getByRole("button", { name: /^save$/i }).first();
  // Save is disabled unless the form is dirty. Typing the value the account
  // ALREADY holds is not an attack, it is a no-op — say so instead of hanging.
  if (await save.isDisabled()) return "(unchanged - save disabled)";
  await save.click();
  // sonner renders into [data-sonner-toast]; take whichever appears first.
  const toast = page.locator("[data-sonner-toast]").first();
  await toast.waitFor({ state: "visible", timeout: 8000 });
  const text = (await toast.innerText()).trim();
  // Let it clear so the next assertion reads a fresh toast.
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    for (const t of document.querySelectorAll("[data-sonner-toast]")) t.remove();
  });
  return text;
}

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 45,
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) {
      errs.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });

  let originalUsername = null;

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 25000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    if (/login/.test(page.url())) throw new Error("still on /login after submit");
  });

  // ---- M7: the getUser projection is what the account menu renders. If I cut
  // a field the UI actually reads, this is where it shows up as a blank rail.
  await step("M7 regression: account identity still renders after the projection", async () => {
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    const shell = await page.evaluate(() => document.body.innerText || "");
    if (!shell.trim()) throw new Error("chat shell rendered empty");
    // The account menu at the foot of the rail is the ONLY route out of /chat.
    const menu = page.getByRole("button").filter({ hasText: /@|profile|account/i });
    if ((await menu.count()) === 0) {
      // Fall back to any avatar/initial trigger in the rail.
      const anyTrigger = await page.locator("aside button, nav button").count();
      if (anyTrigger === 0) throw new Error("no account trigger in the rail");
    }
  });

  await step("regression: /en/files loads (userFiles.list + isActiveUser)", async () => {
    await page.goto(BASE + "/en/files", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    if (/login/.test(page.url())) throw new Error("bounced to login");
    const t = await page.evaluate(() => document.body.innerText || "");
    if (/something went wrong|forbidden/i.test(t))
      throw new Error("files page shows an error state");
  });

  await step("regression: settings loads and shows the profile form", async () => {
    await page.goto(BASE + "/en/settings", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const input = page.locator('input[name="username"], #username').first();
    await input.waitFor({ state: "visible", timeout: 15000 });
    originalUsername = await input.inputValue();
    notes.push(`current username on this account: "${originalUsername}"`);
  });

  // ---- H4: reserved names. Pre-fix, "AdMiN" stored "admin".
  await step("H4: reserved username 'admin' is refused", async () => {
    const t = await trySaveUsername(page, "admin");
    if (/profile updated/i.test(t)) throw new Error("RESERVED NAME ACCEPTED: " + t);
    notes.push(`reserved 'admin' toast: ${JSON.stringify(t)}`);
  });

  await step("H4: case variant 'AdMiN' is refused (not normalised into admin)", async () => {
    const t = await trySaveUsername(page, "AdMiN");
    if (/profile updated/i.test(t)) throw new Error("CASE VARIANT ACCEPTED: " + t);
    notes.push(`reserved 'AdMiN' toast: ${JSON.stringify(t)}`);
  });

  await step("H4: 'root' is refused", async () => {
    const t = await trySaveUsername(page, "root");
    if (/profile updated/i.test(t)) throw new Error("RESERVED NAME ACCEPTED: " + t);
  });

  // ---- M5: the padding bypass. "  a  " used to store "a".
  await step("M5: padded short name '  a  ' is refused", async () => {
    const t = await trySaveUsername(page, "  a  ");
    if (/profile updated/i.test(t)) throw new Error("PADDING BYPASS ALIVE: " + t);
  });

  await step("M5: 'ab' (2 chars) is refused", async () => {
    const t = await trySaveUsername(page, "ab");
    if (/profile updated/i.test(t)) throw new Error("SHORT NAME ACCEPTED: " + t);
  });

  await step("charset: 'a-b' is refused", async () => {
    const t = await trySaveUsername(page, "a-b");
    if (/profile updated/i.test(t)) throw new Error("BAD CHARSET ACCEPTED: " + t);
  });

  // ---- The happy path must still work, or the fix is a denial of service.
  await step("a valid unused username is accepted", async () => {
    // ONE-WAY DOOR GUARD. Claiming a probe name is only safe if we can put the
    // original back. A grandfathered reserved/invalid name (prod has exactly
    // one: "admin") CANNOT be re-claimed, so changing away from it would
    // permanently strip this account's identity. Refuse to run rather than
    // cause the damage; the report says why.
    if (!isRestorable(originalUsername)) {
      notes.push(
        `SKIPPED claim/restore round-trip: "${originalUsername}" is reserved or ` +
          "invalid, so it could not be restored. This is itself a finding.",
      );
      return;
    }
    const candidate = "qaprobe" + Date.now().toString().slice(-6);
    const t = await trySaveUsername(page, candidate);
    if (!/profile updated/i.test(t))
      throw new Error("VALID NAME REJECTED: " + t);
    notes.push(`claimed probe username: ${candidate}`);
  });

  await step("error text is human-readable (no raw 'Uncaught ConvexError')", async () => {
    const t = await trySaveUsername(page, "admin");
    if (/uncaught convexerror|at handler|convex\/users\.ts/i.test(t))
      throw new Error("RAW SERVER ERROR LEAKED TO UI: " + JSON.stringify(t));
  });

  await step("restore the original username", async () => {
    if (!originalUsername) throw new Error("never captured the original");
    if (!isRestorable(originalUsername)) {
      notes.push("restore skipped: nothing was changed (see guard above)");
      return;
    }
    const t = await trySaveUsername(page, originalUsername);
    if (!/profile updated/i.test(t))
      throw new Error(
        `COULD NOT RESTORE "${originalUsername}" — grandfathered name is now unsettable: ` + t,
      );
  });

  await step("regression: chat still generates after the requireRole change", async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    const composer = page.locator("#chat-composer");
    await composer.waitFor({ timeout: 20000 });
    await composer.click();
    await page.keyboard.type("Reply with exactly: OK");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => /OK/i.test(document.body.innerText || ""),
      { timeout: 90000 },
    );
  });

  await step("regression: settings sub-pages all load", async () => {
    for (const p of [
      "/en/settings/billing",
      "/en/settings/files",
      "/en/settings/memories",
      "/en/settings/personalization",
      "/en/settings/shared",
      "/en/settings/archived",
    ]) {
      await page.goto(BASE + p, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      const t = await page.evaluate(() => document.body.innerText || "");
      if (/something went wrong|forbidden|not authenticated/i.test(t))
        throw new Error(`${p} shows an error state`);
    }
  });

  console.log("\n--- notes ---");
  for (const n of notes) console.log("  " + n);

  const uniq = [...new Set(errs)];
  console.log("\n--- console/network errors: " + uniq.length + " ---");
  for (const e of uniq.slice(0, 25)) console.log("  " + e);

  const passed = results.filter(([ok]) => ok).length;
  console.log(`\nRESULT ${passed}/${results.length} passed, ${uniq.length} console errors`);
  for (const [ok, n] of results) if (!ok) console.log("  FAILED: " + n);

  if (!process.env.KEEP_OPEN) await b.close();
  process.exit(passed === results.length && uniq.length === 0 ? 0 : 1);
})();
