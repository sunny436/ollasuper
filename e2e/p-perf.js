// Navigation / load performance harness, in the house style: standalone node
// script, hand-rolled step harness, hard assertion of zero console errors.
//
// It is a MEASUREMENT tool first and a regression gate second. Every number it
// prints is a median (and p90) over N runs so a single slow sample cannot be
// mistaken for a trend, and every run gets a brand-new browser context so the
// HTTP cache never makes the second measurement look like an improvement.
//
// READINESS-RELATIVE by construction: the clock starts BEFORE page.goto, and the
// thing the user waits for is the ENABLED composer. Everything is timed from
// navigation start, total blocking time is split at composer-ready, and scripts
// are bucketed into "requested before readiness" vs "after", so decorative/lazy
// chunks that land after the composer is usable never inflate the readiness gate.
//
//   E2E_BASE_URL=https://app.ollasuper.com node p-perf.js --label baseline
//   node p-perf.js --label after --runs 7
//
// Results are written to e2e/.perf/<label>.json.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i === -1 ? d : process.argv[i + 1];
};
const LABEL = arg("label", "run");
const RUNS = Number(arg("runs", 7));
const OUT = path.join(__dirname, ".perf");
const POST_READY_MS = 2000; // the window we report SEPARATELY, after readiness

const errs = [];
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const p90 = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)];
};
const ms = (v) => (v == null ? "  n/a" : String(Math.round(v)).padStart(5));

function watch(page) {
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) {
      errs.push("HTTP " + r.status() + " " + r.url());
    }
  });
}

function chainOf(response) {
  const hops = [];
  let req = response ? response.request() : null;
  while (req) {
    hops.unshift(req.url().replace(BASE, "") || "/");
    req = req.redirectedFrom();
  }
  return hops;
}

async function login(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);

  const t0 = Date.now();
  await page.click('button[type="submit"]');
  let autoNavMs = null;
  try {
    await page.waitForURL((u) => !/login/.test(u.pathname), { timeout: 15000 });
    autoNavMs = Date.now() - t0;
  } catch {
    /* stayed on /login - recorded as null */
  }

  await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 30000 });
  const state = await ctx.storageState();
  await ctx.close();
  return { state, autoNavMs };
}

