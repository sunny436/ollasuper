// qa-theme-persistence.js — the theme precedence and persistence matrix.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-theme-persistence.js
//   node qa-theme-persistence.js --headless
//
// The rule being defended, which lives in lib/theme/mode.ts:
//
//     explicit account preference  >  localStorage cache  >  OS  >  light
//
// Every case below is one way that ordering has been got wrong in products that
// do this: adopting "no preference" as a preference, letting a slow backend
// response overwrite a fresh local choice, flashing the wrong theme because the
// cache was only read after hydration, or flipping to light when the backend is
// simply unreachable.
//
// The last one is the reason this file exists rather than a checklist. "Convex is
// down" is not reproducible by hand, and it is exactly when a theme flip is most
// visible and least excusable.
const { chromium } = require("playwright");
const { account } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const HEADLESS = process.argv.includes("--headless");

let pass = 0;
const failures = [];
const skipped = [];
const log = (...a) => console.log(...a);

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
    log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  }
}

const state = (page) =>
  page.evaluate(() => ({
    dark: document.documentElement.classList.contains("dark"),
    ds: document.documentElement.dataset.theme || null,
    bg: getComputedStyle(document.body).backgroundColor,
    cached: (() => {
      try {
        return localStorage.getItem("theme");
      } catch {
        return null;
      }
    })(),
  }));

/** A context that has never seen this app, with a chosen OS preference. */
async function fresh(browser, colorScheme, seed) {
  const context = await browser.newContext({
    colorScheme,
    viewport: { width: 1280, height: 800 },
  });
  if (seed !== undefined) {
    // Seeded BEFORE the first navigation, which is the only way to exercise the
    // pre-paint script: setting it afterwards tests the React path instead.
    await context.addInitScript((v) => {
      try {
        if (v === null) localStorage.removeItem("theme");
        else localStorage.setItem("theme", v);
      } catch {}
    }, seed);
  }
  const page = await context.newPage();
  const errs = [];
  page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 140)));
  page.on("pageerror", (e) => errs.push(`pageerror ${e.message.slice(0, 140)}`));
  return { context, page, errs };
}

async function signIn(page, who) {
  await page.goto(`${BASE}/login`, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  await page.locator('input[type="email"]').first().fill(who.email);
  await page.locator('input[type="password"]').first().fill(who.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 90000, waitUntil: "commit" });
  await page.waitForSelector("#chat-composer", { timeout: 60000 });
}

