// qa-font.js — Poppins is the global font. Proven in a real browser, glyph by glyph.
//
//   source /tmp/qa-env.sh
//   node qa-font.js --mode before                         baseline of CURRENT prod, run BEFORE deploying
//   node qa-font.js --mode after                          the full proof + before/after diff
//   node qa-font.js --mode public --base http://localhost:3000   pre-deploy gate: public routes, no login
//   --engines chromium,webkit,firefox,mobile-safari,mobile-chrome   (default: all)
//
// WHAT COUNTS AS PROOF, in order of strength:
//   1. PLATFORM FONT (Chromium, CDP `CSS.getPlatformFontsForNode`): for every element
//      that owns visible text, the actual face the engine drew each glyph with —
//      `Poppins-Regular`, `Poppins-Italic`, `Poppins-SemiBold`… — and how many glyphs.
//      A glyph drawn with anything else must be explained by a character Poppins
//      does not cover (an emoji, an arrow) or by an allowlisted monospace child.
//   2. COMPUTED STYLE: the first family in `getComputedStyle(el).fontFamily` is the
//      Poppins face. Engine-agnostic — this is what WebKit and Firefox can run.
//   3. METRICS: a probe string in the page's family measures a different width than
//      the same string in `sans-serif` and `serif`, and the same width as the face
//      named explicitly. The face is IN USE, not merely declared.
//   4. `document.fonts` — declared faces and their load status. Supporting only.
//
// Plus: real Hindi typed and sent (the Devanagari file must be ABSENT on /login and
// PRESENT after), a real toast (Sonner injects its own font), a real chart (canvas
// has no cascade), a real mermaid diagram, every weight, the mono allowlist inverse,
// font transfer size + CLS, a before/after screenshot + geometry diff of eight areas,
// and five engines. Zero console errors, as every suite.
const { chromium, webkit, firefox, devices } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const MODE = arg("mode", "after"); // before | after | public
const BASE = arg("base", process.env.E2E_BASE_URL || "https://app.ollasuper.com");
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";
const ENGINES = arg("engines", "chromium,webkit,firefox,mobile-safari,mobile-chrome").split(",");
const OUT = path.join(__dirname, "out", "font");
fs.mkdirSync(OUT, { recursive: true });
const PERF_STATE = path.join(__dirname, "out", "mobile-perf", "state.json");

const HINDI = "नमस्ते, यह एक परीक्षण संदेश है। कृपया हिन्दी में एक छोटा उत्तर दें।";
// Every surface that may legitimately not be Poppins. Mirrors font.test.ts.
const MONO_ALLOW = "pre, code, .katex, [class*=geist-mono], [class*=font-mono]";

const results = [];
const errs = [];
const notes = [];
const report = { mode: MODE, base: BASE, at: new Date().toISOString(), routes: {}, engines: {} };
const step = async (n, f) => {
  try {
    const r = await f();
    results.push(true);
    console.log(`PASS  ${n}${r ? ` — ${r}` : ""}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${n} — ${String(e.message || e).split("\n")[0].slice(0, 300)}`);
  }
};
const need = (c, m) => {
  if (!c) throw new Error(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ page helpers

// The toast step signs in with a deliberately wrong password to raise a REAL
// error toast; the auth endpoint answers 400 and Chromium logs that as a console
// error. That one, during that step only, is the expected result, not a defect.
let expect400 = false;
function wire(page, tag) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const line = `[${tag}] ${page.url().replace(BASE, "")} ${m.text().slice(0, 200)}`;
    if (expect400 && /status of 400/.test(m.text())) return notes.push(`expected during the wrong-password toast: ${line}`);
    errs.push(line);
  });
  page.on("pageerror", (e) => errs.push(`[${tag}] ${page.url().replace(BASE, "")} pageerror ${e.message.slice(0, 200)}`));
}

