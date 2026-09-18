// qa-accent.js — the accent colour system, in a real browser.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-accent.js
//   node qa-accent.js --headless
//
// The static half (apps/app/src/lib/theme/monochrome.test.ts) reads globals.css
// and proves the palette is complete and legible. It cannot see:
//
//   1. Whether the attribute actually reaches <html> BEFORE paint.
//   2. Whether a component picked up the accent or is still on --primary.
//   3. Whether accent and light/dark are genuinely independent.
//   4. What a hostile stored value does to a live page.
//   5. Whether the clamp re-measures when the bubble's width changes.
//
// RULE FOR EVERY CHECK BELOW: it must be able to FAIL. An earlier version of
// this file had four assertions that passed on empty sets — "no button is
// black" on a page with no buttons, a regex with a literal backspace in it —
// and one that measured the wrong rung of the precedence chain. Each check now
// asserts the PRESENCE of the required state against an exact expected value.
//
// The suite CAPTURES the account's theme and accent after sign-in and RESTORES
// them at the end, verified — it does not leave production QA data wherever the
// last step happened to put it.
const { chromium } = require("playwright");
const { account } = require("./creds");
const { capturePrefs, restorePrefs } = require("./pref-state");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const HEADLESS = process.argv.includes("--headless");

/** The palette, exactly as globals.css declares it. A wrong or missing block
 *  fails the matching check by VALUE, not by "something non-empty was there". */
const EXPECTED = {
  blue: { light: "221.2 83.2% 53.3%", dark: "213.1 93.9% 67.8%" },
  green: { light: "142.4 71.8% 29.2%", dark: "141.9 69.2% 58%" },
  yellow: { light: "47.9 95.8% 53.1%", dark: "47.9 95.8% 53.1%" },
  pink: { light: "333.3 71.4% 50.6%", dark: "328.6 85.5% 70.2%" },
  orange: { light: "17.5 88.3% 40.4%", dark: "27 96% 61%" },
  purple: { light: "271.5 81.3% 55.9%", dark: "270 95.2% 75.3%" },
  neutral: { light: "0 0% 0%", dark: "0 0% 100%" },
};
const ACCENTS = Object.keys(EXPECTED);

let pass = 0;
const failures = [];
const log = (...a) => console.log(...a);
const check = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
    log(`FAIL  ${name}  (${detail})`);
  }
};

/** Runs in the page. WCAG 2.1 contrast between two computed rgb() strings. */
const CONTRAST_SRC = `
  const px = (s) => { const m = s && s.match(/rgba?\\(([^)]+)\\)/); return m ? m[1].split(/[,\\/]/).map(Number.parseFloat).slice(0, 3) : null; };
  const lum = (c) => { const [r, g, b] = c.map((n) => { const x = n / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const [x, y] = [lum(px(a)), lum(px(b))]; const [hi, lo] = x > y ? [x, y] : [y, x]; return (hi + 0.05) / (lo + 0.05); };
`;

function readState(page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      accent: document.documentElement.dataset.accent || null,
      theme: document.documentElement.dataset.theme || null,
      dark: document.documentElement.classList.contains("dark"),
      brand: v("--brand"),
      injectedStyle: document.documentElement.getAttribute("style"),
      cached: (() => {
        try {
          return { accent: localStorage.getItem("accent"), theme: localStorage.getItem("theme") };
        } catch {
          return null;
        }
      })(),
    };
  });
}

/** The LAST user bubble on the page, with its Show more control, measured. */
function readBubble(page) {
  return page.evaluate((src) => {
    const helpers = new Function(`${src}; return { contrast };`)();
    const bubbles = [...document.querySelectorAll("div.rounded-br-md")];
    const el = bubbles[bubbles.length - 1];
    if (!el) return null;
    const p = el.querySelector("p");
    const btn = el.querySelector("button");
    const bg = getComputedStyle(el).backgroundColor;
    const ps = getComputedStyle(p);
    return {
      bg,
      clientH: p.clientHeight,
      scrollH: p.scrollHeight,
      clamped: p.scrollHeight > p.clientHeight + 1,
      masked: /gradient/.test(ps.maskImage || ps.webkitMaskImage || ""),
      button: btn ? btn.textContent.trim() : null,
      buttonOpacity: btn ? getComputedStyle(btn).opacity : null,
      buttonContrast: btn ? +helpers.contrast(getComputedStyle(btn).color, bg).toFixed(2) : null,
    };
  }, CONTRAST_SRC);
}

