// qa-content-width.js — the content beside the sidebar is 70% of it, measured on
// the deployed app in a real browser. Headed by default.
//
//   node run-as.js <qa.json> qa-content-width.js
//   HEADLESS=1 …          CI-style
//   THREAD_ID=<id> …      measure an existing thread: nothing generated or deleted
//   PHASES=webkit …       one pass only (desktop | webkit; desktop includes the phone)
//
// THE RULE, per column, ±0.5px:
//     width == min(available, max(floor, 0.70 × container))
// container = content width of the nearest query container (what cqw measures);
// available = content width of the column's own parent (what w-full fills).
// Floors: 768 thread / projects / a project / scheduled / settings, 928 the empty
// chat, 1024 Library — each the width that surface had before.
//
// Matrix: new chat, a thread, Projects, a project, Scheduled (also with a task's
// 420px detail panel open), Library, Settings Profile + Appearance × 1920 … 768 ×
// rail open and collapsed (Settings has no rail), then a 390x844 touch phone.
// Every cell also: no document overflow, and pane overflow no worse than with the
// OLD caps put back on the same page (measured live, never assumed).
//
// A real thread (generated here, deleted at the end): the composer box spans the
// transcript's text exactly from a 50rem pane (the mirrored gutter) and is off by
// no more than one scrollbar below it (as before); the transcript keeps its width
// while its scrollbar appears mid-stream; content wider than any column (a bare
// URL, a 400-char code line, an 18-column table, display math) widens nothing,
// escapes nothing and scrolls inside its own box; the rail toggle drops ≤ 4
// frames over 33ms with the long answer on screen (old caps measured alongside).
// Containers must not capture position:fixed — the inline (unportalled) dialog
// backdrop still covers the viewport, in Chromium AND WebKit. The search dialog
// keeps max-w-xl. Zero console errors. Output: e2e/out/content-width/.
const fs = require("node:fs");
const path = require("node:path");
const { chromium, webkit } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const HEADLESS = process.env.HEADLESS === "1";
const PHASES = (process.env.PHASES || "desktop,webkit").split(","); // desktop includes the phone
const OUT = path.join(__dirname, "out", "content-width");
const DESKTOP = [1920, 1600, 1440, 1366, 1280, 1100, 1024, 900, 768];
const heightFor = (w) => (w >= 1920 ? 1080 : w >= 1366 ? 900 : 800);
const GUTTER_FROM = 800; // 50rem: the transcript mirrors its scrollbar gutter from here
const FRAME_BUDGET = 4; // frames over 33ms per rail toggle
const PROMPT =
  "Write a detailed explainer of about 1,000 words on how the printing press changed Europe: " +
  "at least nine paragraphs under a few short headings, plain prose, no tables and no lists.";