async function main() {
  const who = account();
  const browser = await chromium.launch({ headless: HEADLESS });

  // ---------------------------------------------------------------- 1-2. OS
  for (const [scheme, wantDark] of [
    ["light", false],
    ["dark", true],
  ]) {
    const { context, page } = await fresh(browser, scheme, null);
    await page.goto(`${BASE}/login`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    const s = await state(page);
    check(
      `new visitor, OS ${scheme} -> ${scheme}`,
      s.dark === wantDark && s.ds === scheme,
      JSON.stringify(s),
    );
    await context.close();
  }

  // ------------------------------------------------- 3-4. cache outranks OS
  for (const [cache, scheme] of [
    ["light", "dark"],
    ["dark", "light"],
  ]) {
    const { context, page } = await fresh(browser, scheme, cache);
    await page.goto(`${BASE}/login`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    const s = await state(page);
    check(
      `cached ${cache} beats OS ${scheme}`,
      s.ds === cache && s.dark === (cache === "dark"),
      JSON.stringify(s),
    );
    await context.close();
  }

  // ----------------------------------------------- 5. a corrupt cache value
  {
    const { context, page, errs } = await fresh(browser, "dark", "chartreuse");
    await page.goto(`${BASE}/login`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    const s = await state(page);
    check(
      "invalid cached value falls through to the OS, silently",
      s.ds === "dark" && s.dark === true && errs.length === 0,
      `${JSON.stringify(s)} errs=${errs.length}`,
    );
    await context.close();
  }

  // ------------------------------------- 6-8. signed in: toggle, reload, tab
  //
  // NO seed argument, deliberately. `fresh(…, null)` registers an init script
  // that removes the key at every document start, and addInitScript cannot be
  // unregistered — so it would wipe the cache on the very reload this section
  // asserts survives it, and report the harness's own doing as a product bug.
  // The fresh-visitor cases above want exactly that behaviour; this one must not
  // have it.
  const { context, page, errs } = await fresh(browser, "light");
  await signIn(page, who);
  const toggle = page.locator('button[aria-label="Toggle dark and light theme"]');

  if ((await state(page)).dark) await toggle.first().click();
  await page.waitForTimeout(600);
  await toggle.first().click(); // -> dark
  await page.waitForTimeout(1200);
  {
    const s = await state(page);
    check("toggling writes the cache", s.cached === "dark", JSON.stringify(s));
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 30000 });
  const afterReload = await state(page);
  check(
    "dark survives a reload with no flash",
    afterReload.dark && afterReload.bg === "rgb(0, 0, 0)",
    JSON.stringify(afterReload),
  );

  const tab = await context.newPage();
  await tab.goto(`${BASE}/en/files`, { waitUntil: "domcontentloaded" });
  await tab.waitForTimeout(2500);
  const tabState = await state(tab);
  check("a new tab opens in the same theme", tabState.dark && tabState.ds === "dark", JSON.stringify(tabState));
  await tab.close();

  // ------------------------------ 9. the backend is unreachable: do not flip
  //
  // The failure this guards: a device that cannot reach Convex sees `settings`
  // stay `undefined` forever. Treating that as "no preference" would repaint the
  // whole app light on every flaky connection.
  {
    const offline = await browser.newContext({
      colorScheme: "light",
      viewport: { width: 1280, height: 800 },
      storageState: await context.storageState(),
    });
    await offline.addInitScript(() => {
      try {
        localStorage.setItem("theme", "dark");
        localStorage.setItem("theme_ts", String(Date.now()));
      } catch {}
    });
    const offPage = await offline.newPage();
    // Kill the Convex socket before the app can open it. The page still renders;
    // it just never receives a settings document.
    await offPage.routeWebSocket(/.*/, (ws) => ws.close());
    await offPage.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
    await offPage.waitForTimeout(6000);
    const s = await state(offPage);
    check(
      "Convex unreachable: the theme is kept, not flipped",
      s.dark === true && s.ds === "dark",
      JSON.stringify(s),
    );
    await offline.close();
  }

  // Asserted HERE, before the cross-device step, and not at the end.
  //
  // Step 10 signs a second context into an account that permits one active
  // session, which evicts the first: page A then reloads into a window where its
  // token is dead and Convex logs `M(orgs:ensureWorkspace) Not authenticated`
  // before auth re-establishes. That is the harness creating the condition, not
  // the product failing, and folding it into a blanket "zero console errors"
  // would have been a false failure attributed to the theme work.
  check("no console errors (through step 9)", errs.length === 0, errs.slice(0, 3).join(" | "));
  const errsBeforeCrossDevice = errs.length;

  // ----------------------------------------- 10. cross-device, live adoption
  //
  // Two contexts = two localStorage stores, so nothing can cross by `storage`
  // event. The only path left is the Convex subscription, which is the one being
  // tested. The QA account enforces a single active session, so this reports
  // SKIPPED rather than a false failure if the second login evicts the first.
  {
    const b = await browser.newContext({
      colorScheme: "light",
      viewport: { width: 1280, height: 800 },
    });
    const bPage = await b.newPage();
    let evicted = false;
    try {
      await signIn(bPage, who);
      await bPage.waitForTimeout(2500);
      // A is still signed in?
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .waitForSelector("#chat-composer", { timeout: 20000 })
        .catch(() => {
          evicted = true;
        });
    } catch {
      evicted = true;
    }

    if (evicted) {
      skipped.push(
        "cross-device A->B: the QA account permits a single active session, so two " +
          "signed-in contexts cannot coexist here",
      );
      log("SKIP  cross-device A->B (single-session account)");
    } else {
      const bWasDark = (await state(bPage)).dark;
      if (bWasDark) {
        await bPage.locator('button[aria-label="Toggle dark and light theme"]').first().click();
      }
      await bPage.waitForTimeout(1500);
      // B is light now; A should follow within the subscription, no reload.
      const adopted = await page
        .waitForFunction(() => !document.documentElement.classList.contains("dark"), null, {
          timeout: 20000,
          polling: "raf",
        })
        .then(() => true)
        .catch(() => false);
      check("device B's choice reaches device A live, with no reload", adopted);
    }
    await b.close();
  }

  const crossDeviceErrs = errs.slice(errsBeforeCrossDevice);
  if (crossDeviceErrs.length) {
    log(
      `NOTE  ${crossDeviceErrs.length} console error(s) during the cross-device step, ` +
        "expected from the single-session eviction, not asserted: " +
        crossDeviceErrs.slice(0, 2).join(" | "),
    );
  }

  await context.close();
  await browser.close();

  log(`\n${"=".repeat(64)}`);
  for (const s of skipped) log(`SKIPPED: ${s}`);
  if (failures.length) {
    log(`\nFAILURES (${failures.length}):`);
    for (const f of failures) log(`  ${f}`);
  }
  log(`\ntheme persistence: ${pass} passed, ${failures.length} failed, ${skipped.length} skipped`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