// One cold run: brand-new context (empty HTTP + memory cache) carrying the saved
// auth state. The readiness clock starts BEFORE navigation.
async function coldRun(browser, state, url) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: state,
  });
  const page = await ctx.newPage();
  watch(page);

  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");

  // Long tasks -> total blocking time. Installed before navigation so it sees the
  // hydration burst. Each entry keeps its startTime (relative to navigationStart)
  // so TBT can be split at composer-ready.
  await page.addInitScript(() => {
    window.__lt = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries())
          window.__lt.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: "longtask", buffered: true });
    } catch {}
  });

  // The Convex browser socket. First open, measured from navigation start.
  const tStart = Date.now();
  let wsOpenMs = null;
  page.on("websocket", () => {
    if (wsOpenMs === null) wsOpenMs = Date.now() - tStart;
  });

  const resp = await page.goto(BASE + url, { waitUntil: "domcontentloaded" });
  const chain = chainOf(resp);

  // The two readiness milestones, BOTH relative to navigation start (tStart):
  // the composer first RENDERS (disabled, "Preparing your workspace...") and then
  // becomes ENABLED (workspace query landed) — the moment the user can type.
  let firstComposerMs = null;
  let composerMs = null;
  let railMs = null;
  let readyPerf = null; // page-time (performance.now()) at composer-enabled
  try {
    await page.waitForSelector("#chat-composer", { timeout: 30000 });
    firstComposerMs = Date.now() - tStart;
  } catch {}
  try {
    await page.waitForSelector('a[href^="/chat/"]', { timeout: 30000 });
    railMs = Date.now() - tStart;
  } catch {}
  try {
    await page.waitForSelector("#chat-composer:not([disabled])", {
      timeout: 30000,
    });
    composerMs = Date.now() - tStart;
    readyPerf = await page.evaluate(() => performance.now());
  } catch {}

  await page.waitForLoadState("load").catch(() => {});
  // Let post-readiness lazy chunks land so we can report them SEPARATELY (they
  // must not count against the readiness gate).
  await page.waitForTimeout(POST_READY_MS);

  const m = await page.evaluate(
    ({ cutoff, postMs }) => {
      const nav = performance.getEntriesByType("navigation")[0] || {};
      const res = performance.getEntriesByType("resource");
      const isJs = (r) =>
        r.initiatorType === "script" || /\.js(\?|$)/.test(r.name);
      const sum = (a, f) => a.reduce((x, r) => x + (f(r) || 0), 0);
      // A null cutoff (composer never enabled) buckets everything as "before" so
      // a broken run reads as heavy, never as a false "0 after".
      const cut = cutoff == null ? Infinity : cutoff;
      const js = res.filter(isJs);
      const jsBefore = js.filter((r) => r.startTime <= cut);
      const jsAfter = js.filter((r) => r.startTime > cut);
      const lt = window.__lt || [];
      const blocking = (arr) => arr.reduce((a, e) => a + Math.max(0, e.dur - 50), 0);
      return {
        responseStart: nav.responseStart,
        domContentLoaded: nav.domContentLoadedEventEnd,
        loadEventEnd: nav.loadEventEnd,
        jsRequests: js.length,
        jsTransfer: sum(js, (r) => r.transferSize),
        jsDecoded: sum(js, (r) => r.decodedBodySize),
        jsBeforeRequests: jsBefore.length,
        jsBeforeTransfer: sum(jsBefore, (r) => r.transferSize),
        jsBeforeDecoded: sum(jsBefore, (r) => r.decodedBodySize),
        jsAfterRequests: jsAfter.length,
        jsAfterTransfer: sum(jsAfter, (r) => r.transferSize),
        allRequests: res.length,
        allTransfer: sum(res, (r) => r.transferSize),
        // TBT only within the readiness window (nav start -> composer-ready)...
        tbtToReady: blocking(lt.filter((e) => e.start <= cut)),
        // ...and a SEPARATE post-ready window, so decorative work is visible but
        // never inflates the gate.
        tbtPostReady: blocking(
          lt.filter((e) => e.start > cut && e.start <= cut + postMs),
        ),
        longTasks: lt.length,
      };
    },
    { cutoff: readyPerf, postMs: POST_READY_MS },
  );

  const metrics = Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((x) => [
      x.name,
      x.value,
    ]),
  );

  // Client-side route transition: rail click -> that thread is fully ready. END
  // on the real destination signals — URL is /chat/<id>, a transcript bubble is
  // present, and the composer is enabled again — NOT on a <main> the full-bleed
  // chat route never renders (the old harness hung here).
  let transitionMs = null;
  try {
    const links = page.locator('a[href^="/chat/"]');
    if ((await links.count()) > 0) {
      const t = Date.now();
      await links.first().click();
      await page.waitForFunction(() => /\/chat\/.+/.test(location.pathname), undefined, {
        timeout: 15000,
      });
      await page.waitForSelector("[data-message-role]", { timeout: 15000 });
      await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 15000 });
      transitionMs = Date.now() - t;
    }
  } catch {}

  await ctx.close();
  return {
    hops: chain.length,
    chain,
    ...m,
    scriptDuration: (metrics.ScriptDuration || 0) * 1000,
    layoutDuration: (metrics.LayoutDuration || 0) * 1000,
    recalcStyleDuration: (metrics.RecalcStyleDuration || 0) * 1000,
    transitionMs,
    wsOpenMs,
    firstComposerMs,
    railMs,
    composerMs,
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
  });

  console.log(
    "\n=== p-perf  base=" + BASE + "  label=" + LABEL + "  runs=" + RUNS + " ===\n",
  );
  const { state, autoNavMs } = await login(browser);
  console.log(
    "login -> auto-navigate away from /login: " +
      (autoNavMs === null ? "NEVER (stayed on /login)" : autoNavMs + " ms"),
  );

  const samples = { "/": [], "/chat": [] };
  for (const url of Object.keys(samples)) {
    for (let i = 0; i < RUNS; i++) {
      samples[url].push(await coldRun(browser, state, url));
      process.stdout.write("  " + url + " run " + (i + 1) + "/" + RUNS + "\r");
    }
    console.log("  " + url + " done            ");
  }
  await browser.close();

  const agg = {};
  for (const [url, runs] of Object.entries(samples)) {
    const pick = (k) => runs.map((r) => r[k]).filter((v) => v != null);
    const medKB = (k) => Math.round(median(pick(k)) / 1024);
    agg[url] = {
      hops: runs[0].hops,
      chain: runs[0].chain,
      jsRequests: runs[0].jsRequests,
      allRequests: runs[0].allRequests,
      jsTransferKB: medKB("jsTransfer"),
      jsDecodedKB: medKB("jsDecoded"),
      allTransferKB: medKB("allTransfer"),
      // The readiness split — the headline of the corrected harness.
      jsBeforeReadyReqs: Math.round(median(pick("jsBeforeRequests"))),
      jsBeforeReadyTransferKB: medKB("jsBeforeTransfer"),
      jsBeforeReadyDecodedKB: medKB("jsBeforeDecoded"),
      jsAfterReadyReqs: Math.round(median(pick("jsAfterRequests"))),
      jsAfterReadyTransferKB: medKB("jsAfterTransfer"),
    };
    for (const k of [
      "responseStart",
      "domContentLoaded",
      "loadEventEnd",
      "wsOpenMs",
      "firstComposerMs",
      "railMs",
      "composerMs",
      "transitionMs",
      "tbtToReady",
      "tbtPostReady",
      "scriptDuration",
      "layoutDuration",
      "recalcStyleDuration",
      "longTasks",
    ]) {
      agg[url][k] = median(pick(k));
      agg[url][k + "_p90"] = p90(pick(k));
    }
  }

  const result = {
    label: LABEL,
    base: BASE,
    runs: RUNS,
    at: new Date().toISOString(),
    autoNavMs,
    agg,
  };
  fs.writeFileSync(
    path.join(OUT, LABEL + ".json"),
    JSON.stringify(result, null, 2),
  );

  const ROWS = [
    ["responseStart (TTFB)", "responseStart"],
    ["domContentLoaded", "domContentLoaded"],
    ["loadEventEnd", "loadEventEnd"],
    ["websocket open", "wsOpenMs"],
    ["composer rendered", "firstComposerMs"],
    ["rail populated", "railMs"],
    ["composer ENABLED", "composerMs"],
    ["route transition", "transitionMs"],
    ["TBT to ready", "tbtToReady"],
    ["TBT post-ready 2s", "tbtPostReady"],
    ["script duration", "scriptDuration"],
    ["layout duration", "layoutDuration"],
    ["recalc style", "recalcStyleDuration"],
  ];
  for (const [url, a] of Object.entries(agg)) {
    console.log(
      "\n--- " + url + "  (" + a.hops + " hop(s): " + a.chain.join(" -> ") + ") ---",
    );
    console.log(
      "    JS " + a.jsRequests + " reqs, " + a.jsTransferKB + " KB transferred, " +
        a.jsDecodedKB + " KB decoded | all " + a.allRequests + " reqs, " +
        a.allTransferKB + " KB",
    );
    console.log(
      "    before-ready JS: " + a.jsBeforeReadyReqs + " reqs, " +
        a.jsBeforeReadyTransferKB + " KB / " + a.jsBeforeReadyDecodedKB +
        " KB decoded  |  after-ready: " + a.jsAfterReadyReqs + " reqs, " +
        a.jsAfterReadyTransferKB + " KB",
    );
    for (const [name, k] of ROWS) {
      console.log(
        "    " + name.padEnd(22) + ms(a[k]) + " ms   (p90 " + ms(a[k + "_p90"]) + ")",
      );
    }
  }

  console.log("\nconsole errors / failed responses: " + errs.length);
  for (const e of [...new Set(errs)].slice(0, 10))
    console.log("  ! " + e.slice(0, 160));
  console.log("\nwrote " + path.join(OUT, LABEL + ".json") + "\n");
  process.exit(errs.length ? 1 : 0);
})();