let fails = 0;
let passes = 0;
function check(name, ok, detail = "") {
  if (ok) passes++;
  else fails++;
  if (!ok || process.env.VERBOSE === "1") {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const say = (s) => console.log(s);

// ---- in-page measurement library (installed on every document) --------------
function pageLib() {
  const px = (v) => Number.parseFloat(v) || 0;
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  // Content-box width: border-box minus borders, padding and scrollbar gutters.
  // Computed `width`, not getBoundingClientRect: layout animations write
  // transforms, and a transform must never be mistaken for a width.
  function contentBox(el) {
    const s = getComputedStyle(el);
    const bl = px(s.borderLeftWidth);
    const br = px(s.borderRightWidth);
    const gutters = Math.max(0, el.offsetWidth - el.clientWidth - bl - br);
    return px(s.width) - bl - br - px(s.paddingLeft) - px(s.paddingRight) - gutters;
  }
  function containerOf(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const t = getComputedStyle(p).containerType;
      if (t === "inline-size" || t === "size") return p;
    }
    return null;
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  function columns(kind) {
    const first = (s) => [...document.querySelectorAll(s)].find(visible) ?? null;
    if (kind === "newchat" || kind === "thread") {
      const shell = document.querySelector("[data-composer-shell]");
      const ccol = shell?.closest(".pointer-events-auto.mx-auto") ?? null;
      if (kind === "newchat") return { col: ccol, shell };
      const scroller = document.querySelector('[role="region"][aria-label="Conversation"]');
      const box = shell
        ? [...shell.children].find((e) => e.classList.contains("bg-card") && e.classList.contains("border"))
        : null;
      return { col: scroller?.firstElementChild ?? null, scroller, shell, ccol, box };
    }
    if (kind === "library") return { col: first('[class*="max-w-[max(64rem,70cqw)]"]') };
    if (kind === "settings") return { col: first("main .max-w-content") };
    return { col: first(".max-w-content") };
  }
  function railState() {
    const nav = document.querySelector('nav[aria-label="Conversations"]');
    if (!nav) return "none";
    return nav.getBoundingClientRect().width > 200 ? "open" : "collapsed";
  }
  function noTransforms(el) {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).transform !== "none") return false;
    }
    return true;
  }
  function expect(col, floor) {
    const container = containerOf(col);
    const pane = container ? contentBox(container) : null;
    const avail = contentBox(col.parentElement);
    const width = px(getComputedStyle(col).width);
    const expected = pane == null ? null : Math.min(avail, Math.max(floor, 0.7 * pane));
    return { container, pane, avail, width, expected };
  }
  function align(c) {
    const t = c.col.getBoundingClientRect();
    const ts = getComputedStyle(c.col);
    const text = { l: t.left + px(ts.paddingLeft), r: t.right - px(ts.paddingRight) };
    const b = c.box.getBoundingClientRect();
    return {
      dLeft: r1(b.left - text.l),
      dRight: r1(b.right - text.r),
      dWidth: r1(b.width - (text.r - text.l)),
      sb: c.scroller.offsetWidth - c.scroller.clientWidth,
      overflowing: c.scroller.scrollHeight > c.scroller.clientHeight + 1,
      gutter: getComputedStyle(c.scroller).scrollbarGutter,
      settled: noTransforms(c.box),
    };
  }
  window.__cw = {
    ready(kind) {
      const c = columns(kind);
      if (!c.col) return false;
      if (kind === "thread") return !!(c.ccol && c.box && c.col.textContent.length > 0);
      return true;
    },
    snapshot(kind) {
      const c = columns(kind);
      if (!c.col) return null;
      const els = [c.col, c.ccol, c.box].filter(Boolean);
      return JSON.stringify(
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return [r1(r.left), r1(r.width), noTransforms(e)];
        }),
      );
    },
    measure(kind, floor) {
      const c = columns(kind);
      if (!c.col) return { missing: true };
      const e = expect(c.col, floor);
      const out = {
        vw: innerWidth,
        rail: railState(),
        pane: r1(e.pane),
        avail: r1(e.avail),
        width: r1(e.width),
        expected: r1(e.expected),
        ratio: e.pane ? Math.round((e.width / e.pane) * 1000) / 1000 : null,
        hasContainer: !!e.container,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        paneOverflow: e.container ? e.container.scrollWidth - e.container.clientWidth : null,
      };
      if (kind === "thread" || kind === "newchat") {
        const shell = c.shell;
        out.shell = r1(px(getComputedStyle(shell).width));
        out.shellAvail = r1(contentBox(shell.parentElement));
      }
      if (kind === "thread") {
        const k = expect(c.ccol, floor);
        out.composerCol = { width: r1(k.width), expected: r1(k.expected), avail: r1(k.avail) };
        out.align = align(c);
        out.wide = window.__cw.wideContent(); // last: it measures with content added
      }
      return out;
    },
    // The OLD caps put back in place: overflow on the same page, same data, so a
    // pane that overflowed before (the empty chat below ~900px does) is a
    // baseline, not a regression.
    oldOverflow(kind) {
      const c = columns(kind);
      if (!c.col) return null;
      const container = containerOf(c.col);
      const saved = [];
      const set = (el, prop, v) => {
        if (!el) return;
        saved.push([el, prop, el.style[prop]]);
        el.style[prop] = v;
      };
      const cap = { newchat: "58rem", library: "64rem" }[kind] ?? "48rem";
      set(c.col, "maxWidth", cap);
      set(c.ccol, "maxWidth", cap);
      set(c.shell, "maxWidth", cap);
      set(c.scroller, "scrollbarGutter", "auto");
      set(container, "containerType", "normal");
      const v = {
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        paneOverflow: container ? container.scrollWidth - container.clientWidth : null,
      };
      for (const [el, prop, old] of saved.reverse()) el.style[prop] = old;
      return v;
    },
    // Content wider than any column, injected into the last assistant message
    // with the real renderers' wrappers (code-block.tsx PRE, markdown.tsx's table
    // wrapper) plus qa-responsive's unbreakable shapes (a bare URL in a list item,
    // an unbroken word, display math). The column must not grow, nothing may
    // escape it unclipped, and code / table / math scroll inside their own boxes.
    wideContent() {
      const host = [...document.querySelectorAll("div.group.my-5")].pop();
      const scroller = document.querySelector('[role="region"][aria-label="Conversation"]');
      if (!host || !scroller) return null;
      const col = scroller.firstElementChild;
      const before = px(getComputedStyle(col).width);
      const probe = document.createElement("div");
      probe.innerHTML = [
        '<ul class="my-2 list-disc space-y-1.5 pl-5">',
        `<li><a href="#">https://www2.example.com/us/en/insights/${"technology-management-".repeat(8)}report.html</a></li>`,
        `<li>plain ${"b".repeat(400)}</li></ul>`,
        '<div class="group relative my-3 -mx-4 md:mx-0"><pre class="overflow-x-auto rounded-lg p-4 font-geist-mono text-[12.5px] md:text-[13px]"><code>',
        `const x = '${"a".repeat(400)}';</code></pre></div>`,
        '<div tabindex="0" role="group" aria-label="Table" class="-mx-4 my-3 overflow-x-auto px-4 md:mx-0 md:px-0"><table class="w-full border-collapse text-sm"><tr>',
        ...Array.from({ length: 18 }, (_, i) => `<td style="white-space:nowrap;padding:4px 12px">column header ${i}</td>`),
        "</tr></table></div>",
        `<span class="katex-display" style="display:block"><span class="katex" style="white-space:nowrap"><span class="katex-html">${"x_{i}+alpha ".repeat(120)}</span></span></span>`,
      ].join("");
      host.appendChild(probe);
      const clipped = (e) => {
        for (let n = e.parentElement; n && n !== scroller; n = n.parentElement) {
          if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(n).overflowX)) return true;
        }
        return false;
      };
      const scrolls = (el) => (el ? el.scrollWidth > el.clientWidth + 1 : null);
      const out = {
        widthChange: r1(px(getComputedStyle(col).width) - before),
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        transcriptOverflow: scroller.scrollWidth - scroller.clientWidth,
        escapes: r1(
          Math.max(...[...probe.querySelectorAll("*")].filter((e) => !clipped(e)).map((e) => e.getBoundingClientRect().right)) -
            col.getBoundingClientRect().right,
        ),
        code: scrolls(probe.querySelector("pre")),
        table: scrolls(probe.querySelector('[aria-label="Table"]')),
        math: scrolls(probe.querySelector(".katex-display")),
      };
      probe.remove();
      return out;
    },
    // A position:fixed probe inside the column: a query container must not become
    // its containing block (that would make every inline dialog pane-relative).
    fixedProbe(kind) {
      const c = columns(kind);
      if (!c.col) return null;
      const p = document.createElement("div");
      p.style.cssText = "position:fixed;left:0;top:0;width:3px;height:3px";
      c.col.appendChild(p);
      const b = p.getBoundingClientRect();
      p.remove();
      return { left: b.left, top: b.top };
    },
    oldCapsForAnimation(on) {
      const c = columns("thread");
      const container = containerOf(c.col) ?? window.__cwContainer;
      window.__cwContainer = container;
      for (const el of [c.col, c.ccol, c.shell]) el.style.maxWidth = on ? "48rem" : "";
      c.scroller.style.scrollbarGutter = on ? "auto" : "";
      container.style.containerType = on ? "normal" : "";
    },
  };
}

