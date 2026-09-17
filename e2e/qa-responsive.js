// qa-responsive.js — every user-facing route × viewport, the interactive states that
// open over them, and an accessibility pass. Measures the deployed app.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-responsive.js --label baseline
//   node qa-responsive.js --label after --assert-touch        (also gate touch fixes)
//   node qa-responsive.js --part routes|states|a11y|motion|all --engines chromium,webkit
//
// ROUTES × VIEWPORTS (portrait 320/375/412/768/1024/1280/1440/1920/2560 and landscape
// 667/844/915/1024/1366), Chromium; WebKit (Playwright WebKit, NOT iOS) on the touch
// viewports. Acceptance, per page:
//   no horizontal overflow · nothing rendered outside the viewport unless clipped by a
//   scroll container · visible controls not covered by other elements · fixed/sticky
//   elements do not overlap · app-shell routes do not scroll the page · the composer is
//   visible and not covered (also with the viewport shrunk as a keyboard would) · no
//   console errors.
// Reported (gated with --assert-touch): touch targets < 44 px, controls that are
// invisible on touch (hover-only), backdrop-filter on touch.
// STATES: drawer, menus, popovers, dialogs — inside the viewport, scrollable when tall,
// focus trapped, Escape closes, focus returns.
// A11Y: axe-core (pinned, injected from cdnjs at test time — not a dependency) on every
// route at 375 and 1280 and in open states; keyboard focus visibility; reduced motion;
// 200 % text at 320 px.
//
// Output: e2e/out/responsive/<label>.json + a summary. One login per context group
// (the QA account allows a single session — never run alongside another harness).
const { chromium, webkit } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const LABEL = arg("label", "run");
const PART = arg("part", "all");
const ENGINES = arg("engines", "chromium,webkit").split(",");
const ASSERT_TOUCH = process.argv.includes("--assert-touch");
const AXE_URL = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js";
const OUT = path.join(__dirname, "out", "responsive");
fs.mkdirSync(OUT, { recursive: true });
const PERF_STATE = path.join(__dirname, "out", "mobile-perf", "state.json");

