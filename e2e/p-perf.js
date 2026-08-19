// Navigation / load performance harness, in the house style: standalone node
// script, hand-rolled step harness, hard assertion of zero console errors.
//
// It is a MEASUREMENT tool first and a regression gate second. Every number it
// prints is a median over N runs so a single slow sample cannot be mistaken for
// a trend, and every run gets a brand-new browser context so the HTTP cache
// never makes the second measurement look like an improvement.
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
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i === -1 ? d : process.argv[i + 1];
};
const LABEL = arg("label", "run");
const RUNS = Number(arg("runs", 7));
const OUT = path.join(__dirname, ".perf");

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

// Collect console errors + failed responses on every page we open. The suite
// fails on any of them, which is what makes a perf run double as a smoke test.
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

// Walk response.request().redirectedFrom() back to the first hop so we can
// report the chain length, which is the thing the audit is actually about.
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

  // Measurement, not just setup: does signing in navigate on its own? The audit
  // found no router.push after signIn(), and p-chat.js works around it with a
  // fixed 3.5s wait plus an explicit goto. Time how long the app takes to leave
  // /login unaided, and record whether it ever does.
  const t0 = Date.now();
  await page.click('button[type="submit"]');
  let autoNavMs = null;
  try {
    await page.waitForURL((u) => !/login/.test(u.pathname), { timeout: 15000 });
    autoNavMs = Date.now() - t0;
  } catch {
    /* stayed on /login - recorded as null */
  }

  // Whatever happened above, make sure we really are authenticated before
  // saving the state the rest of the runs reuse.
  await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 30000 });
  const state = await ctx.storageState();
  await ctx.close();
  return { state, autoNavMs };
}

// One cold run: brand-new context (so empty HTTP cache and empty memory cache)
// carrying the saved auth state.
async function coldRun(browser, state, url) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: state,
  });
  const page = await ctx.newPage();
  watch(page);

  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");

  // Long tasks -> total blocking time. Installed before navigation so it sees
  // the hydration burst, which is the whole point.
  await page.addInitScript(() => {
    window.__lt = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__lt.push(e.duration);
      }).observe({ type: "longtask", buffered: true });
    } catch {}
  });

  const resp = await page.goto(BASE + url, { waitUntil: "domcontentloaded" });
  const chain = chainOf(resp);

  // Time to the two things the user actually waits for on /chat: the rail
  // having threads, and the composer becoming usable (it renders disabled with
  // "Preparing your workspace..." until the workspace query lands).
  const tNav = Date.now();
  let railMs = null;
  let composerMs = null;
  try {
    await page.waitForSelector('a[href^="/chat/"]', { timeout: 30000 });
    railMs = Date.now() - tNav;
  } catch {}
  try {
    await page.waitForSelector("#chat-composer:not([disabled])", {
      timeout: 30000,
    });
    composerMs = Date.now() - tNav;
  } catch {}

  await page.waitForLoadState("load").catch(() => {});
  // Let post-hydration lazy chunks (three.js, framer features) land so the byte
  // count reflects what the browser really pulls, not just first-load JS.
  await page.waitForTimeout(2500);

  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] || {};
    const res = performance.getEntriesByType("resource");
    const js = res.filter(
      (r) => r.initiatorType === "script" || /\.js(\?|$)/.test(r.name),
    );
    const sum = (a, f) => a.reduce((x, r) => x + (f(r) || 0), 0);
    return {
      responseStart: nav.responseStart,
      domContentLoaded: nav.domContentLoadedEventEnd,
      loadEventEnd: nav.loadEventEnd,
      jsRequests: js.length,
      jsTransfer: sum(js, (r) => r.transferSize),
      jsDecoded: sum(js, (r) => r.decodedBodySize),
      allRequests: res.length,
      allTransfer: sum(res, (r) => r.transferSize),
      tbt: (window.__lt || []).reduce((a, d) => a + Math.max(0, d - 50), 0),
      longTasks: (window.__lt || []).length,
    };
  });

  const metrics = Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((x) => [
      x.name,
      x.value,
    ]),
  );

  // Client-side route transition: rail click -> that thread's transcript.
  let transitionMs = null;
  try {
    const links = page.locator('a[href^="/chat/"]');
    if ((await links.count()) > 0) {
      const t = Date.now();
      await links.first().click();
      await page.waitForFunction(
        () => /\/chat\/.+/.test(location.pathname),
        undefined,
        { timeout: 15000 },
      );
      await page.waitForSelector("main", { timeout: 15000 });
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
    agg[url] = {
      hops: runs[0].hops,
      chain: runs[0].chain,
      jsRequests: runs[0].jsRequests,
      allRequests: runs[0].allRequests,
      jsTransferKB: Math.round(median(pick("jsTransfer")) / 1024),
      jsDecodedKB: Math.round(median(pick("jsDecoded")) / 1024),
      allTransferKB: Math.round(median(pick("allTransfer")) / 1024),
    };
    for (const k of [
      "responseStart",
      "domContentLoaded",
      "loadEventEnd",
      "railMs",
      "composerMs",
      "transitionMs",
      "tbt",
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
    ["rail populated", "railMs"],
    ["composer enabled", "composerMs"],
    ["route transition", "transitionMs"],
    ["total blocking time", "tbt"],
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
