// LIVE headed-Chrome red team against the UNAUTHENTICATED surface of prod.
//
// Needs no credentials. It attacks what an anonymous attacker can reach, and
// it also probes the signup flow to establish exactly what gate stands between
// an attacker (or this test) and a session.
//
//   node qa-redteam-public.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
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

(async () => {
  const b = await chromium.launch({ headless: false, slowMo: 40 });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200));
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon"))
      errs.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`);
  });

  await step("anonymous root redirects to login, no crash", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 25000 });
    const t = await page.evaluate(() => document.body.innerText || "");
    if (!t.trim()) throw new Error("login page rendered empty");
  });

  // Every authenticated route must bounce an anonymous visitor. A route that
  // renders instead is an authz hole regardless of what data it shows.
  await step("every private route bounces an anonymous visitor", async () => {
    const leaked = [];
    for (const p of [
      "/en/chat",
      "/en/files",
      "/en/settings",
      "/en/settings/billing",
      "/en/settings/files",
      "/en/settings/memories",
      "/en/settings/shared",
      "/en/settings/archived",
      "/en/projects",
    ]) {
      await page.goto(BASE + p, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(900);
      if (!/login|signup/.test(page.url())) leaked.push(`${p} -> ${page.url()}`);
    }
    if (leaked.length) throw new Error("REACHABLE ANONYMOUSLY: " + leaked.join(", "));
  });

  await step("a forged thread id does not throw ArgumentValidationError", async () => {
    // House invariant: threadId from a URL is v.string() + normalizeId, never
    // v.id(). A v.id() validator would console.error here and fail the gate.
    await page.goto(BASE + "/en/chat/not-a-real-thread-id", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(2500);
    const bad = errs.filter((e) => /ArgumentValidationError/i.test(e));
    if (bad.length) throw new Error("ArgumentValidationError: " + bad[0]);
  });

  await step("login form rejects a bogus credential without leaking which field", async () => {
    await page.goto(BASE + "/en/login", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    const email = page.locator('input[type="email"]').first();
    await email.waitFor({ timeout: 15000 });
    await email.fill(`nosuchuser${Date.now()}@gmail.com`);
    await page.locator('input[type="password"]').first().fill("Wrong-Password-123!");
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
    if (!/login/.test(page.url()))
      throw new Error("BOGUS CREDENTIAL WAS ACCEPTED: " + page.url());
    const t = await page.evaluate(() => document.body.innerText || "");
    // An "unknown account" vs "wrong password" split is a user-enumeration oracle.
    if (/no account|not found|unknown (user|account)|does not exist/i.test(t))
      notes.push("POSSIBLE ENUMERATION ORACLE in login copy: " + t.slice(0, 160));
  });

  await step("probe: what does signup actually require?", async () => {
    await page.goto(BASE + "/en/signup", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const shape = await page.evaluate(() => ({
      url: location.href,
      inputs: [...document.querySelectorAll("input")].map((i) => ({
        name: i.name || i.id || "",
        type: i.type,
      })),
      buttons: [...document.querySelectorAll("button")]
        .map((b) => (b.innerText || "").trim())
        .filter(Boolean)
        .slice(0, 6),
      hasTurnstile:
        !!document.querySelector('[class*="turnstile"], iframe[src*="turnstile"], [data-sitekey]'),
    }));
    notes.push("signup shape: " + JSON.stringify(shape));
    if (!shape.inputs.length) throw new Error("signup page has no inputs");
  });

  console.log("\n--- notes ---");
  for (const n of notes) console.log("  " + n);
  const uniq = [...new Set(errs)];
  console.log("\n--- console/network errors: " + uniq.length + " ---");
  for (const e of uniq.slice(0, 20)) console.log("  " + e);
  const passed = results.filter(([ok]) => ok).length;
  console.log(`\nRESULT ${passed}/${results.length} passed, ${uniq.length} errors`);
  for (const [ok, n] of results) if (!ok) console.log("  FAILED: " + n);
  await b.close();
})();