const seed = (page, accent, mode) =>
  page.evaluate(
    ([a, m, ts]) => {
      try {
        if (a) {
          localStorage.setItem("accent", a);
          localStorage.setItem("accent_ts", String(ts));
        } else {
          localStorage.removeItem("accent");
          localStorage.removeItem("accent_ts");
        }
        if (m) {
          localStorage.setItem("theme", m);
          localStorage.setItem("theme_ts", String(ts));
        }
      } catch {}
    },
    [accent, mode, Date.now()],
  );

async function signIn(page, who) {
  await page.goto(`${BASE}/login`, { waitUntil: "load" });
  await page.waitForTimeout(2400);
  await page.locator('input[type="email"]').first().fill(who.email);
  await page.locator('input[type="password"]').first().fill(who.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 90000, waitUntil: "commit" });
  await page.waitForSelector("#chat-composer", { timeout: 60000 });
}

async function reloadWith(page, accent, mode) {
  await seed(page, accent, mode);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1700);
  return readState(page);
}

const untilIdle = (page) =>
  page
    .waitForFunction(() => !document.querySelector('button[aria-label="Stop generating"]'), null, { timeout: 120000 })
    .catch(() => {});

async function main() {
  const who = account();
  const browser = await chromium.launch({ headless: HEADLESS });
  const errs = [];
  const attach = (page) => {
    page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 150)));
    page.on("pageerror", (e) => errs.push(`pageerror ${e.message.slice(0, 150)}`));
  };

  // ------------------------------------------------- default for a fresh visitor
  // Its own context, so nothing from the account can reach it. This is the
  // actual first-time path; the account rung of the chain is tested separately.
  {
    const fresh = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    const fp = await fresh.newPage();
    attach(fp);
    await fp.goto(`${BASE}/login`, { waitUntil: "load" });
    await fp.waitForTimeout(1800);
    const s = await readState(fp);
    check("a first-time visitor resolves to Blue", s.accent === "blue", `data-accent=${s.accent}`);
    check("...and Blue is the blue palette, not ink", s.brand === EXPECTED.blue.light, `--brand=${s.brand}`);
    await fresh.close();
  }

  // ------------------------------------------------------ sign in, CAPTURE
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  attach(page);
  await signIn(page, who);
  const original = await capturePrefs(page);

  // The account rung: with no local cache, the account value comes back.
  await reloadWith(page, "pink", null);
  await page.waitForTimeout(2800); // the upsert must land before the cache is dropped
  const s0 = await reloadWith(page, null, null);
  check("with no local cache, the account preference is restored", s0.accent === "pink", `data-accent=${s0.accent}`);

  // ------------------------------------ every accent, both modes, EXACT values
  for (const accent of ACCENTS) {
    for (const mode of ["light", "dark"]) {
      const s = await reloadWith(page, accent, mode);
      const want = EXPECTED[accent][mode];
      check(
        `${accent}/${mode}: --brand is exactly ${want}`,
        s.accent === accent && s.dark === (mode === "dark") && s.brand === want,
        `attr=${s.accent} dark=${s.dark} --brand=${s.brand}`,
      );
    }
  }

  // ------------------------------------------------------------- independence
  await reloadWith(page, "purple", "light");
  await page.locator('button[aria-label="Toggle dark and light theme"]').first().click();
  await page.waitForTimeout(900);
  let s = await readState(page);
  check("light -> dark keeps the accent", s.accent === "purple" && s.dark === true, `accent=${s.accent} dark=${s.dark}`);

  await page.goto(`${BASE}/settings/appearance`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  const darkBefore = (await readState(page)).dark;
  await page.locator('input[name="accent"][value="green"]').check({ force: true });
  await page.waitForTimeout(900);
  s = await readState(page);
  check("accent A -> B keeps the appearance", s.accent === "green" && s.dark === darkBefore, `accent=${s.accent} dark=${s.dark} (was ${darkBefore})`);
  check("the picker writes the cache", s.cached?.accent === "green", `cached=${s.cached?.accent}`);

  // Seven swatches, seven colours — the bug that shipped once.
  const swatches = await page.evaluate(() =>
    [...document.querySelectorAll("span[data-accent]")].map((el) => getComputedStyle(el).backgroundColor),
  );
  check("the seven swatches paint seven different colours", swatches.length === 7 && new Set(swatches).size === 7, `${new Set(swatches).size} distinct of ${swatches.length}`);

  // --------------------------------------------------------------- persistence
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  check("accent survives a reload", (await readState(page)).accent === "green");
  const tab = await ctx.newPage();
  attach(tab);
  await tab.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
  await tab.waitForTimeout(2400);
  check("a new tab opens on the same accent", (await readState(tab)).accent === "green");
  await tab.close();

  // ----------------------------------------------------- a hostile stored value
  await page.evaluate(() => {
    localStorage.setItem("accent", "red; background:url(//evil)");
    localStorage.setItem("accent_ts", String(Date.now()));
  });
  const errsBefore = errs.length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  s = await readState(page);
  check("an invalid stored accent falls back to Blue", s.accent === "blue" && s.brand === EXPECTED.blue.light, `data-accent=${s.accent} --brand=${s.brand}`);
  check("...and injects no style attribute", s.injectedStyle === null, `style=${s.injectedStyle}`);
  check("...and logs nothing", errs.length === errsBefore, errs.slice(errsBefore, errsBefore + 2).join(" | "));

  // ---------------------------------------- the user bubble, under every accent
  //
  // One long message, then the accent is switched fourteen times over the SAME
  // thread. Each pass measures the "Show more" text against the bubble it sits
  // on — the control an earlier version shipped at 80% opacity, which put white
  // on blue at 3.9:1 and on pink at 3.5:1.
  await reloadWith(page, "blue", "light");
  await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 60000 });
  await page.waitForTimeout(1200);
  const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1} of a deliberately long pasted message`).join("\n");
  await page.locator("#chat-composer").fill(long);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 20000 });
  await page.waitForTimeout(2500);
  const threadUrl = page.url();

  for (const accent of ACCENTS) {
    for (const mode of ["light", "dark"]) {
      await seed(page, accent, mode);
      await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
      const b = await readBubble(page);
      const st = await readState(page);
      const ok =
        !!b &&
        b.button === "Show more" &&
        b.clamped &&
        b.masked &&
        b.buttonOpacity === "1" &&
        b.buttonContrast >= 4.5 &&
        st.brand === EXPECTED[accent][mode];
      check(
        `${accent}/${mode}: accent bubble, Show more present at >= 4.5:1`,
        ok,
        b ? `contrast=${b.buttonContrast} opacity=${b.buttonOpacity} clamped=${b.clamped} masked=${b.masked} button=${b.button}` : "no bubble",
      );
    }
  }

  await page.locator("div.rounded-br-md button", { hasText: "Show more" }).last().click();
  await page.waitForTimeout(500);
  let b = await readBubble(page);
  check("Show more expands: full height, mask gone, Show less", !!b && !b.clamped && !b.masked && b.button === "Show less", b ? `clamped=${b.clamped} masked=${b.masked} button=${b.button}` : "no bubble");
  await page.locator("div.rounded-br-md button", { hasText: "Show less" }).last().click();
  await page.waitForTimeout(500);
  b = await readBubble(page);
  check("Show less collapses again", !!b && b.clamped && b.masked && b.button === "Show more");

  // --------------------------------------------------- clamp re-measures on resize
  //
  // A message that FITS in 12 lines at desktop width and does not at phone
  // width. Without a ResizeObserver the state is decided once on mount and this
  // fails in both directions.
  await untilIdle(page);
  await page.waitForTimeout(800);
  const wrappy = Array.from({ length: 6 }, (_, i) => `row ${i + 1}: ${"a fairly long sentence that wraps only when the bubble is narrow ".repeat(2).trim()}`).join("\n");
  await page.locator("#chat-composer").fill(wrappy);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  b = await readBubble(page);
  check("resize: fits at 1280 -> no clamp, no button", !!b && !b.clamped && b.button === null, b ? `clamped=${b.clamped} button=${b.button} h=${b.clientH}` : "no bubble");
  await page.setViewportSize({ width: 420, height: 820 });
  await page.waitForTimeout(900);
  b = await readBubble(page);
  check("resize: overflows at 420 -> clamped, Show more appears", !!b && b.clamped && b.masked && b.button === "Show more", b ? `clamped=${b.clamped} button=${b.button} h=${b.clientH}` : "no bubble");
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForTimeout(900);
  b = await readBubble(page);
  check("resize: back to 1280 -> button withdrawn", !!b && !b.clamped && b.button === null, b ? `clamped=${b.clamped} button=${b.button}` : "no bubble");

  // -------------------------------------- the shared <Button> default variant
  const errsBefore404 = errs.length;
  await page.goto(`${BASE}/this-route-does-not-exist`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  const goHome = await page.evaluate((src) => {
    const helpers = new Function(`${src}; return { contrast };`)();
    const btn = [...document.querySelectorAll("button")].find((b) => /go home/i.test(b.textContent || ""));
    if (!btn) return null;
    const hsl = getComputedStyle(document.documentElement).getPropertyValue("--brand").trim();
    const probe = document.createElement("div");
    probe.style.cssText = `position:absolute;visibility:hidden;background:hsl(${hsl})`;
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const cs = getComputedStyle(btn);
    return { onBrand: /(^|\s)bg-brand(\s|$)/.test(btn.className), bg: cs.backgroundColor, expected, textContrast: +helpers.contrast(cs.color, cs.backgroundColor).toFixed(2) };
  }, CONTRAST_SRC);
  // Exactly the document's own 404 is dropped from the gate, nothing else.
  for (let i = errs.length - 1; i >= errsBefore404; i--) {
    if (/Failed to load resource: the server responded with a status of 404/.test(errs[i])) errs.splice(i, 1);
  }
  check(
    "the shared <Button> paints the accent with legible text",
    !!goHome && goHome.onBrand && goHome.bg === goHome.expected && goHome.textContrast >= 4.5,
    goHome ? `bg=${goHome.bg} expected=${goHome.expected} text=${goHome.textContrast}:1` : "Go home button not found",
  );

  // ------------------------------------------- logout -> login, no local cache
  await page.goto(`${BASE}/settings/appearance`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.locator('input[name="accent"][value="yellow"]').check({ force: true });
  await page.waitForTimeout(2600);
  await ctx.clearCookies();
  await page.evaluate(() => localStorage.clear());
  await signIn(page, who);
  await page.waitForTimeout(2800);
  check("logout -> login restores the account accent with no cache", (await readState(page)).accent === "yellow");

  // ---------------------------------------------- the backend is unreachable
  {
    const offline = await browser.newContext({ viewport: { width: 1280, height: 820 }, storageState: await ctx.storageState() });
    await offline.addInitScript(() => {
      localStorage.setItem("accent", "purple");
      localStorage.setItem("accent_ts", String(Date.now()));
    });
    const off = await offline.newPage();
    await off.routeWebSocket(/.*/, (ws) => ws.close());
    await off.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await off.waitForTimeout(6000);
    check("backend unreachable: the local accent is kept, not flipped", (await readState(off)).accent === "purple");
    await offline.close();
  }

  // ------------------------------------------------------------- RESTORE
  check("account prefs restored to what the suite found", await restorePrefs(page, original, BASE));

  check("zero console errors", errs.length === 0, errs.slice(0, 3).join(" | "));

  await ctx.close();
  await browser.close();
  log(`\n${"=".repeat(64)}`);
  if (failures.length) {
    log(`FAILURES (${failures.length}):`);
    for (const f of failures) log(`  ${f}`);
  }
  log(`\naccent: ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