const PORTRAIT = [
  ["320", 320, 640, true], ["375", 375, 667, true], ["412", 412, 915, true],
  ["768", 768, 1024, true], ["1024", 1024, 1366, true],
  ["1280", 1280, 800, false], ["1440", 1440, 900, false], ["1920", 1920, 1080, false], ["2560", 2560, 1440, false],
];
const LANDSCAPE = [["667L", 667, 375, true], ["844L", 844, 390, true], ["915L", 915, 412, true], ["1024L", 1024, 768, true], ["1366L", 1366, 1024, true]];
const VIEWPORTS = [...PORTRAIT, ...LANDSCAPE].map(([n, w, h, touch]) => ({ n, w, h, touch }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const errs = [];
const failures = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);

async function newGroup(type, touch) {
  const browser = await type.launch({ headless: true });
  const context = await browser.newContext({
    viewport: touch ? { width: 375, height: 667 } : { width: 1280, height: 800 },
    isMobile: touch && type !== webkit ? true : touch,
    hasTouch: touch,
    deviceScaleFactor: touch ? 2 : 1,
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(`[${type.name()}${touch ? " touch" : ""}] ${page.url().replace(BASE, "")} ${m.text().slice(0, 180)}`);
  });
  page.on("pageerror", (e) => errs.push(`[${type.name()}] pageerror ${e.message.slice(0, 180)}`));
  return { browser, context, page };
}

async function login(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/login?perf=0`, { waitUntil: "load" });
    await page.waitForTimeout(4000);
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL(/\/chat/, { timeout: 60000, waitUntil: "commit" });
      await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 60000 });
      return;
    } catch {
      log(`  login attempt ${attempt} failed`);
      await sleep(20000);
    }
  }
  throw new Error("login failed");
}

async function discover(page) {
  const state = fs.existsSync(PERF_STATE) ? JSON.parse(fs.readFileSync(PERF_STATE, "utf8")) : {};
  const firstHref = async (url, re) => {
    await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    return page.evaluate((src) => {
      const r = new RegExp(src);
      return [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")).find((h) => r.test(h)) || null;
    }, re.source);
  };
  const withLocale = (h) => (h ? (h.startsWith("/en") ? h : `/en${h}`) : null);
  const project = withLocale(await firstHref("/en/projects", /\/projects\/[a-z0-9]{10,}/));
  const task = withLocale(await firstHref("/en/scheduled", /\/scheduled\/[a-z0-9]{10,}/));
  const connector = withLocale(await firstHref("/en/settings/connectors", /\/settings\/connectors\/[a-z0-9-]+$/));
  const share = await firstHref("/en/settings/shared", /\/share\/[A-Za-z0-9_-]{8,}/);
  let codeThread = state.codeThread;
  if (!codeThread) {
    const c = await firstHref("/en/chat", /\/chat\/[a-z0-9]{20,}/);
    codeThread = c?.split("/").pop();
  }
  const routes = [
    ["/en/chat", "shell"],
    state.longThread && [`/en/chat/${state.longThread}`, "shell"],
    codeThread && [`/en/chat/${codeThread}`, "shell"],
    ["/en/projects", "shell"], project && [project, "shell"],
    ["/en/scheduled", "shell"], task && [task, "shell"],
    ["/en/files", "document"], ["/en", "redirect"],
    ["/en/settings", "shell"], ["/en/settings/archived", "shell"], ["/en/settings/billing", "shell"],
    ["/en/settings/connectors", "shell"], connector && [connector, "shell"],
    ["/en/settings/files", "shell"], ["/en/settings/memories", "shell"], ["/en/settings/personalization", "shell"],
    ["/en/settings/shared", "shell"], ["/en/settings/skills", "shell"],
    ["/en/privacy", "document"], ["/en/terms", "document"], ["/en/support", "document"], ["/en/slack", "document"],
    ["/en/this-route-does-not-exist", "document"],
  ].filter(Boolean);
  return { routes, share, longThread: state.longThread || codeThread, codeThread };
}

// Runs in the page. Returns the audit for the current viewport.
const AUDIT = ({ touch, shell }) => {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const desc = (el) => {
    const label = el.getAttribute?.("aria-label") || (el.textContent || "").trim().slice(0, 24);
    const cls = String(el.className?.baseVal ?? el.className ?? "").split(/\s+/).slice(0, 3).join(".");
    return `${el.tagName.toLowerCase()}${label ? `[${label}]` : ""}.${cls}`.slice(0, 90);
  };
  const style = (el) => getComputedStyle(el);
  const visible = (el) => {
    const s = style(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const effectiveOpacity = (el) => {
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(style(n).opacity);
    return o;
  };
  const clippedByAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(style(p).overflowX)) {
        const r = p.getBoundingClientRect();
        if (r.left >= -1 && r.right <= vw + 1) return true;
      }
    }
    return false;
  };
  const inProbe = (el) => !!el.closest?.("[data-perf-probe]");
  const all = [...document.body.querySelectorAll("*")].filter((el) => !inProbe(el));

  const overflowX = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw;
  const outside = [];
  for (const el of all) {
    if (!visible(el) || style(el).position === "fixed") continue;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 2 || r.left < -2) && !clippedByAncestor(el)) outside.push(`${desc(el)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
  }

  const interactive = all.filter((el) => el.matches("a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=menuitem],[role=tab],[role=switch],[role=checkbox],summary") && visible(el));
  const modalOpen = !!document.querySelector('[role="dialog"],[role="alertdialog"],[aria-modal="true"]');
  const covered = [];
  const small = [];
  const hoverHidden = [];
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    const inView = r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw;
    if (!inView) continue;
    if (touch && Math.min(r.width, r.height) < 44) small.push(`${desc(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    if (touch && effectiveOpacity(el) < 0.05) hoverHidden.push(desc(el));
    if (modalOpen || style(el).pointerEvents === "none" || effectiveOpacity(el) < 0.05) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || inProbe(hit)) continue;
    if (hit === el || el.contains(hit) || hit.contains(el) || hit.closest("label")?.contains(el)) continue;
    // Clipped inside a scroll container at this point is scrolling, not covering.
    let clipped = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (/(auto|scroll|hidden)/.test(style(p).overflowY + style(p).overflowX)) {
        const pr = p.getBoundingClientRect();
        if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) clipped = true;
      }
    }
    if (!clipped) covered.push(`${desc(el)} under ${desc(hit)}`);
  }

  const fixed = all.filter((el) => /^(fixed|sticky)$/.test(style(el).position) && visible(el) && style(el).pointerEvents !== "none" && el.getAttribute("aria-hidden") !== "true");
  const overlaps = [];
  for (let i = 0; i < fixed.length; i++) {
    for (let j = i + 1; j < fixed.length; j++) {
      const a = fixed[i];
      const b = fixed[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const full = (r) => r.width >= vw - 2 && r.height >= vh - 2;
      if (full(ra) || full(rb)) continue; // scrims / full-screen overlays
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 2 && h > 2) overlaps.push(`${desc(a)} x ${desc(b)}`);
    }
  }

  const pageScroll = shell ? document.scrollingElement.scrollHeight - vh : 0;
  const composerEl = document.querySelector("#chat-composer");
  let composer = null;
  if (composerEl) {
    const r = composerEl.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12));
    composer = { inView: r.top >= 0 && r.bottom <= vh + 1 && r.left >= 0 && r.right <= vw + 1, notCovered: !!hit && (hit === composerEl || composerEl.contains(hit) || hit.contains(composerEl)), width: Math.round(r.width) };
  }
  let backdrop = 0;
  let tiny = 0;
  for (const el of all) {
    const s = style(el);
    const bf = s.backdropFilter || s.webkitBackdropFilter;
    if (bf && bf !== "none" && visible(el)) backdrop++;
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && visible(el) && Number.parseFloat(s.fontSize) < 12) tiny++;
  }
  return {
    pointerCoarse: matchMedia("(pointer: coarse)").matches,
    overflowX,
    outside: outside.slice(0, 6), outsideCount: outside.length,
    covered: covered.slice(0, 6), coveredCount: covered.length,
    overlaps: overlaps.slice(0, 4), overlapCount: overlaps.length,
    pageScroll,
    composer,
    smallTargets: small.length, smallEx: small.slice(0, 8),
    hoverHidden: hoverHidden.length, hoverHiddenEx: hoverHidden.slice(0, 6),
    backdropFilterEls: backdrop,
    tinyText: tiny,
  };
};

function judge(where, a, kind) {
  if (a.overflowX > 0) fail(where, `horizontal overflow ${a.overflowX}px`);
  if (a.outsideCount) fail(where, `${a.outsideCount} elements outside viewport: ${a.outside.slice(0, 2).join(" | ")}`);
  if (a.coveredCount) fail(where, `${a.coveredCount} covered controls: ${a.covered.slice(0, 2).join(" | ")}`);
  if (a.overlapCount) fail(where, `${a.overlapCount} fixed/sticky overlaps: ${a.overlaps.slice(0, 2).join(" | ")}`);
  if (kind === "shell" && a.pageScroll > 2) fail(where, `app-shell page scrolls ${a.pageScroll}px`);
  if (a.composer && (!a.composer.inView || !a.composer.notCovered)) fail(where, `composer ${JSON.stringify(a.composer)}`);
  if (ASSERT_TOUCH && a.pointerCoarse) {
    if (a.hoverHidden) fail(where, `${a.hoverHidden} controls invisible on touch: ${a.hoverHiddenEx.slice(0, 3).join(" | ")}`);
    if (a.backdropFilterEls) fail(where, `${a.backdropFilterEls} backdrop-filter elements on touch`);
  }
}

async function settle(page) {
  await page.waitForTimeout(2500);
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
}

// ------------------------------------------------------------------------ routes
async function routesPart(type, touch, page, info, results) {
  const vps = VIEWPORTS.filter((v) => v.touch === touch);
  for (const v of vps) {
    await page.setViewportSize({ width: v.w, height: v.h });
    for (const [route, kind] of info.routes) {
      const where = `${type.name()} ${v.n} ${route.replace(/[a-z0-9]{20,}/, ":id")}`;
      try {
        await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 60000 });
        await settle(page);
        const final = page.url().replace(BASE, "");
        if (final.startsWith("/login")) {
          fail(where, "redirected to /login (session lost)");
          continue;
        }
        const a = await page.evaluate(AUDIT, { touch, shell: kind === "shell" });
        judge(where, a, kind);
        const row = { engine: type.name(), vp: v.n, route: route.replace(/[a-z0-9]{20,}/, ":id"), ...a };
        // Keyboard: shrink the viewport with the composer focused, as a keyboard would.
        if (touch && a.composer && v.h > v.w) {
          await page.locator("#chat-composer").focus();
          await page.setViewportSize({ width: v.w, height: Math.round(v.h * 0.55) });
          await page.waitForTimeout(600);
          const k = await page.evaluate(AUDIT, { touch, shell: false });
          row.keyboard = { composer: k.composer, overflowX: k.overflowX };
          if (k.composer && (!k.composer.inView || !k.composer.notCovered)) fail(`${where} keyboard`, `composer ${JSON.stringify(k.composer)}`);
          await page.setViewportSize({ width: v.w, height: v.h });
          await page.locator("#chat-composer").blur().catch(() => {});
        }
        results.routes.push(row);
      } catch (e) {
        fail(where, `error ${e.message.slice(0, 120)}`);
      }
    }
    log(`  ${type.name()} ${v.n} done (${results.routes.length} rows, ${failures.length} failures so far)`);
  }
}

// ------------------------------------------------------------------------ states
const OVERLAY = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[aria-modal="true"],nav[aria-label="Conversations"].fixed';

async function openState(page, name) {
  const b = page.getByRole("button", { name, exact: true }).first();
  if (!(await b.count())) return null;
  await b.scrollIntoViewIfNeeded().catch(() => {});
  await b.click({ force: true });
  await page.waitForTimeout(900);
  return b;
}

const OVERLAY_AUDIT = (sel) => {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const els = [...document.querySelectorAll(sel)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  });
  const el = els[els.length - 1];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const scrollable = (node) => {
    for (const n of [node, ...node.querySelectorAll("*")]) {
      const s = getComputedStyle(n);
      if (n.scrollHeight > n.clientHeight + 2 && /(auto|scroll)/.test(s.overflowY)) return true;
    }
    return false;
  };
  return {
    role: el.getAttribute("role") || el.tagName.toLowerCase(),
    modal: el.getAttribute("role") === "dialog" || el.getAttribute("role") === "alertdialog" || el.getAttribute("aria-modal") === "true",
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
    insideViewport: r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1,
    tallerThanViewport: el.scrollHeight > vh,
    scrollableWhenTall: el.scrollHeight <= el.clientHeight + 2 || scrollable(el),
  };
};

async function statesPart(type, touch, page, info, results) {
  const vps = touch ? [["375", 375, 667], ["844L", 844, 390]] : [["1280", 1280, 800]];
  const plan = [
    ["/en/chat", ["Skills", "Notifications", "Ambience", touch ? "Open conversations" : null]],
    ["/en/chat", touch ? ["Open conversations>Account menu", "Open conversations>Conversation actions"] : ["Account menu", "Conversation actions"]],
    [info.longThread && `/en/chat/${info.longThread}`, ["Share conversation", "Instructions for this chat", "Share response", "Move chat to a project"]],
    ["/en/projects", ["New project"]],
    [info.routes.find(([r]) => /\/projects\/[a-z0-9]{10,}/.test(r))?.[0], ["Project settings", "Project actions"]],
    ["/en/scheduled", ["Schedule a task", "Task actions"]],
    ["/en/files", ["Open menu"]],
    ["/en/settings", ["Open settings menu"]],
    ["/en/settings/connectors", ["Filter by category"]],
  ];
  for (const [vn, w, h] of vps) {
    await page.setViewportSize({ width: w, height: h });
    for (const [route, triggers] of plan) {
      if (!route) continue;
      for (const trigger of triggers.filter(Boolean)) {
        const where = `${type.name()} ${vn} ${route.replace(/[a-z0-9]{20,}/, ":id")} [${trigger}]`;
        try {
          await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
          await settle(page);
          const chain = trigger.split(">");
          let btn = null;
          for (const t of chain) btn = await openState(page, t);
          if (!btn) {
            results.states.push({ where, skipped: "trigger not present" });
            continue;
          }
          const o = await page.evaluate(OVERLAY_AUDIT, OVERLAY);
          if (!o) {
            results.states.push({ where, note: "no overlay element found after click" });
            continue;
          }
          const row = { where, ...o };
          if (!o.insideViewport) fail(where, `overlay outside viewport ${JSON.stringify(o.rect)}`);
          if (o.tallerThanViewport && !o.scrollableWhenTall) fail(where, "overlay taller than viewport and not scrollable");
          if (o.modal) {
            for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
            row.focusTrapped = await page.evaluate((sel) => {
              const els = [...document.querySelectorAll(sel)];
              const el = els[els.length - 1];
              return !!el && el.contains(document.activeElement);
            }, OVERLAY);
            if (!row.focusTrapped) fail(where, "focus escaped the dialog after Tab ×12");
          }
          if (process.env.AXE !== "0") row.axe = await axe(page, OVERLAY);
          await page.keyboard.press("Escape");
          await page.waitForTimeout(700);
          row.closedByEscape = !(await page.evaluate(OVERLAY_AUDIT, OVERLAY));
          if (o.modal && !row.closedByEscape) fail(where, "Escape did not close the dialog");
          if (o.modal) {
            row.focusReturned = await btn.evaluate((b) => b === document.activeElement || b.contains(document.activeElement)).catch(() => false);
          }
          results.states.push(row);
        } catch (e) {
          fail(where, `error ${e.message.slice(0, 120)}`);
        }
      }
    }
  }
}

// -------------------------------------------------------------------------- a11y
async function axe(page, include) {
  const has = await page.evaluate(() => typeof window.axe !== "undefined");
  if (!has) await page.addScriptTag({ url: AXE_URL });
  return page.evaluate(async (inc) => {
    const ctx = inc && document.querySelector(inc) ? { include: [[inc]] } : document;
    const r = await window.axe.run(ctx, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"], resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ").slice(0, 160) }));
  }, include || null);
}

async function a11yPart(type, touch, page, info, results) {
  const [w, h] = touch ? [375, 667] : [1280, 800];
  await page.setViewportSize({ width: w, height: h });
  for (const [route] of info.routes) {
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
      await settle(page);
      results.axe.push({ engine: type.name(), vp: w, route: route.replace(/[a-z0-9]{20,}/, ":id"), violations: await axe(page) });
    } catch (e) {
      fail(`axe ${w} ${route}`, e.message.slice(0, 100));
    }
  }
  if (!touch) {
    // Keyboard: Tab through the chat surface; every focused control must show focus.
    for (const route of ["/en/chat", info.longThread && `/en/chat/${info.longThread}`, "/en/settings"].filter(Boolean)) {
      await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
      await settle(page);
      await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
      const noFocus = [];
      const invisibleFocus = [];
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press("Tab");
        const f = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          let o = 1;
          for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
          const ring = (s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== "none");
          const label = el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 24) || el.tagName;
          return { label, ring, visible: r.width > 0 && r.height > 0 && o > 0.05 };
        });
        if (!f) continue;
        if (!f.visible) invisibleFocus.push(f.label);
        else if (!f.ring) noFocus.push(f.label);
      }
      results.keyboard.push({ route: route.replace(/[a-z0-9]{20,}/, ":id"), noVisibleFocus: [...new Set(noFocus)], focusOnInvisible: [...new Set(invisibleFocus)] });
    }
  }
}

// ------------------------------------------------------------------------ motion
async function motionPart(type, touch, results, info) {
  // Reduced motion + 200 % text, in their own contexts (both are context options / page state).
  const browser = await type.launch({ headless: true });
  const context = await browser.newContext({ viewport: touch ? { width: 320, height: 640 } : { width: 1280, height: 800 }, isMobile: touch, hasTouch: touch, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    window.__glDraws = 0;
    for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!C) continue;
      for (const fn of ["drawElements", "drawArrays"]) {
        const orig = C.prototype[fn];
        C.prototype[fn] = function (...a) {
          window.__glDraws++;
          return orig.apply(this, a);
        };
      }
    }
  });
  const page = await context.newPage();
  await login(page);
  for (const route of ["/en/chat", info.longThread && `/en/chat/${info.longThread}`].filter(Boolean)) {
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.waitForTimeout(3000);
    const g0 = await page.evaluate(() => window.__glDraws);
    await page.waitForTimeout(5000);
    const r = await page.evaluate((g) => ({
      runningInfiniteAnimations: document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getTiming?.().iterations === Number.POSITIVE_INFINITY).length,
      webglDrawsPerSec: (window.__glDraws - g) / 5,
    }), g0);
    results.reducedMotion.push({ engine: type.name(), touch, route: route.replace(/[a-z0-9]{20,}/, ":id"), ...r });
    if (r.runningInfiniteAnimations > 0) fail(`reduced-motion ${route}`, `${r.runningInfiniteAnimations} infinite animations still running`);
  }
  if (touch) {
    for (const [route, kind] of info.routes.filter(([r]) => /\/en\/chat|\/en\/settings$|\/en\/projects$/.test(r))) {
      await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
      await settle(page);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
      });
      await page.waitForTimeout(800);
      const a = await page.evaluate(AUDIT, { touch: true, shell: kind === "shell" });
      results.textScale.push({ route: route.replace(/[a-z0-9]{20,}/, ":id"), overflowX: a.overflowX, outsideCount: a.outsideCount, composer: a.composer, coveredCount: a.coveredCount });
      if (a.overflowX > 0) fail(`text200% 320 ${route}`, `horizontal overflow ${a.overflowX}px`);
      if (a.composer && !a.composer.notCovered) fail(`text200% 320 ${route}`, "composer covered");
    }
  }
  await browser.close();
}

(async () => {
  if (!EMAIL || !PASSWORD) throw new Error("QA_EMAIL and QA_PASSWORD must be set");
  const results = { routes: [], states: [], axe: [], keyboard: [], reducedMotion: [], textScale: [], shareAnon: null };
  let info = null;
  for (const engine of ENGINES) {
    const type = engine === "webkit" ? webkit : chromium;
    for (const touch of engine === "webkit" ? [true] : [true, false]) {
      const { browser, page } = await newGroup(type, touch);
      await login(page);
      if (!info) {
        info = await discover(page);
        log(`routes (${info.routes.length}): ${info.routes.map(([r]) => r.replace(/[a-z0-9]{20,}/, ":id")).join(" ")}`);
      }
      log(`\n== ${engine} ${touch ? "touch" : "desktop"}`);
      if (PART === "all" || PART === "routes") await routesPart(type, touch, page, info, results);
      if (PART === "all" || PART === "states") await statesPart(type, touch, page, info, results);
      if ((PART === "all" || PART === "a11y") && engine === "chromium") await a11yPart(type, touch, page, info, results);
      await browser.close();
      if ((PART === "all" || PART === "motion") && engine === "chromium") await motionPart(type, touch, results, info);
    }
  }
  // Logged-out pages: login and a public share link.
  for (const touch of [true, false]) {
    const { browser, page } = await newGroup(chromium, touch);
    for (const [route, w, h] of [["/login", 375, 667], ["/login", 1280, 800], info?.share && [info.share, 375, 667], info?.share && [info.share, 1280, 800]].filter(Boolean)) {
      if ((w < 1000) !== touch) continue;
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
      await settle(page);
      const a = await page.evaluate(AUDIT, { touch, shell: false });
      judge(`anon ${w} ${route.replace(/\/share\/.+/, "/share/:token")}`, a, "document");
      results.routes.push({ engine: "chromium", vp: String(w), route: route.replace(/\/share\/.+/, "/share/:token"), anon: true, ...a });
      if (PART === "all" || PART === "a11y") results.axe.push({ engine: "chromium", vp: w, route: route.replace(/\/share\/.+/, "/share/:token"), anon: true, violations: await axe(page) });
    }
    await browser.close();
  }

  const benign = errs.filter((e) => !/favicon|third-party cookie/i.test(e));
  for (const e of benign) fail("console", e);
  // Summaries.
  const axeAgg = {};
  for (const r of results.axe) {
    for (const v of r.violations) {
      const k = `${v.impact}:${v.id}`;
      axeAgg[k] ||= { impact: v.impact, id: v.id, pages: 0, nodes: 0, sample: v.sample, routes: [] };
      axeAgg[k].pages++;
      axeAgg[k].nodes += v.nodes;
      if (axeAgg[k].routes.length < 6) axeAgg[k].routes.push(`${r.vp} ${r.route}`);
    }
  }
  const touchRows = results.routes.filter((r) => r.pointerCoarse);
  const summary = {
    rows: results.routes.length,
    failures: failures.length,
    touch: {
      rows: touchRows.length,
      smallTargetsTotal: touchRows.reduce((a, r) => a + r.smallTargets, 0),
      hoverHiddenTotal: touchRows.reduce((a, r) => a + r.hoverHidden, 0),
      backdropFilterRows: touchRows.filter((r) => r.backdropFilterEls > 0).length,
    },
    axe: Object.values(axeAgg).sort((a, b) => ["critical", "serious", "moderate", "minor"].indexOf(a.impact) - ["critical", "serious", "moderate", "minor"].indexOf(b.impact)),
  };
  const file = path.join(OUT, `${LABEL}.json`);
  fs.writeFileSync(file, JSON.stringify({ base: BASE, label: LABEL, at: new Date().toISOString(), summary, failures, results }, null, 2));
  log(`\nrows ${summary.rows} · failures ${failures.length} · touch small targets ${summary.touch.smallTargetsTotal} · hover-hidden ${summary.touch.hoverHiddenTotal} · backdrop rows ${summary.touch.backdropFilterRows}`);
  for (const f of failures.slice(0, 40)) log(`  FAIL ${f}`);
  log("axe:");
  for (const a of summary.axe) log(`  ${a.impact.padEnd(8)} ${a.id.padEnd(28)} pages=${a.pages} nodes=${a.nodes}  e.g. ${a.routes[0]}`);
  log(`wrote ${file}`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e.stack);
  process.exit(2);
});
