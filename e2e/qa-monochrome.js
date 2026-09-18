// qa-monochrome.js — the runtime half of the monochrome anti-regression net.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-monochrome.js
//   node qa-monochrome.js --headless --label after
//
// The source-level half lives in apps/app/src/lib/theme/monochrome.test.ts, which
// reads globals.css and greps the components. It cannot see three things, and
// those three are exactly what has regressed before:
//
//   1. COMPUTED colour. `bg-brand/10` is a class the grep allows; what it paints
//      is whatever --brand happens to be. Only the browser knows.
//   2. PSEUDO-ELEMENTS. A gradient on ::before is invisible to a className scan.
//   3. THIRD-PARTY CSS. Anything a library injects at runtime.
//
// So this walks every route in BOTH themes with a real browser and asserts:
//   · zero background-image containing "gradient" (element, ::before, ::after)
//   · zero backdrop-filter / -webkit-backdrop-filter (element and pseudos)
//   · zero <canvas> outside a chart (the WebGL brand orb must not come back)
//   · every painted colour in the chrome is achromatic (r≈g≈b) or one of the
//     three agreed status hues — CONTENT containers excluded, see CONTENT below
//   · no box-shadow blurrier than the one overlay elevation
//   · the theme actually applied before paint, in both directions
//   · zero console errors
//
// Screenshots land in e2e/out/monochrome/<label>/<mode>/ for the by-eye pass —
// an assertion cannot tell you a page looks cheap, only that it is grey.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const { account } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const LABEL = arg("label", "run");
const HEADLESS = process.argv.includes("--headless");
const OUT = path.join(__dirname, "out", "monochrome", LABEL);

const failures = [];
const consoleErrors = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- page audit
//
// Serialized into the page. Keep it dependency-free.
const AUDIT = ({ statusRgb }) => {
  // Containers whose colour is CONTENT, not chrome, and is deliberately kept:
  // syntax highlighting, chart canvases, mermaid diagrams, KaTeX, images, and
  // the third-party identity marks (Google/Microsoft trademarks — see the note
  // in components/auth/oauth-row.tsx).
  const CONTENT =
    "pre, code, canvas, .mermaid, .katex, img, video, svg[data-brand-logo], [data-content-colour]";

  const out = {
    gradients: [],
    glass: [],
    canvases: [],
    hues: [],
    shadows: [],
    total: 0,
  };
  const seen = new Set();

  const desc = (el) => {
    const label = el.getAttribute?.("aria-label") || "";
    const cls = String(el.className?.baseVal ?? el.className ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .join(".");
    const txt = (el.textContent || "").trim().slice(0, 20);
    return `${el.tagName.toLowerCase()}${label ? `[${label}]` : ""}${cls ? `.${cls}` : ""}${
      txt ? ` "${txt}"` : ""
    }`.slice(0, 110);
  };

  /** rgb()/rgba() -> [r,g,b,a], or null for anything that paints nothing. */
  const parse = (v) => {
    if (!v || v === "none" || v === "transparent") return null;
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,/]/).map((s) => Number.parseFloat(s.trim()));
    const a = p.length > 3 ? p[3] : 1;
    if (!(a > 0.02)) return null; // fully/near transparent paints nothing
    return [p[0], p[1], p[2], a];
  };

  const achromatic = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) <= 4;
  const isStatus = (c) =>
    statusRgb.some(
      (s) => Math.abs(s[0] - c[0]) <= 6 && Math.abs(s[1] - c[1]) <= 6 && Math.abs(s[2] - c[2]) <= 6,
    );

  const noteHue = (el, prop, value, c) => {
    const key = `${desc(el)}|${prop}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.hues.push(`${desc(el)} ${prop}: ${value}`);
  };

  const COLOUR_PROPS = [
    "color",
    "backgroundColor",
    "borderTopColor",
    "borderRightColor",
    "borderBottomColor",
    "borderLeftColor",
    "outlineColor",
    "fill",
    "stroke",
    "caretColor",
    "textDecorationColor",
  ];

  for (const el of document.querySelectorAll("*")) {
    if (el.closest("script, style, head")) continue;
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    out.total++;

    const content = el.closest(CONTENT) !== null;

    for (const pseudo of [null, "::before", "::after"]) {
      const s = pseudo ? getComputedStyle(el, pseudo) : cs;
      if (pseudo && s.content === "none") continue;

      if (s.backgroundImage && s.backgroundImage.includes("gradient")) {
        out.gradients.push(`${desc(el)}${pseudo || ""}: ${s.backgroundImage.slice(0, 80)}`);
      }
      const bf = s.backdropFilter || s.webkitBackdropFilter;
      if (bf && bf !== "none") out.glass.push(`${desc(el)}${pseudo || ""}: ${bf.slice(0, 50)}`);

      if (!content) {
        for (const prop of COLOUR_PROPS) {
          // A zero-width border still reports a colour; it paints nothing.
          if (prop.startsWith("border")) {
            const w = s[prop.replace("Color", "Width")];
            if (!w || Number.parseFloat(w) === 0) continue;
            if (s[prop.replace("Color", "Style")] === "none") continue;
          }
          const c = parse(s[prop]);
          if (!c) continue;
          // An element with no text paints no colour; skip `color` for those so a
          // decorative wrapper's inherited ink is not reported on every node.
          if (prop === "color" && !el.textContent?.trim()) continue;
          if (achromatic(c) || isStatus(c)) continue;
          noteHue(el, `${prop}${pseudo || ""}`, s[prop], c);
        }
      }
    }

    // The WebGL brand orb was a <canvas>. Chart.js is also a <canvas>, and that
    // one is wanted — it is inside the chart block, which carries the marker.
    if (el.tagName === "CANVAS" && !el.closest("[data-chart], .chart-block")) {
      out.canvases.push(`${desc(el)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    }

    // §10: ONE subtle elevation. Anything blurrier than ~16px is the old
    // shadow-xl/2xl look and reads as a drop shadow rather than separation.
    if (cs.boxShadow && cs.boxShadow !== "none") {
      const nums = cs.boxShadow.match(/-?[\d.]+px/g) || [];
      const blur = nums.length >= 3 ? Number.parseFloat(nums[2]) : 0;
      if (blur > 16) out.shadows.push(`${desc(el)}: ${cs.boxShadow.slice(0, 70)}`);
    }
  }

  return {
    ...out,
    dark: document.documentElement.classList.contains("dark"),
    themeAttr: document.documentElement.dataset.theme || null,
    bg: getComputedStyle(document.body).backgroundColor,
  };
};

