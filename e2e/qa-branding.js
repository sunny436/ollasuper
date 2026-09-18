// qa-branding.js — the OllaSuper branding system, asserted in a real browser.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-branding.js
//   node qa-branding.js --headless
//
// The static half lives in apps/app/src/components/branding/branding.test.ts,
// which reads the source. It cannot see the three things that actually break:
//
//   1. COMPUTED colour. `currentColor` is only correct if an ancestor supplies
//      the right ink. Only the browser knows what it resolved to.
//   2. The RESPONSIVE SWAP, which is a CSS media query — invisible to a source
//      scan, and wrong in a way nothing else would notice.
//   3. Whether the wordmark font actually LOADED. A missing @font-face falls back
//      silently and the brand quietly renders in the UI face instead.
const { chromium } = require("playwright");
const { account } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const HEADLESS = process.argv.includes("--headless");

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

/** What the brand lockup resolves to right now, in this viewport. */
function readBrand(page) {
  return page.evaluate(() => {
    const text = [...document.querySelectorAll("span")].find(
      (s) => s.textContent?.trim() === "OllaSuper" && s.children.length === 0,
    );
    const svg =
      text?.parentElement?.querySelector("svg") ??
      document.querySelector("span > svg");
    const vis = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        // sr-only collapses to a clipped 1px box: hidden, but still announced.
        srOnly: r.width <= 1 && r.height <= 1 && cs.position === "absolute",
        display: cs.display,
        color: cs.color,
        font: cs.fontFamily,
        weight: cs.fontWeight,
      };
    };
    return {
      hasText: !!text,
      text: vis(text),
      mark: vis(svg),
      markTag: svg ? svg.tagName.toLowerCase() : null,
      markFill: svg ? getComputedStyle(svg).fill : null,
      rasterBrand: [...document.querySelectorAll("img")]
        .map((i) => i.getAttribute("src") || "")
        .filter((s) => /logo|brand/i.test(s)),
    };
  });
}

async function signIn(page, who) {
  await page.goto(`${BASE}/login`, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  await page.locator('input[type="email"]').first().fill(who.email);
  await page.locator('input[type="password"]').first().fill(who.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 90000, waitUntil: "commit" });
  await page.waitForSelector("#chat-composer", { timeout: 60000 });
}

async function setTheme(page, mode) {
  await page.evaluate(
    ([m, ts]) => {
      try {
        localStorage.setItem("theme", m);
        localStorage.setItem("theme_ts", String(ts));
      } catch {}
    },
    [mode, Date.now()],
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
}

async function main() {
  const who = account();
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errs = [];
  const rasterRequests = [];
  page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 150)));
  page.on("pageerror", (e) => errs.push(`pageerror ${e.message.slice(0, 150)}`));
  page.on("request", (r) => {
    const u = r.url();
    // /apple-icon is a GENERATED png and legitimate; a raster brand FILE is not.
    if (/logo|brand/i.test(u) && /\.(png|jpg|jpeg|webp|gif|ico)(\?|$)/i.test(u)) {
      rasterRequests.push(u);
    }
  });

  // ------------------------------------------------------------------ AUTH
  for (const mode of ["light", "dark"]) {
    await page.goto(`${BASE}/login`, { waitUntil: "load" });
    await setTheme(page, mode);
    const r = await readBrand(page);
    const want = mode === "dark" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)";
    check(
      `auth ${mode}: wordmark is DOM text, mark is an inline <svg>`,
      r.hasText && r.markTag === "svg",
      `text=${r.hasText} tag=${r.markTag}`,
    );
    check(
      `auth ${mode}: both halves visible`,
      (r.text?.w ?? 0) > 40 && (r.mark?.w ?? 0) > 20,
      `text ${r.text?.w}px, mark ${r.mark?.w}px`,
    );
    check(
      `auth ${mode}: brand resolves to ${want}`,
      r.text?.color === want && r.markFill === want,
      `text ${r.text?.color}, mark ${r.markFill}`,
    );
    check(`auth ${mode}: wordmark renders in Poppins`, /Poppins/i.test(r.text?.font || ""), r.text?.font);
    check(`auth ${mode}: weight 800`, String(r.text?.weight) === "800", r.text?.weight);
  }

  // ------------------------------------------------------------------- APP
  await signIn(page, who);

  for (const mode of ["light", "dark"]) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setTheme(page, mode);
    const d = await readBrand(page);
    const want = mode === "dark" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)";
    check(
      `app desktop ${mode}: wordmark visible, mark hidden`,
      (d.text?.w ?? 0) > 40 && d.mark?.display === "none",
      `text ${d.text?.w}px, mark display=${d.mark?.display}`,
    );
    check(`app desktop ${mode}: brand resolves to ${want}`, d.text?.color === want, d.text?.color);
  }

  // ------------------------------------------- the 767 / 768 boundary
  for (const [w, markExpected] of [
    [767, true],
    [768, false],
  ]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    if (w < 768) {
      await page
        .getByRole("button", { name: "Open conversations" })
        .first()
        .click()
        .catch(() => {});
      await page.waitForTimeout(700);
    }
    const b = await readBrand(page);
    const markShown = b.mark?.display !== "none";
    const wordShown = b.hasText && b.text?.srOnly === false;
    check(
      `${w}px: ${markExpected ? "mark only" : "wordmark only"}`,
      markShown === markExpected && wordShown === !markExpected,
      `mark=${markShown} wordmark=${wordShown}`,
    );
    check(
      `${w}px: the wordmark stays in the a11y tree either way`,
      b.hasText === true,
      `present=${b.hasText}`,
    );
  }

  check("no raster brand asset requested", rasterRequests.length === 0, rasterRequests.slice(0, 3).join(" | "));
  check("zero console errors", errs.length === 0, errs.slice(0, 3).join(" | "));

  await ctx.close();
  await browser.close();
  log(`\n${"=".repeat(62)}`);
  if (failures.length) {
    log(`FAILURES (${failures.length}):`);
    for (const f of failures) log(`  ${f}`);
  }
  log(`\nbranding: ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