async function login(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/en/login`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL(/\/chat/, { timeout: 60000, waitUntil: "commit" });
      await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 60000 });
      return;
    } catch {
      console.log(`      login attempt ${attempt} failed`);
      await sleep(15000);
    }
  }
  throw new Error("login failed");
}

const settle = async (page, ms = 120000) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ timeout: 30000 }).catch(() => {});
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await stop.count()) === 0) return true;
    await page.waitForTimeout(400);
  }
  return false;
};

async function open(page, route) {
  await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

// Runs in the page. Tags every element that owns visible text with data-qf=<i>
// and describes it. `own` is the element's OWN text (direct text nodes) — what its
// glyphs come from once its children are counted separately.
const TAG_TEXT = (MONO_ALLOW) => {
  const ranges = [];
  const files = {};
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const r of rules) {
      if (!(r instanceof CSSFontFaceRule)) continue;
      const fam = r.style.getPropertyValue("font-family");
      if (!/poppins/i.test(fam) || /fallback/i.test(fam)) continue;
      const ur = r.style.getPropertyValue("unicode-range");
      const src = (r.style.getPropertyValue("src").match(/url\(([^)]+)\)/) || [])[1]?.replace(/["']/g, "");
      const rs = [];
      for (const part of ur.split(",")) {
        const m = part.trim().match(/^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i);
        if (!m) continue;
        const lo = parseInt(m[1].replace(/\?/g, "0"), 16);
        const hi = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, "F"), 16);
        rs.push([lo, hi]);
      }
      ranges.push(...rs);
      if (src) {
        const isDev = rs.some(([lo, hi]) => lo <= 0x0900 && hi >= 0x0900);
        const isExt = !isDev && rs.some(([lo, hi]) => lo <= 0x0178 && hi >= 0x0178);
        files[src.split("/").pop()] = {
          subset: isDev ? "devanagari" : isExt ? "latin-ext" : "latin",
          weight: r.style.getPropertyValue("font-weight"),
          style: r.style.getPropertyValue("font-style"),
          family: fam,
        };
      }
    }
  }
  const covered = (cp) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let n;
  while ((n = walker.nextNode())) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || seen.has(el)) continue;
    if (el.closest("script, style, noscript, [data-perf-probe]")) continue;
    if (!visible(el)) continue;
    seen.add(el);
    const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join("");
    const chars = [...own.replace(/\s+/g, "")];
    const uncovered = chars.filter((ch) => !covered(ch.codePointAt(0)));
    // Descendant text that is allowed to be another face: the platform-font count
    // for this node includes it, so it must be explained.
    let allowedDesc = 0;
    let descUncovered = 0;
    for (const d of el.querySelectorAll("*")) {
      const t = [...d.childNodes].filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join("").replace(/\s+/g, "");
      if (!t) continue;
      if (d.closest(MONO_ALLOW)) allowedDesc += [...t].length;
      else descUncovered += [...t].filter((ch) => !covered(ch.codePointAt(0))).length;
    }
    const i = nodes.length;
    el.setAttribute("data-qf", String(i));
    const cs = getComputedStyle(el);
    nodes.push({
      i,
      tag: el.tagName.toLowerCase(),
      cls: String(el.className?.baseVal ?? el.className ?? "").slice(0, 60),
      text: own.trim().slice(0, 40),
      chars: chars.length,
      allowlisted: !!el.closest(MONO_ALLOW),
      family: cs.fontFamily.split(",")[0].trim().replace(/["']/g, ""),
      weight: cs.fontWeight,
      style: cs.fontStyle,
      foreignBudget: uncovered.length + allowedDesc + descUncovered,
      uncoveredChars: [...new Set(uncovered)].slice(0, 6).join(""),
    });
  }
  return {
    nodes,
    files,
    htmlFamily: getComputedStyle(document.documentElement).fontFamily,
    rangeCount: ranges.length,
  };
};

const UNTAG = () => {
  for (const el of document.querySelectorAll("[data-qf]")) el.removeAttribute("data-qf");
};

// Engine-agnostic metric proof, run in the page.
const METRICS = (text) => {
  const html = getComputedStyle(document.documentElement).fontFamily;
  const first = html.split(",")[0].trim();
  const w = (family) => {
    const s = document.createElement("span");
    s.textContent = text;
    s.style.cssText = `position:absolute;left:-9999px;top:0;font-size:24px;white-space:nowrap;font-family:${family}`;
    document.body.appendChild(s);
    const r = s.getBoundingClientRect().width;
    s.remove();
    return r;
  };
  return { page: w(html), explicit: w(first), sans: w("sans-serif"), serif: w("serif"), first };
};

// One FontFace per weight × style × SUBSET: the latin-ext and Devanagari entries
// stay "unloaded" on an English page by design, so status is judged per subset.
const FONT_STATUS = () =>
  [...document.fonts]
    .filter((f) => /poppins/i.test(f.family) && !/fallback/i.test(f.family))
    .map((f) => {
      // The getter serialises WITHOUT zero padding (U+900-97F), so parse, don't grep.
      const lo = parseInt((f.unicodeRange.match(/U\+([0-9A-F?]+)/i) || [, "0"])[1].replace(/\?/g, "0"), 16);
      const subset = lo === 0x900 ? "devanagari" : lo === 0x100 ? "latin-ext" : lo === 0 ? "latin" : `other:${f.unicodeRange.slice(0, 12)}`;
      return { family: f.family, weight: f.weight, style: f.style, status: f.status, subset, dev: subset === "devanagari" };
    });

// The platform fonts for one tagged node, via CDP. Chromium only.
async function platformFonts(cdp, root, i) {
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root, selector: `[data-qf="${i}"]` });
  if (!nodeId) return null;
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  return fonts;
}

/**
 * The route proof. Returns a summary and throws on the first hard failure.
 * `cdp` is null on non-Chromium engines, where proofs 2–4 still run.
 */
async function proveRoute(page, cdp, route, label) {
  const tagged = await page.evaluate(TAG_TEXT, MONO_ALLOW);
  need(tagged.nodes.length > 0, "no text on the page");
  need(/poppins/i.test(tagged.htmlFamily), `html font-family is ${tagged.htmlFamily}`);
  const ui = tagged.nodes.filter((n) => !n.allowlisted);
  const mono = tagged.nodes.filter((n) => n.allowlisted);
  need(ui.length > 0, "every text node was allowlisted — vacuous");

  // 2. computed style, every UI node
  const wrongFamily = ui.filter((n) => !/poppins/i.test(n.family));
  need(wrongFamily.length === 0, `computed family not Poppins on ${wrongFamily.length}: ${wrongFamily.slice(0, 4).map((n) => `${n.tag}.${n.cls.split(" ")[0]}[${n.text}]=${n.family}`).join(" | ")}`);
  // inverse: allowlisted nodes are still mono
  const notMono = mono.filter((n) => !/geist|mono|katex/i.test(n.family) && !/katex/i.test(n.cls));
  need(notMono.length === 0, `allowlisted node lost its mono face: ${notMono.slice(0, 3).map((n) => `${n.tag}[${n.text}]=${n.family}`).join(" | ")}`);

  // 3. metrics
  const m = await page.evaluate(METRICS, "The quick brown fox — OllaSuper 0123456789 @#%");
  need(Math.abs(m.page - m.sans) > 2 && Math.abs(m.page - m.serif) > 2, `probe width ${m.page} matches a generic (sans ${m.sans}, serif ${m.serif}) — face not in use`);
  need(Math.abs(m.page - m.explicit) < 0.6, `page family ${m.page}px ≠ explicit ${m.first} ${m.explicit}px`);

  // 4. document.fonts
  const status = await page.evaluate(FONT_STATUS);
  const latin = status.filter((f) => f.subset === "latin");
  const used = new Set(ui.map((n) => `${n.weight}/${n.style}`));
  const unloadedUsed = latin.filter((f) => used.has(`${f.weight}/${f.style}`) && f.status !== "loaded");
  need(unloadedUsed.length === 0, `used faces not loaded: ${unloadedUsed.map((f) => `${f.weight} ${f.style}=${f.status}`).join(", ")}`);

  // 1. platform fonts — the primary proof
  let glyphs = 0;
  let poppinsGlyphs = 0;
  let foreignGlyphs = 0;
  const offenders = [];
  const faces = {};
  if (cdp) {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    for (const n of ui) {
      const fonts = await platformFonts(cdp, root.nodeId, n.i);
      if (!fonts) continue;
      let p = 0;
      let f = 0;
      for (const ft of fonts) {
        // "Poppins Fallback" is local Arial with metric overrides — a hit there is a MISS.
        const isP = /^Poppins/.test(ft.postScriptName || "") || (/poppins/i.test(ft.familyName) && !/fallback/i.test(ft.familyName));
        if (isP) {
          p += ft.glyphCount;
          faces[ft.postScriptName] = (faces[ft.postScriptName] || 0) + ft.glyphCount;
        } else {
          f += ft.glyphCount;
          faces[`OTHER:${ft.postScriptName || ft.familyName}`] = (faces[`OTHER:${ft.postScriptName || ft.familyName}`] || 0) + ft.glyphCount;
        }
      }
      glyphs += p + f;
      poppinsGlyphs += p;
      foreignGlyphs += f;
      if (f > n.foreignBudget) offenders.push(`${n.tag}.${n.cls.split(" ")[0]}[${n.text}] ${f} foreign > budget ${n.foreignBudget} (${fonts.map((x) => `${x.postScriptName || x.familyName}×${x.glyphCount}`).join(",")}) chars:${n.uncoveredChars}`);
      // A node with in-range characters must have drawn at least one Poppins glyph.
      if (p === 0 && n.chars > n.foreignBudget) offenders.push(`${n.tag}.${n.cls.split(" ")[0]}[${n.text}] drew ZERO Poppins glyphs: ${fonts.map((x) => `${x.postScriptName || x.familyName}×${x.glyphCount}`).join(",")}`);
    }
    need(offenders.length === 0, `${offenders.length} node(s) drawn with a foreign face: ${offenders.slice(0, 4).join(" || ")}`);
    need(poppinsGlyphs > 0, "zero Poppins glyphs drawn");
  }
  await page.evaluate(UNTAG);
  const summary = {
    route,
    label,
    uiNodes: ui.length,
    monoNodes: mono.length,
    glyphs,
    poppinsGlyphs,
    foreignGlyphs,
    faces,
    latinFaces: latin.length,
    htmlFamily: tagged.htmlFamily.slice(0, 80),
    metrics: m,
  };
  report.routes[`${label}:${route}`] = summary;
  return cdp
    ? `${ui.length} UI nodes / ${mono.length} mono · ${glyphs} glyphs: ${poppinsGlyphs} Poppins, ${foreignGlyphs} outside coverage · ${Object.keys(faces).filter((k) => !k.startsWith("OTHER")).length} faces`
    : `${ui.length} UI nodes / ${mono.length} mono · computed+metric ok · ${latin.length} latin faces declared`;
}

/** The face a specific element was drawn with (Chromium). */
async function faceOf(page, cdp, selector, textMatch) {
  const i = await page.evaluate(
    ([sel, txt, MONO_ALLOW]) => {
      const els = [...document.querySelectorAll(sel)].filter((el) => {
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return false;
        const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join("").trim();
        return own.length > 0 && (!txt || own.includes(txt));
      });
      const el = els[0];
      if (!el) return null;
      document.querySelectorAll("[data-qf]").forEach((e) => e.removeAttribute("data-qf"));
      el.setAttribute("data-qf", "0");
      const cs = getComputedStyle(el);
      return { tag: el.tagName.toLowerCase(), family: cs.fontFamily.split(",")[0].trim(), weight: cs.fontWeight, style: cs.fontStyle, text: el.textContent.trim().slice(0, 30) };
    },
    [selector, textMatch || "", MONO_ALLOW],
  );
  if (!i) return null;
  let fonts = null;
  if (cdp) {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    fonts = await platformFonts(cdp, root.nodeId, 0);
  }
  await page.evaluate(UNTAG);
  return { ...i, fonts };
}

const faceString = (r) => (r?.fonts ? r.fonts.map((f) => `${f.postScriptName || f.familyName}×${f.glyphCount}`).join(",") : `computed=${r?.family}`);
const drawnWith = (r, re) => r?.fonts && r.fonts.length > 0 && r.fonts.every((f) => re.test(f.postScriptName || f.familyName));

// ------------------------------------------------------------- perf + geometry

function trackFonts(page) {
  const seen = [];
  page.on("response", (res) => {
    const u = res.url();
    if (/\.(woff2?|ttf|otf)(\?|$)/.test(u)) seen.push({ url: u, status: res.status(), len: Number(res.headers()["content-length"] || 0) });
  });
  return seen;
}

const CLS_INIT = () => {
  window.__cls = 0;
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
};

const PERF_READ = () => ({
  cls: Number((window.__cls || 0).toFixed(4)),
  preloads: [...document.querySelectorAll("link[rel=preload][as=font]")].map((l) => l.getAttribute("href").split("/").pop()),
  resources: performance
    .getEntriesByType("resource")
    .filter((r) => /\.(woff2?|ttf|otf)(\?|$)/.test(r.name))
    .map((r) => ({ file: r.name.split("/").pop(), host: new URL(r.name).host, bytes: r.encodedBodySize, transfer: r.transferSize })),
});

const LANDMARKS = ["header", "nav", "aside", "main", "form", "#chat-composer", "footer", "[role=tablist]", "table", "h1", "button[type=submit]"];
const GEOMETRY = (LANDMARKS) => {
  const out = {};
  for (const sel of LANDMARKS) {
    const el = [...document.querySelectorAll(sel)].find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!el) continue;
    const r = el.getBoundingClientRect();
    out[sel] = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  }
  return { boxes: out, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, family: getComputedStyle(document.body).fontFamily.split(",")[0] };
};

// The eight areas the brief names, plus the workspace shell.
const AREAS = (t) => [
  ["chat", "/en/chat"],
  ["chat-thread", t.codeThread ? `/en/chat/${t.codeThread}` : null],
  ["auth", "/en/login"],
  ["settings", "/en/settings"],
  ["skills", "/en/settings/skills"],
  ["projects", "/en/projects"],
  ["mcp", "/en/settings/connectors"],
  ["files", "/en/files"],
  ["shell", "/en/scheduled"],
].filter(([, r]) => r);
const VIEWPORTS = [
  ["1280", 1280, 800],
  ["375", 375, 667],
];

async function captureAreas(browser, threads, tag) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  wire(page, `${tag}-capture`);
  await page.addInitScript(CLS_INIT);
  await login(page);
  const cap = {};
  for (const [area, route] of AREAS(threads)) {
    for (const [vn, w, h] of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: h });
      await open(page, route);
      const g = await page.evaluate(GEOMETRY, LANDMARKS);
      g.cls = await page.evaluate(() => Number((window.__cls || 0).toFixed(4)));
      const file = path.join(OUT, `${tag}-${area}-${vn}.png`);
      await page.screenshot({ path: file, fullPage: false });
      cap[`${area}@${vn}`] = { ...g, route, file: path.basename(file) };
    }
  }
  await ctx.close();
  return cap;
}

function diffAreas(before, after) {
  const lines = [];
  let overflowNew = 0;
  let moved = 0;
  for (const k of Object.keys(after)) {
    const a = after[k];
    const b = before?.[k];
    if (!b) {
      lines.push(`${k}: no baseline`);
      continue;
    }
    if (a.scrollWidth > a.innerWidth + 1 && !(b.scrollWidth > b.innerWidth + 1)) {
      overflowNew++;
      lines.push(`${k}: NEW horizontal overflow ${a.scrollWidth}>${a.innerWidth}`);
    }
    for (const sel of Object.keys(a.boxes)) {
      const bb = b.boxes[sel];
      if (!bb) continue;
      const d = a.boxes[sel].map((v, i) => Math.abs(v - bb[i]));
      const container = !/h1|button/.test(sel);
      if (container && Math.max(...d) > 2) {
        moved++;
        lines.push(`${k} ${sel}: before ${bb.join(",")} after ${a.boxes[sel].join(",")}`);
      } else if (!container && Math.max(...d) > 2) {
        lines.push(`${k} ${sel} (text-sized, informational): before ${bb.join(",")} after ${a.boxes[sel].join(",")}`);
      }
    }
  }
  return { lines, overflowNew, moved };
}

// ------------------------------------------------------------------ threads

function readThreads() {
  const st = fs.existsSync(PERF_STATE) ? JSON.parse(fs.readFileSync(PERF_STATE, "utf8")) : {};
  return { codeThread: st.codeThread, longThread: st.longThread };
}

async function discover(page) {
  const firstHref = async (url, re) => {
    await open(page, url);
    return page.evaluate((src) => {
      const r = new RegExp(src);
      return [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")).find((h) => r.test(h)) || null;
    }, re.source);
  };
  const withLocale = (h) => (h ? (h.startsWith("/en") ? h : `/en${h}`) : null);
  return {
    project: withLocale(await firstHref("/en/projects", /\/projects\/[a-z0-9]{10,}/)),
    task: withLocale(await firstHref("/en/scheduled", /\/scheduled\/[a-z0-9]{10,}/)),
    connector: withLocale(await firstHref("/en/settings/connectors", /\/settings\/connectors\/[a-z0-9-]+$/)),
    share: await firstHref("/en/settings/shared", /\/share\/[A-Za-z0-9_-]{8,}/),
  };
}

// ------------------------------------------------------------------ the run

(async () => {
  const threads = readThreads();
  const before = fs.existsSync(path.join(OUT, "before.json")) ? JSON.parse(fs.readFileSync(path.join(OUT, "before.json"), "utf8")) : null;

  // ---------- Chromium: the primary engine, headed, with CDP ----------
  const browser = await chromium.launch({ headless: false });

  // PUBLIC, fresh context: perf on a cold cache + the toast + the public routes.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    wire(page, "chromium-public");
    await page.addInitScript(CLS_INIT);
    const fontsSeen = trackFonts(page);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");

    await step("[perf] /login cold: every font is self-hosted, no duplicates, no Devanagari, CLS ≤ 0.1", async () => {
      await open(page, "/en/login");
      await page.waitForTimeout(1500);
      const p = await page.evaluate(PERF_READ);
      const tagged = await page.evaluate(TAG_TEXT, MONO_ALLOW);
      await page.evaluate(UNTAG);
      const hosts = [...new Set(p.resources.map((r) => r.host))];
      const dupes = fontsSeen.map((f) => f.url).filter((u, i, a) => a.indexOf(u) !== i);
      const devFiles = Object.entries(tagged.files).filter(([, v]) => v.subset === "devanagari").map(([k]) => k);
      const devFetched = fontsSeen.filter((f) => devFiles.includes(f.url.split("/").pop()));
      const bytes = p.resources.reduce((n, r) => n + (r.bytes || 0), 0);
      report.perf = { ...report.perf, login: { files: p.resources.length, bytes, preloads: p.preloads.length, cls: p.cls, hosts, resources: p.resources, declared: tagged.files } };
      need(hosts.every((h) => h === new URL(BASE).host), `font hosts: ${hosts.join(",")}`);
      need(dupes.length === 0, `duplicate font requests: ${dupes.length}`);
      need(devFetched.length === 0, `Devanagari fetched on an English page: ${devFetched.map((f) => f.url.split("/").pop()).join(",")}`);
      need(p.cls <= 0.1, `CLS ${p.cls}`);
      notes.push(`[perf] /login: ${p.resources.length} font files, ${bytes} bytes, ${p.preloads.length} preload hints, CLS ${p.cls}; declared: ${Object.values(tagged.files).filter((v) => v.subset === "latin").length} latin / ${Object.values(tagged.files).filter((v) => v.subset === "latin-ext").length} latin-ext / ${devFiles.length} devanagari faces`);
      return `${p.resources.length} files · ${bytes} B · ${p.preloads.length} preloads · CLS ${p.cls} · hosts ${hosts.join(",")}`;
    });

    if (MODE !== "before") {
      await step("[public] /login — every glyph Poppins", async () => proveRoute(page, cdp, "/en/login", "chromium"));
      await step("[toast] a real Sonner toast renders in Poppins, over Sonner's injected font", async () => {
        expect400 = true;
        try {
          await page.locator('input[type="email"]').first().fill("font-probe-nobody@example.com");
          await page.locator('input[type="password"]').first().fill("not-a-real-password-1");
          await page.click('button[type="submit"]');
          await page.waitForSelector("[data-sonner-toast] [data-title]", { timeout: 20000 });
          await page.waitForTimeout(600);
          const r = await faceOf(page, cdp, "[data-sonner-toast] [data-title]");
          need(r, "toast title not found");
          need(/poppins/i.test(r.family), `toast computed family ${r.family}`);
          need(drawnWith(r, /^Poppins/), `toast drawn with ${faceString(r)}`);
          return `"${r.text}" → ${faceString(r)}`;
        } finally {
          await page.waitForTimeout(1500);
          expect400 = false;
        }
      });
      // Signed out, the public documents are reachable ONLY un-prefixed: `/en/slack`
      // is bounced to /login by the middleware (pre-existing, not a font matter).
      for (const route of ["/privacy", "/terms", "/support", "/slack"]) {
        await step(`[public] ${route}`, async () => {
          await open(page, route);
          need(!page.url().includes("/login"), `redirected to ${page.url()}`);
          return proveRoute(page, cdp, route, "chromium");
        });
      }
      await step("[mono inverse] OAuth scopes on /slack are still monospace", async () => {
        await open(page, "/slack");
        const r = await faceOf(page, cdp, "td.font-mono");
        need(r, "no scope cell");
        need(!/poppins/i.test(r.family), `scope cell became ${r.family}`);
        return `"${r.text}" → ${faceString(r)}`;
      });
    }
    await ctx.close();
  }

  if (MODE === "public") {
    await browser.close();
    return finish();
  }

  // SIGNED-IN, Chromium.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    wire(page, "chromium");
    await page.addInitScript(CLS_INIT);
    const fontsSeen = trackFonts(page);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    await login(page);
    const found = await discover(page);

    if (MODE === "before") {
      // Baseline: what current prod renders with, for the report + the diff.
      await step("[before] record current faces", async () => {
        await open(page, "/en/chat");
        const t = await page.evaluate(TAG_TEXT, MONO_ALLOW);
        await page.evaluate(UNTAG);
        const fams = [...new Set(t.nodes.filter((n) => !n.allowlisted).map((n) => n.family))];
        report.beforeFamilies = fams;
        const p = await page.evaluate(PERF_READ);
        report.perf = { ...report.perf, chat: { files: p.resources.length, bytes: p.resources.reduce((n, r) => n + (r.bytes || 0), 0), resources: p.resources } };
        return `UI families now: ${fams.join(" | ")} · ${p.resources.length} font files on /chat`;
      });
    } else {
      await step("[perf] /chat signed-in: font files + CLS", async () => {
        await open(page, "/en/chat");
        const p = await page.evaluate(PERF_READ);
        report.perf = { ...report.perf, chat: { files: p.resources.length, bytes: p.resources.reduce((n, r) => n + (r.bytes || 0), 0), cls: p.cls, resources: p.resources } };
        need(p.cls <= 0.1, `CLS ${p.cls}`);
        return `${p.resources.length} files · CLS ${p.cls}`;
      });

      const routes = [
        "/en/chat",
        threads.codeThread && `/en/chat/${threads.codeThread}`,
        threads.longThread && `/en/chat/${threads.longThread}`,
        "/en/projects", found.project,
        "/en/scheduled", found.task,
        "/en/files",
        "/en/settings", "/en/settings/appearance", "/en/settings/archived", "/en/settings/billing",
        "/en/settings/connectors", found.connector,
        "/en/settings/files", "/en/settings/memories", "/en/settings/personalization",
        "/en/settings/shared", "/en/settings/skills",
        found.share,
      ].filter(Boolean);
      for (const route of routes) {
        await step(`[route] ${route}`, async () => {
          await open(page, route);
          return proveRoute(page, cdp, route, "chromium");
        });
      }

      await step("[404] the 404 heading is Poppins, not the system mono stack", async () => {
        await open(page, "/en/this-route-does-not-exist");
        const r = await faceOf(page, cdp, "h1");
        need(r, "no h1");
        need(/404/.test(r.text), `h1 is "${r.text}" — not the 404 page`);
        need(/poppins/i.test(r.family) && drawnWith(r, /^Poppins/), `${r.family} / ${faceString(r)}`);
        return `"${r.text}" → ${faceString(r)}`;
      });

      await step("[dark] the same proof holds with the dark theme", async () => {
        await open(page, "/en/settings/skills");
        // Flip the class directly: a font cannot depend on the theme, and writing
        // the preference would push a theme change onto the shared QA account.
        await page.evaluate(() => {
          document.documentElement.classList.add("dark");
          document.documentElement.dataset.theme = "dark";
        });
        await page.waitForTimeout(600);
        const r = await proveRoute(page, cdp, "/en/settings/skills", "chromium-dark");
        await page.evaluate(() => {
          document.documentElement.classList.remove("dark");
          document.documentElement.dataset.theme = "light";
        });
        return r;
      });

      await step("[weights] 400 · 500 · 600 · 700 · 800 each resolve to their own Poppins file", async () => {
        await open(page, "/en/settings");
        const want = [
          ["p, span, div", "", /Poppins-Regular/, "400"],
          [".font-medium", "", /Poppins-Medium/, "500"],
          [".font-semibold", "", /Poppins-SemiBold/, "600"],
          [".font-bold", "", /Poppins-Bold/, "700"],
        ];
        const got = [];
        for (const [sel, , re, w] of want) {
          const r = await faceOfWeight(page, cdp, sel, w);
          need(r, `no visible ${sel} at weight ${w}`);
          need(drawnWith(r, re), `${sel} (weight ${w}) drawn with ${faceString(r)}`);
          got.push(`${w}→${r.fonts[0].postScriptName}`);
        }
        await open(page, "/en/chat");
        const brand = await faceOf(page, cdp, ".font-brand");
        need(brand && drawnWith(brand, /Poppins-ExtraBold/), `wordmark drawn with ${faceString(brand)}`);
        got.push(`800→${brand.fonts[0].postScriptName} (wordmark)`);
        return got.join(" · ");
      });

      // ---------- real content: chart, mermaid, italic, math, code ----------
      await step("[content] one reply with a chart, a mermaid diagram, *emphasis*, math and code", async () => {
        await open(page, "/en/chat");
        await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
        await page.locator("#chat-composer").fill(
          "Reply with exactly these five things and nothing else: (1) a ```chart fenced block rendering a bar chart of Jan 10, Feb 25, Mar 18; (2) a ```mermaid flowchart with two nodes: Start --> Finish; (3) one sentence that contains *an emphasised phrase* in asterisks; (4) the inline math $E = mc^2$; (5) a ```python code block with one print statement.",
        );
        await page.keyboard.press("Enter");
        await settle(page);
        await page.waitForTimeout(2500);
        const have = await page.evaluate(() => ({
          canvas: document.querySelectorAll("canvas").length,
          mermaid: document.querySelectorAll("svg[id^=mermaid], .mermaid svg, svg[aria-roledescription]").length,
          em: document.querySelectorAll("em").length,
          katex: document.querySelectorAll(".katex").length,
          pre: document.querySelectorAll("pre").length,
        }));
        report.content = have;
        need(have.em > 0, `no <em> rendered (${JSON.stringify(have)})`);
        return JSON.stringify(have);
      });

      await step("[italic] <em> from markdown is drawn with the real Poppins Italic, not a slant", async () => {
        const r = await faceOf(page, cdp, "em");
        need(r, "no em");
        need(r.style === "italic", `em style ${r.style}`);
        need(drawnWith(r, /Poppins-Italic|Poppins-\w+Italic/), `em drawn with ${faceString(r)}`);
        return `"${r.text}" → ${faceString(r)}`;
      });

      await step("[chart] Chart.js drew its labels with the Poppins stack at the configured size", async () => {
        const f = await page.evaluate(() => {
          const c = [...document.querySelectorAll("canvas")].pop();
          if (!c) return null;
          const ctx = c.getContext("2d");
          return ctx ? ctx.font : "no-ctx";
        });
        need(f, "no canvas — the model did not emit a chart fence");
        need(/poppins/i.test(f), `canvas font is "${f}"`);
        need(/\b1[0-9]px\b/.test(f), `canvas size not the configured 12px: "${f}"`);
        return `ctx.font = ${f.slice(0, 70)}`;
      });

      await step("[mermaid] diagram labels are Poppins", async () => {
        const r = await faceOf(page, cdp, "svg[id^=mermaid] text, svg[id^=mermaid] span, svg[id^=mermaid] p, .mermaid svg text, svg[aria-roledescription] text, svg[aria-roledescription] span, svg[aria-roledescription] p");
        need(r, "no mermaid label — the model did not emit a mermaid fence");
        need(/poppins/i.test(r.family), `mermaid label family ${r.family}`);
        need(drawnWith(r, /^Poppins/), `mermaid label drawn with ${faceString(r)}`);
        return `"${r.text}" → ${faceString(r)}`;
      });

      await step("[math] KaTeX keeps its math faces; the prose around it is Poppins", async () => {
        const k = await faceOf(page, cdp, ".katex .mord, .katex .mathnormal");
        need(k, "no katex — the model did not emit math");
        need(/katex/i.test(k.family), `katex family ${k.family}`);
        const p = await faceOf(page, cdp, "div.my-5 p");
        need(p && drawnWith(p, /^Poppins/), `prose drawn with ${faceString(p)}`);
        return `math ${k.family} · prose ${faceString(p)}`;
      });

      await step("[code] the block body stays Geist Mono; its language label is Poppins", async () => {
        const body = await faceOf(page, cdp, "pre code span, pre code");
        need(body, "no code block");
        need(/geist/i.test(body.family), `code body family ${body.family}`);
        const label = await faceOf(page, cdp, "span.uppercase.tracking-wide");
        need(label, "no language label");
        need(drawnWith(label, /^Poppins/), `label drawn with ${faceString(label)}`);
        return `body ${body.family} · label "${label.text}" → ${faceString(label)}`;
      });

      await step("[thread] the whole content thread, glyph by glyph", async () => proveRoute(page, cdp, page.url().replace(BASE, ""), "chromium-content"));

      // ---------- Devanagari: real text, real send ----------
      await step("[hindi] typed into the composer: the lazy Devanagari file arrives and draws the text", async () => {
        const before = fontsSeen.length;
        await page.locator("#chat-composer").fill(HINDI);
        await page.waitForTimeout(2500);
        await page.evaluate(() => document.fonts.ready);
        const tagged = await page.evaluate(TAG_TEXT, MONO_ALLOW);
        await page.evaluate(UNTAG);
        const devFiles = Object.entries(tagged.files).filter(([, v]) => v.subset === "devanagari").map(([k]) => k);
        const fetched = fontsSeen.slice(before).filter((f) => devFiles.includes(f.url.split("/").pop()));
        const st = await page.evaluate(FONT_STATUS);
        const devLoaded = st.filter((f) => f.dev && f.status === "loaded");
        need(devFiles.length >= 4, `only ${devFiles.length} Devanagari faces declared`);
        need(fetched.length >= 1, `no Devanagari file was fetched after typing Hindi (declared: ${devFiles.join(",")})`);
        need(devLoaded.length >= 1, "no Devanagari face reports loaded");
        const m = await page.evaluate(METRICS, HINDI);
        need(Math.abs(m.page - m.sans) > 2, `Hindi width in page family (${m.page}) equals sans-serif (${m.sans}) — system Devanagari in use`);
        report.hindi = { declared: devFiles, fetched: fetched.map((f) => ({ file: f.url.split("/").pop(), status: f.status, len: f.len })) };
        return `${devFiles.length} faces declared · fetched ${fetched.map((f) => `${f.url.split("/").pop()} ${f.status} ${f.len}B`).join(", ")} · width page ${m.page.toFixed(1)} vs sans ${m.sans.toFixed(1)}`;
      });

      await step("[hindi] sent: the user bubble and the reply are drawn with Poppins Devanagari, every glyph", async () => {
        await page.keyboard.press("Enter");
        await page.waitForFunction((t) => document.body.innerText.includes(t.slice(0, 12)), HINDI, { timeout: 15000 });
        await settle(page);
        await page.waitForTimeout(2000);
        await page.evaluate(() => document.fonts.ready);
        const bubble = await faceOf(page, cdp, "p", "नमस्ते");
        need(bubble, "user bubble with Hindi not found");
        need(drawnWith(bubble, /^Poppins/), `bubble drawn with ${faceString(bubble)}`);
        const devGlyphs = bubble.fonts.reduce((n, f) => n + f.glyphCount, 0);
        need(devGlyphs >= 30, `only ${devGlyphs} glyphs counted for the bubble`);
        // The reply: any element whose own text has Devanagari.
        const reply = await faceOfDevanagari(page, cdp);
        const r = reply ? `reply "${reply.text}" → ${faceString(reply)}` : "reply had no Devanagari (model answered in Latin)";
        if (reply) need(drawnWith(reply, /^Poppins/), `reply drawn with ${faceString(reply)}`);
        report.hindiBubble = { faces: faceString(bubble), glyphs: devGlyphs, reply: r };
        return `bubble ${devGlyphs} glyphs → ${faceString(bubble)} · ${r}`;
      });

      await step("[hindi] the whole Hindi thread, glyph by glyph", async () => proveRoute(page, cdp, page.url().replace(BASE, ""), "chromium-hindi"));
    }
    await ctx.close();
  }

  // ---------- visual regression capture (both modes) ----------
  const cap = await captureAreas(browser, threads, MODE);
  report.areas = cap;
  if (MODE === "before") {
    fs.writeFileSync(path.join(OUT, "before.json"), JSON.stringify({ areas: cap, perf: report.perf, families: report.beforeFamilies }, null, 2));
    console.log(`      baseline written: ${Object.keys(cap).length} area×viewport captures`);
  } else {
    await step("[visual] before/after: no container moved > 2px, no new horizontal overflow", async () => {
      need(before, "no before.json — run --mode before first");
      const d = diffAreas(before.areas, cap);
      for (const l of d.lines) console.log(`      ${l}`);
      report.visualDiff = d;
      need(d.overflowNew === 0, `${d.overflowNew} new overflow(s)`);
      need(d.moved === 0, `${d.moved} container(s) moved`);
      return `${Object.keys(cap).length} pairs compared · ${d.lines.length} informational line(s)`;
    });
    await step("[perf] transfer before → after", async () => {
      const b = before?.perf?.login;
      const a = report.perf?.login;
      need(a, "no after perf");
      const line = `before: ${b?.files ?? "?"} files / ${b?.bytes ?? "?"} B / CLS ${b?.cls ?? "?"} → after: ${a.files} files / ${a.bytes} B / CLS ${a.cls}`;
      notes.push(`[perf] ${line}`);
      return line;
    });
  }
  await browser.close();

  if (MODE === "before") return finish();

  // ---------- other engines ----------
  const engineRoutes = ["/en/login", "/en/chat", threads.codeThread && `/en/chat/${threads.codeThread}`, "/en/settings/skills"].filter(Boolean);
  const matrix = [
    ["webkit", () => webkit.launch(), {}],
    ["firefox", () => firefox.launch(), {}],
    ["mobile-safari", () => webkit.launch(), { ...devices["iPhone 14"], isMobile: undefined, defaultBrowserType: undefined }],
    ["mobile-chrome", () => chromium.launch(), { ...devices["Pixel 7"], defaultBrowserType: undefined }],
  ].filter(([n]) => ENGINES.includes(n));
  for (const [name, launch, ctxOpts] of matrix) {
    let b;
    try {
      b = await launch();
    } catch (e) {
      await step(`[${name}] engine available`, async () => {
        throw new Error(`could not launch: ${String(e.message).split("\n")[0]}`);
      });
      continue;
    }
    const opts = { ...ctxOpts };
    for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
    const ctx = await b.newContext(opts);
    const page = await ctx.newPage();
    wire(page, name);
    let cdp = null;
    if (name === "mobile-chrome") {
      cdp = await ctx.newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
    }
    report.engines[name] = {};
    for (const route of engineRoutes) {
      await step(`[${name}] ${route}`, async () => {
        if (route !== "/en/login" && !page.url().includes("/chat") && !page.url().includes("/settings")) await login(page);
        await open(page, route);
        const r = await proveRoute(page, cdp, route, name);
        report.engines[name][route] = report.routes[`${name}:${route}`];
        return r;
      });
    }
    await step(`[${name}] Hindi in the composer is drawn with a Poppins Devanagari face`, async () => {
      await open(page, "/en/chat");
      await page.locator("#chat-composer").fill(HINDI);
      await page.waitForTimeout(2500);
      await page.evaluate(() => document.fonts.ready);
      const st = await page.evaluate(FONT_STATUS);
      const dev = st.filter((f) => f.dev && f.status === "loaded");
      const m = await page.evaluate(METRICS, HINDI);
      need(dev.length >= 1, `no Devanagari face loaded (${st.filter((f) => f.dev).map((f) => f.status).join(",")})`);
      need(Math.abs(m.page - m.sans) > 2, `Hindi width equals sans-serif fallback`);
      await page.locator("#chat-composer").fill("");
      return `${dev.length} Devanagari face(s) loaded · width ${m.page.toFixed(1)} vs sans ${m.sans.toFixed(1)}`;
    });
    await ctx.close();
    await b.close();
  }
  return finish();

  function finish() {
    const pass = results.filter(Boolean).length;
    console.log(`\n${pass}/${results.length} passed · console errors: ${errs.length}`);
    for (const e of errs.slice(0, 10)) console.log(`  ERR ${e}`);
    for (const n of notes) console.log(`  NOTE ${n}`);
    report.pass = pass;
    report.total = results.length;
    report.consoleErrors = errs;
    fs.writeFileSync(path.join(OUT, `${MODE}.json`), JSON.stringify(report, null, 2));
    process.exit(pass === results.length && errs.length === 0 ? 0 : 1);
  }
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});