// The three agreed status hues, both modes, as rgb — the only colour the chrome
// is allowed to paint. Kept in sync with monochrome.test.ts by hand on purpose:
// two independent statements of the same rule catch a one-sided edit.
const STATUS_RGB = [
  [220, 38, 38], // #DC2626 destructive, light
  [248, 113, 113], // #F87171 destructive, dark
  [180, 83, 9], // #B45309 warning, light
  [251, 191, 36], // #FBBF24 warning, dark
  [21, 128, 61], // #15803D success, light
  [74, 222, 128], // #4ADE80 success, dark
];

/**
 * Force a theme through the SAME cache the pre-paint script reads, with a fresh
 * timestamp so the account row loses last-write-wins instead of flipping the
 * page mid-audit, then reload so the choice is applied BEFORE first paint.
 *
 * Deliberately NOT context.addInitScript: init scripts cannot be unregistered
 * and they accumulate, so registering one per mode means every later navigation
 * runs all of them in order and the last mode registered always wins. That bug
 * made a whole "light" pass silently render dark, and every assertion in it
 * still passed — which is the worst kind of green.
 */
/**
 * Force the NEUTRAL accent alongside the mode.
 *
 * Accent colour re-points --brand, so under any other accent this suite would
 * (correctly) report the accent on every primary button. Pinning Neutral is what
 * keeps the original guarantee provable on a real page: with Neutral selected the
 * chrome must still be pure greyscale, exactly as it was before accent shipped.
 * e2e/qa-accent.js covers the six coloured accents.
 */