// ---- helpers -----------------------------------------------------------------
// No hard navigation while the rail's warm-up is pending or in flight. Once its
// first thread page loads, the rail prefetches /library, /projects and
// /scheduled (chat-sidebar.tsx) from requestIdleCallback — which WebKit lacks,
// so there it is setTimeout 1500 + 150ms of intent: ~1.65s after EVERY full
// load. A page.goto that aborts those makes WebKit log "Failed to fetch RSC
// payload … Load failed" (known, pre-existing — ROADMAP, File Library notes), a
// console error this suite would otherwise blame on the change under test. So
// wait for the three to finish, then for the network to go quiet.
// waitForLoadState("networkidle") cannot do this: it resolves at once for a
// document that was idle earlier, whatever started since.
const WARMED = ["/library", "/projects", "/scheduled"];
function trackRequests(page) {
  const inflight = new Set();
  const warmed = new Set();
  page.on("request", (r) => inflight.add(r));
  const done = (r) => {
    inflight.delete(r);
    const u = new URL(r.url());
    if (u.searchParams.has("_rsc")) warmed.add(u.pathname);
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.on("load", () => warmed.clear()); // a new document warms again
  page.__inflight = inflight;
  page.__warmed = warmed;
}

async function waitWarm(page, timeout = 8000) {
  const rail = await page
    .evaluate(() => !!document.querySelector('nav[aria-label="Conversations"]'))
    .catch(() => false);
  if (!rail) return true;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (WARMED.every((p) => page.__warmed.has(p))) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function quiet(page, ms = 500, timeout = 15000) {
  const t0 = Date.now();
  let since = Date.now();
  while (Date.now() - t0 < timeout) {
    if (page.__inflight.size > 0) since = Date.now();
    else if (Date.now() - since >= ms) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const f = document.querySelector("form");
    return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber"));
  }, null, { timeout: 30000 });
  await page.locator('input[type="email"]').first().fill(process.env.QA_EMAIL);
  await page.locator('input[type="password"]').first().fill(process.env.QA_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 90000, waitUntil: "commit" });
  await page.waitForSelector("#chat-composer", { timeout: 60000 }).catch(() => undefined);
  await waitWarm(page);
  await quiet(page);
}