/** First visible element matching `sel` whose computed weight is `w`, and its platform fonts. */
async function faceOfWeight(page, cdp, sel, w) {
  const i = await page.evaluate(
    ([s, weight, MONO_ALLOW]) => {
      const el = [...document.querySelectorAll(s)].find((e) => {
        const r = e.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0) || e.closest(MONO_ALLOW)) return false;
        const own = [...e.childNodes].filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join("").trim();
        return own.length > 2 && getComputedStyle(e).fontWeight === weight && getComputedStyle(e).fontStyle === "normal";
      });
      if (!el) return null;
      document.querySelectorAll("[data-qf]").forEach((e) => e.removeAttribute("data-qf"));
      el.setAttribute("data-qf", "0");
      return { tag: el.tagName.toLowerCase(), text: el.textContent.trim().slice(0, 30), family: getComputedStyle(el).fontFamily.split(",")[0] };
    },
    [sel, w, MONO_ALLOW],
  );
  if (!i) return null;
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const fonts = await platformFonts(cdp, root.nodeId, 0);
  await page.evaluate(UNTAG);
  return { ...i, fonts };
}

/** First visible element in the LAST assistant row whose own text has Devanagari. */
async function faceOfDevanagari(page, cdp) {
  const i = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    const last = rows[rows.length - 1];
    if (!last) return null;
    const el = [...last.querySelectorAll("*")].find((e) => {
      const own = [...e.childNodes].filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join("");
      return /[ऀ-ॿ]/.test(own) && e.getBoundingClientRect().height > 0;
    });
    if (!el) return null;
    document.querySelectorAll("[data-qf]").forEach((e) => e.removeAttribute("data-qf"));
    el.setAttribute("data-qf", "0");
    return { tag: el.tagName.toLowerCase(), text: el.textContent.trim().slice(0, 30), family: getComputedStyle(el).fontFamily.split(",")[0] };
  });
  if (!i) return null;
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const fonts = await platformFonts(cdp, root.nodeId, 0);
  await page.evaluate(UNTAG);
  return { ...i, fonts };
}