async function setMode(page, mode) {
  await page.evaluate(
    ([m, ts]) => {
      try {
        localStorage.setItem("theme", m);
        localStorage.setItem("theme_ts", String(ts));
        localStorage.setItem("accent", "neutral");
        localStorage.setItem("accent_ts", String(ts));
      } catch {}
    },
    [mode, Date.now()],
  );
  await page.reload({ waitUntil: "domcontentloaded" });
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

async function firstHref(page, route, re) {
  await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const hrefs = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")));
  return hrefs.find((h) => re.test(h || "")) || null;
}

async function main() {
  const who = account();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: HEADLESS });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`${page.url().replace(BASE, "")} ${m.text().slice(0, 160)}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror ${e.message.slice(0, 160)}`));

  // ---- the login route, signed OUT. It is the one page every user sees first
  // and it carried 21 hardcoded hex colours before this work.
  for (const mode of ["light", "dark"]) {
    await page.goto(`${BASE}/login`, { waitUntil: "load" });
    await setMode(page, mode);
    await page.waitForTimeout(2500);
    await auditRoute(page, "/login", mode);
  }

  await signIn(page, who);
  const thread = await firstHref(page, "/en/chat", /\/chat\/[a-z0-9]{20,}/);
  const project = await firstHref(page, "/en/projects", /\/projects\/[a-z0-9]{20,}/);
  const task = await firstHref(page, "/en/scheduled", /\/scheduled\/[a-z0-9]{20,}/);

  const routes = [
    "/en/chat",
    thread,
    "/en/projects",
    project,
    "/en/scheduled",
    task,
    "/en/files",
    "/en/settings",
    "/en/settings/archived",
    "/en/settings/billing",
    "/en/settings/connectors",
    "/en/settings/files",
    "/en/settings/memories",
    "/en/settings/personalization",
    "/en/settings/shared",
    "/en/settings/skills",
    "/en/privacy",
    "/en/terms",
  ].filter(Boolean);

  for (const mode of ["light", "dark"]) {
    log(`\n=== ${mode.toUpperCase()} ===`);
    for (const route of routes) {
      await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
      // Re-asserted per route, not once per mode. ThemeSync can adopt the
      // account row on any navigation, and the point of this harness is to
      // audit what the chosen mode renders, not to race the sync.
      await setMode(page, mode);
      await page.waitForTimeout(3000);
      await auditRoute(page, route, mode);
    }
  }

  await context.close();
  await browser.close();
  report();
}

async function auditRoute(page, route, mode) {
  const r = await page.evaluate(AUDIT, { statusRgb: STATUS_RGB });
  const where = `${mode} ${route}`;

  if (r.dark !== (mode === "dark")) {
    fail(where, `theme did not apply: html.dark=${r.dark}, data-theme=${r.themeAttr}`);
  }
  if (r.gradients.length) fail(where, `${r.gradients.length} gradient(s): ${r.gradients.slice(0, 3).join(" | ")}`);
  if (r.glass.length) fail(where, `${r.glass.length} backdrop-filter: ${r.glass.slice(0, 3).join(" | ")}`);
  if (r.canvases.length) fail(where, `${r.canvases.length} non-chart canvas: ${r.canvases.slice(0, 3).join(" | ")}`);
  if (r.hues.length) fail(where, `${r.hues.length} off-palette colour(s): ${r.hues.slice(0, 5).join(" | ")}`);
  if (r.shadows.length) fail(where, `${r.shadows.length} heavy shadow(s): ${r.shadows.slice(0, 3).join(" | ")}`);

  const dir = path.join(OUT, mode);
  fs.mkdirSync(dir, { recursive: true });
  const name = route.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "") || "root";
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: false });

  const ok = !r.gradients.length && !r.glass.length && !r.canvases.length && !r.hues.length && !r.shadows.length;
  log(
    `${ok ? "PASS" : "FAIL"}  ${where}  (${r.total} elements, bg ${r.bg})` +
      (ok ? "" : `\n      ${[...r.gradients, ...r.glass, ...r.canvases, ...r.hues, ...r.shadows].slice(0, 6).join("\n      ")}`),
  );
  await sleep(150);
}

function report() {
  log(`\n${"=".repeat(70)}`);
  if (consoleErrors.length) {
    log(`CONSOLE ERRORS (${consoleErrors.length}):`);
    for (const e of consoleErrors.slice(0, 20)) log(`  ${e}`);
  }
  if (failures.length) {
    log(`\nFAILURES (${failures.length}):`);
    for (const f of failures) log(`  ${f}`);
  }
  const pass = failures.length === 0 && consoleErrors.length === 0;
  log(`\nmonochrome: ${pass ? "PASS" : "FAIL"} — screenshots in ${OUT}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