async function newSession(browser, opts, errors, tag) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript({ content: `(${pageLib.toString()})()` });
  const page = await ctx.newPage();
  trackRequests(page);
  page.on("console", (m) => m.type() === "error" && errors.push(`${tag}: ${m.text().slice(0, 200)}`));
  page.on("pageerror", (e) => errors.push(`${tag} pageerror: ${String(e).slice(0, 200)}`));
  await login(page);
  return { ctx, page };
}

async function convex(ctx, kind, fn, args) {
  const jwt = (await ctx.cookies()).find((k) => /convexAuthJWT/i.test(k.name))?.value;
  if (!jwt) return { ok: false, error: "no JWT cookie" };
  const r = await fetch(`${BASE}/__cvx/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ path: fn, args, format: "json" }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.status !== "error", value: j.value, error: j.errorMessage };
}

async function settle(page, kind) {
  await page.waitForTimeout(200);
  for (let i = 0; i < 25; i++) {
    const a = await page.evaluate((k) => window.__cw.snapshot(k), kind);
    await page.waitForTimeout(120);
    const b = await page.evaluate((k) => window.__cw.snapshot(k), kind);
    if (a && a === b && !a.includes("false")) return true;
  }
  return false;
}

async function openRoute(page, route, collapsed, viewport) {
  await page.setViewportSize(viewport);
  if (collapsed !== null) {
    await page.evaluate((c) => localStorage.setItem("chat:rail-collapsed", c ? "1" : "0"), collapsed);
  }
  await waitWarm(page);
  await quiet(page);
  await page.goto(`${BASE}${route.path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction((k) => window.__cw?.ready(k), route.kind, { timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  if (collapsed !== null && viewport.width >= 768) {
    const want = collapsed ? "collapsed" : "open";
    const got = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Conversations"]');
      return nav && nav.getBoundingClientRect().width > 200 ? "open" : "collapsed";
    });
    if (got !== want) {
      await page.evaluate(() =>
        (document.querySelector("[data-rail-hider]") ?? document.querySelector("[data-rail-opener]"))?.click(),
      );
      await page.waitForTimeout(700);
    }
  }
  await settle(page, route.kind);
}

const near = (a, b, tol = 0.5) => a != null && b != null && Math.abs(a - b) <= tol;

function judge(tag, route, m, base, wantRail) {
  if (m.missing) return check(`${tag}: column present`, false, "column not found");
  check(`${tag}: inside a query container`, m.hasContainer);
  check(`${tag}: width = min(avail, max(${route.floor}, 0.7×pane))`, near(m.width, m.expected),
    `${m.width} vs ${m.expected} (pane ${m.pane}, avail ${m.avail})`);
  check(`${tag}: no document overflow`, m.docOverflow <= Math.max(0, base?.docOverflow ?? 0),
    `${m.docOverflow}px (old caps ${base?.docOverflow}px)`);
  check(`${tag}: pane overflow no worse than the old caps`,
    m.paneOverflow == null || base?.paneOverflow == null || m.paneOverflow <= base.paneOverflow + 0.5,
    `${m.paneOverflow}px vs ${base?.paneOverflow}px`);
  if (wantRail) check(`${tag}: rail is ${wantRail}`, m.rail === wantRail, m.rail);
  if (route.kind === "newchat" || route.kind === "thread") {
    check(`${tag}: composer shell has no cap of its own`, near(m.shell, m.shellAvail), `${m.shell} vs ${m.shellAvail}`);
  }
  if (route.kind === "thread") {
    const k = m.composerCol;
    check(`${tag}: composer column = same rule`, near(k.width, k.expected), `${k.width} vs ${k.expected}`);
    const a = m.align;
    if (m.pane >= GUTTER_FROM) {
      check(`${tag}: composer box spans the transcript text exactly`,
        Math.abs(a.dLeft) <= 0.5 && Math.abs(a.dRight) <= 0.5 && Math.abs(a.dWidth) <= 0.5,
        `Δl ${a.dLeft} Δr ${a.dRight} Δw ${a.dWidth} (gutter ${a.gutter})`);
    } else {
      check(`${tag}: composer vs transcript within one scrollbar (as before)`,
        Math.abs(a.dLeft) <= a.sb + 0.5 && Math.abs(a.dRight) <= a.sb + 0.5,
        `Δl ${a.dLeft} Δr ${a.dRight} sb ${a.sb}`);
    }
    const w = m.wide;
    if (!w) return check(`${tag}: wide content probed`, false, "no assistant message to probe");
    check(`${tag}: wide content does not widen the column`, Math.abs(w.widthChange) <= 0.5, `${w.widthChange}px`);
    check(`${tag}: wide content scrolls neither the page nor the transcript`,
      w.docOverflow <= 0 && w.transcriptOverflow <= 1, `doc ${w.docOverflow}px, transcript ${w.transcriptOverflow}px`);
    check(`${tag}: nothing escapes the column unclipped`, w.escapes <= 0.5, `${w.escapes}px past its edge`);
    check(`${tag}: code, table and math scroll inside their own boxes`,
      w.code === true && w.table === true && w.math !== false, `code ${w.code} table ${w.table} math ${w.math}`);
  }
}

function row(route, w, rail, m, base) {
  const a = m.align ? ` Δl/Δr ${m.align.dLeft}/${m.align.dRight}` : "";
  const k = m.composerCol ? ` comp ${m.composerCol.width}` : "";
  return `    ${String(w).padStart(4)} ${rail.padEnd(9)} pane ${String(m.pane).padStart(6)}  col ${String(m.width).padStart(6)}  exp ${String(m.expected).padStart(6)}  ratio ${m.ratio}${k}${a}  docOF ${m.docOverflow} paneOF ${m.paneOverflow}/${base?.paneOverflow}`;
}

// ---- phases ------------------------------------------------------------------
async function generateThread(page, results) {
  say("\n=== GENERATE a long answer (1920x1080, rail open) and watch the transcript width");
  await openRoute(page, { path: "/en/chat", kind: "newchat" }, false, { width: 1920, height: 1080 });
  await page.evaluate(() => {
    window.__samples = [];
    window.__sampler = setInterval(() => {
      const sc = document.querySelector('[role="region"][aria-label="Conversation"]');
      const col = sc?.firstElementChild;
      if (!col) return;
      window.__samples.push({
        w: Number.parseFloat(getComputedStyle(col).width),
        of: sc.scrollHeight > sc.clientHeight + 1,
        sb: sc.offsetWidth - sc.clientWidth,
      });
    }, 50);
  });
  await page.locator("#chat-composer").fill(PROMPT);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[^/?#]+/, { timeout: 60000 });
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ timeout: 30000 }).catch(() => undefined);
  const t0 = Date.now();
  while ((await stop.count()) > 0 && Date.now() - t0 < 240000) await page.waitForTimeout(500);
  await page.waitForTimeout(1500);
  const samples = await page.evaluate(() => {
    clearInterval(window.__sampler);
    return window.__samples ?? null;
  });
  const threadId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  if (!samples || samples.length === 0) {
    check("stream: the transcript was sampled", false, "no samples (a full reload?)");
    return threadId;
  }
  const firstOf = samples.findIndex((s) => s.of);
  const appeared = firstOf > 0 && samples.slice(0, firstOf).some((s) => !s.of);
  const ws = samples.map((s) => s.w);
  const spread = Math.max(...ws) - Math.min(...ws);
  results.stream = { samples: samples.length, firstOverflowAt: firstOf, spread, widths: [...new Set(ws.map((w) => Math.round(w * 10) / 10))] };
  say(`  ${samples.length} samples; overflow began at sample ${firstOf}; widths seen ${JSON.stringify(results.stream.widths)}`);
  check("stream: the transcript's scrollbar appeared mid-answer (precondition)", appeared);
  check("stream: the transcript column kept its width as the scrollbar appeared", spread <= 0.5, `spread ${spread.toFixed(2)}px`);
  return threadId;
}

async function railCost(page, oldCaps) {
  await page.evaluate((on) => window.__cw.oldCapsForAnimation(on), oldCaps);
  await page.waitForTimeout(300);
  const trial = async (selector) => {
    await page.evaluate(() => {
      window.__f = [];
      let last = performance.now();
      const tick = (t) => {
        window.__f.push(t - last);
        last = t;
        if (window.__f.length < 50) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.waitForTimeout(80);
    await page.evaluate((s) => document.querySelector(s)?.click(), selector);
    await page.waitForTimeout(1100);
    const f = await page.evaluate(() => window.__f.slice(1));
    return { over33: f.filter((x) => x > 33).length, worst: Math.round(Math.max(...f) * 10) / 10 };
  };
  const collapse = [];
  const expand = [];
  for (let i = 0; i < 3; i++) {
    collapse.push(await trial("[data-rail-hider]"));
    expand.push(await trial("[data-rail-opener]"));
  }
  await page.evaluate(() => window.__cw.oldCapsForAnimation(false));
  const med = (a) => [...a].sort((x, y) => x.over33 - y.over33)[1];
  return { collapse, expand, collapseMedian: med(collapse), expandMedian: med(expand) };
}

async function desktop(browser, errors, results, state) {
  say("\n=== DESKTOP (Chromium, headed)");
  const { ctx, page } = await newSession(browser, { viewport: { width: 1920, height: 1080 } }, errors, "desktop");
  try {
    if (process.env.THREAD_ID) state.threadId = process.env.THREAD_ID;
    else {
      state.threadId = await generateThread(page, results);
      state.created = state.threadId;
    }
    say(`  thread: ${state.threadId}${state.created ? " (generated; deleted at the end)" : ""}`);

    await page.goto(`${BASE}/en/projects`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
    const project = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a[href*="/projects/"]')][0];
      return a ? new URL(a.href).pathname : null;
    });

    const routes = [
      { name: "new chat", path: "/en/chat", kind: "newchat", floor: 928, rail: true },
      { name: "thread", path: `/en/chat/${state.threadId}`, kind: "thread", floor: 768, rail: true },
      { name: "projects", path: "/en/projects", kind: "list", floor: 768, rail: true },
      project && { name: "a project", path: project, kind: "list", floor: 768, rail: true },
      { name: "scheduled", path: "/en/scheduled", kind: "list", floor: 768, rail: true },
      // An unknown task id still opens the 420px detail panel ("Unavailable"),
      // with no Convex call that can fail — the panel-open case without a task.
      { name: "scheduled + panel", path: "/en/scheduled/content-width-probe", kind: "list", floor: 768, rail: true },
      { name: "library", path: "/en/library", kind: "library", floor: 1024, rail: true },
      { name: "settings profile", path: "/en/settings", kind: "settings", floor: 768, rail: false },
      { name: "settings appearance", path: "/en/settings/appearance", kind: "settings", floor: 768, rail: false },
    ].filter(Boolean);
    if (!project) say("  (no project on this account: /projects/<id> not measured)");
    state.routes = routes;

    results.matrix = {};
    for (const route of routes) {
      for (const collapsed of route.rail ? [false, true] : [null]) {
        const railName = collapsed === null ? "no-rail" : collapsed ? "collapsed" : "open";
        say(`\n  ${route.name} — rail ${railName}`);
        await openRoute(page, route, collapsed, { width: 1920, height: 1080 });
        for (const w of DESKTOP) {
          await page.setViewportSize({ width: w, height: heightFor(w) });
          const steady = await settle(page, route.kind);
          const m = await page.evaluate(([k, f]) => window.__cw.measure(k, f), [route.kind, route.floor]);
          const base = await page.evaluate((k) => window.__cw.oldOverflow(k), route.kind);
          results.matrix[`${route.name}|${railName}|${w}`] = { ...m, base, steady };
          say(row(route, w, railName, m, base));
          const wantRail = collapsed === null ? null : railName;
          judge(`${route.name} ${w} ${railName}`, route, m, base, wantRail);
          if (!steady) check(`${route.name} ${w} ${railName}: layout settled`, false);
          if (w === 1920) {
            const slug = route.name.replace(/[^a-z]+/g, "-");
            await page.screenshot({ path: path.join(OUT, `${slug}-1920-${railName}.png`) });
          }
        }
      }
    }

    say("\n=== THREAD: rail toggle with the long answer on screen (1920x1080)");
    await openRoute(page, routes[1], false, { width: 1920, height: 1080 });
    const longEnough = await page.evaluate(() => {
      const sc = document.querySelector('[role="region"][aria-label="Conversation"]');
      return { scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight, chars: sc.textContent.length };
    });
    say(`  transcript ${longEnough.chars} chars, ${longEnough.scrollHeight}px tall in a ${longEnough.clientHeight}px view`);
    check("thread: the answer overflows the view (a long thread)", longEnough.scrollHeight > longEnough.clientHeight * 1.5);
    const now = await railCost(page, false);
    const old = await railCost(page, true);
    results.railAnimation = { now, old };
    say(`  now  collapse ${JSON.stringify(now.collapse)}  expand ${JSON.stringify(now.expand)}`);
    say(`  old  collapse ${JSON.stringify(old.collapse)}  expand ${JSON.stringify(old.expand)}`);
    check(`rail collapse: median ≤ ${FRAME_BUDGET} frames over 33ms`, now.collapseMedian.over33 <= FRAME_BUDGET,
      `median ${now.collapseMedian.over33} (old caps ${old.collapseMedian.over33})`);
    check(`rail expand: median ≤ ${FRAME_BUDGET} frames over 33ms`, now.expandMedian.over33 <= FRAME_BUDGET,
      `median ${now.expandMedian.over33} (old caps ${old.expandMedian.over33})`);

    say("\n=== UNCHANGED + CONTAINMENT (1920x1080)");
    await openRoute(page, routes[0], false, { width: 1920, height: 1080 });
    await page.locator('nav button[aria-label="Search chats"]').click();
    const dlg = page.locator('[role="dialog"]').first();
    await dlg.waitFor({ timeout: 10000 });
    await page.waitForTimeout(400);
    const dw = await dlg.evaluate((e) => Number.parseFloat(getComputedStyle(e).width));
    results.searchDialogWidth = dw;
    check("search dialog keeps max-w-xl (576px)", near(dw, 576), `${dw}px`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    for (const route of routes.filter((r) => r.rail)) {
      await openRoute(page, route, false, { width: 1920, height: 1080 });
      const p = await page.evaluate((k) => window.__cw.fixedProbe(k), route.kind);
      check(`${route.name}: position:fixed still resolves to the viewport`, p && p.left === 0 && p.top === 0, JSON.stringify(p));
    }
    await realDialogs(page, "chromium", results);
  } finally {
    await page.evaluate(() => localStorage.setItem("chat:rail-collapsed", "0")).catch(() => undefined);
    await ctx.close();
  }
}

// The inline (unportalled) overlays that live INSIDE a query container now.
async function realDialogs(page, engine, results) {
  results.dialogs = results.dialogs ?? {};
  await openRoute(page, { path: "/en/projects", kind: "list" }, false, page.viewportSize());
  await page.getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.locator('[role="dialog"][aria-label="New project"]');
  await dialog.waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  const g = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"][aria-label="New project"]');
    const back = d.previousElementSibling;
    const b = back.getBoundingClientRect();
    const r = d.getBoundingClientRect();
    return {
      backdrop: { l: b.left, t: b.top, w: b.width, h: b.height },
      dialogCentreDx: Math.round((r.left + r.width / 2 - innerWidth / 2) * 10) / 10,
      vw: innerWidth,
      vh: innerHeight,
    };
  });
  results.dialogs[`${engine} new-project`] = g;
  check(`${engine}: the New project backdrop still covers the whole viewport`,
    g.backdrop.l === 0 && g.backdrop.t === 0 && near(g.backdrop.w, g.vw) && near(g.backdrop.h, g.vh), JSON.stringify(g.backdrop));
  check(`${engine}: the New project dialog is centred on the viewport`, Math.abs(g.dialogCentreDx) <= 1, `Δx ${g.dialogCentreDx}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await openRoute(page, { path: "/en/scheduled", kind: "list" }, false, page.viewportSize());
  await page.locator('button[aria-haspopup="menu"]', { hasText: /Active|Paused|All/ }).first().click();
  const close = page.locator('button[aria-label="Close filter"]');
  await close.waitFor({ timeout: 10000 });
  const c = await close.evaluate((e) => {
    const b = e.getBoundingClientRect();
    return { l: b.left, t: b.top, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight };
  });
  results.dialogs[`${engine} scheduled-filter`] = c;
  check(`${engine}: the Scheduled filter's click-away layer still covers the viewport`,
    c.l === 0 && c.t === 0 && near(c.w, c.vw) && near(c.h, c.vh), JSON.stringify(c));
  await close.click();
}

async function phone(browser, errors, results, state) {
  say("\n=== PHONE 390x844 (touch)");
  const { ctx, page } = await newSession(browser,
    { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, errors, "phone");
  results.phone = {};
  try {
    for (const route of state.routes) {
      await openRoute(page, route, null, { width: 390, height: 844 });
      const m = await page.evaluate(([k, f]) => window.__cw.measure(k, f), [route.kind, route.floor]);
      const base = await page.evaluate((k) => window.__cw.oldOverflow(k), route.kind);
      results.phone[route.name] = { ...m, base };
      say(row(route, 390, "drawer", m, base));
      judge(`phone ${route.name}`, route, m, base, null);
      check(`phone ${route.name}: full width (unchanged)`, near(m.width, m.avail), `${m.width} of ${m.avail}`);
      if (route.kind === "thread" || route.kind === "newchat") {
        await page.screenshot({ path: path.join(OUT, `phone-${route.kind}.png`) });
      }
    }
    if (state.created) {
      const r = await convex(ctx, "mutation", "chat/threads:remove", { threadId: state.created });
      check("cleanup: the generated thread is deleted", r.ok, r.error ?? "");
      if (r.ok) state.created = null;
    }
  } finally {
    await ctx.close();
  }
}

async function webkitPass(errors, results) {
  say("\n=== WEBKIT 1280x800 (Playwright WebKit — Safari's engine, not iOS)");
  const browser = await webkit.launch({ headless: HEADLESS });
  const { ctx, page } = await newSession(browser, { viewport: { width: 1280, height: 800 } }, errors, "webkit");
  results.webkit = {};
  try {
    for (const route of [
      { name: "projects", path: "/en/projects", kind: "list", floor: 768 },
      { name: "scheduled + panel", path: "/en/scheduled/content-width-probe", kind: "list", floor: 768 },
      { name: "library", path: "/en/library", kind: "library", floor: 1024 },
      { name: "settings profile", path: "/en/settings", kind: "settings", floor: 768 },
    ]) {
      for (const w of [1920, 1280]) {
        await openRoute(page, route, route.kind === "settings" ? null : false, { width: w, height: heightFor(w) });
        const m = await page.evaluate(([k, f]) => window.__cw.measure(k, f), [route.kind, route.floor]);
        const base = await page.evaluate((k) => window.__cw.oldOverflow(k), route.kind);
        results.webkit[`${route.name}|${w}`] = { ...m, base };
        say(row(route, w, "webkit", m, base));
        judge(`webkit ${route.name} ${w}`, route, m, base, null);
        const p = await page.evaluate((k) => window.__cw.fixedProbe(k), route.kind);
        check(`webkit ${route.name} ${w}: position:fixed resolves to the viewport`, p && p.left === 0 && p.top === 0, JSON.stringify(p));
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await realDialogs(page, "webkit", results);
  } finally {
    await ctx.close();
    await browser.close();
  }
}

(async () => {
  if (!process.env.QA_EMAIL || !process.env.QA_PASSWORD) throw new Error("QA_EMAIL and QA_PASSWORD must be set");
  fs.mkdirSync(OUT, { recursive: true });
  const errors = [];
  const results = {};
  const state = { threadId: null, created: null, routes: [] };
  const browser = await chromium.launch({ headless: HEADLESS });
  try {
    // The phone pass measures the routes (and the thread) the desktop pass found.
    if (PHASES.includes("desktop")) {
      await desktop(browser, errors, results, state);
      await phone(browser, errors, results, state);
    }
    if (PHASES.includes("webkit")) await webkitPass(errors, results);
  } finally {
    if (state.created) {
      // A failure before the phone phase's cleanup: one more session, just to delete.
      const { ctx } = await newSession(browser, { viewport: { width: 1280, height: 800 } }, [], "cleanup");
      const r = await convex(ctx, "mutation", "chat/threads:remove", { threadId: state.created });
      console.log(`  cleanup after failure: thread ${r.ok ? "deleted" : `NOT deleted (${r.error})`}`);
      await ctx.close();
    }
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify({ results, errors }, null, 1));
  console.log(`\nconsole errors: ${errors.length}`);
  for (const e of errors) console.log(`  ${e}`);
  check("zero console errors", errors.length === 0);
  console.log(`\n=== CONTENT WIDTH: ${fails === 0 ? "PASS" : "FAIL"} — ${passes} passed, ${fails} failed ===`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
