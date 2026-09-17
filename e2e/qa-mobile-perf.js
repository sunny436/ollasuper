// qa-mobile-perf.js — mobile performance, network, memory and battery harness.
//
// Measures the deployed app (default https://app.ollasuper.com) the way the mobile
// investigation did, so every fix has a before -> after number from the SAME code:
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-mobile-perf.js --mode perf    --label baseline
//   node qa-mobile-perf.js --mode network --label baseline
//   node qa-mobile-perf.js --mode memory  --label baseline [--cycles 20]
//   node qa-mobile-perf.js --mode battery --label baseline            (runs headed)
//   node qa-mobile-perf.js --mode seed    --count 100                 (builds the long thread)
//   node qa-mobile-perf.js --mode compare --label after --against baseline
//
// Every figure is a median over --runs (default 3). Results: e2e/out/mobile-perf/<label>-<mode>.json.
// EMULATION, NOT PHONES: Chromium device emulation + CPU/network throttling, and
// Playwright WebKit (not iOS). Real-device numbers come from the ?perf=1 probe.
//
// One login at a time: the QA account enforces a single active session, so never
// run two modes in parallel. Uses generations (streaming runs, seed) — the account
// is capped at 120 per hour.
const { chromium, webkit, devices } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const MODE = arg("mode", "perf");
const LABEL = arg("label", "run");
const RUNS = Number(arg("runs", 3));
const CYCLES = Number(arg("cycles", 20));
const OUT = path.join(__dirname, "out", "mobile-perf");
fs.mkdirSync(OUT, { recursive: true });
const STATE = path.join(OUT, "state.json"); // long thread id, discovered ids
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

const SLOW4G = { offline: false, latency: 150, downloadThroughput: 1638400 / 8, uploadThroughput: 750000 / 8 };
const FAST4G = { offline: false, latency: 40, downloadThroughput: 9000000 / 8, uploadThroughput: 1500000 / 8 };
const HIGHLAT = { offline: false, latency: 800, downloadThroughput: 1000000 / 8, uploadThroughput: 500000 / 8 };
const OFFLINE = { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 };
const NO_THROTTLE = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };

const LONG_PROMPT =
  "Explain TCP congestion control (slow start, AIMD, fast recovery, CUBIC, BBR) in about 500 words with one markdown comparison table and two short Python code blocks.";
const SHORT_PROMPT = "Reply with exactly the word ok.";
const TYPE_TEXT = "Explain how photosynthesis converts light into energy";

const errs = [];
const median = (a) => {
  const s = a.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
};
const pct = (a, p) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]) : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// Installed in every page: long tasks, event timing, first <pre>, rAF + WebGL counters.
const INIT = () => {
  window.__lt = [];
  window.__et = [];
  window.__rafCalls = 0;
  window.__glDraws = 0;
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__et.push([e.name, e.duration]);
    }).observe({ type: "event", buffered: false, durationThreshold: 16 });
  } catch {}
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => {
    window.__rafCalls++;
    cb(t);
  });
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    for (const fn of ["drawElements", "drawArrays"]) {
      const orig = C.prototype[fn];
      C.prototype[fn] = function (...args) {
        window.__glDraws++;
        return orig.apply(this, args);
      };
    }
  }
  new MutationObserver(() => {
    if (!window.__firstPreAt && document.querySelector("pre")) window.__firstPreAt = performance.now();
  }).observe(document, { childList: true, subtree: true });
};

function watch(page, tag) {
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(`[${tag}] ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => errs.push(`[${tag}] pageerror ${e.message.slice(0, 200)}`));
}

async function login(browserType, contextOptions, tag) {
  const browser = await browserType.launch({ headless: MODE !== "battery" });
  const context = await browser.newContext(contextOptions);
  await context.addInitScript(INIT);
  const page = await context.newPage();
  watch(page, tag);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/login?perf=0`, { waitUntil: "load" });
    await page.waitForTimeout(4000); // hydration: inputs filled earlier are reset by React
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL(/\/chat/, { timeout: 60000, waitUntil: "commit" });
      await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 60000 });
      return { browser, context, page };
    } catch {
      log(`  login attempt ${attempt} failed; retrying in 20s`);
      await sleep(20000);
    }
  }
  throw new Error("login failed 3 times");
}

async function cdpFor(context, page) {
  return context.newCDPSession(page);
}

/** Compositor (viz) and main-thread busy ms while `fn` runs (Chromium tracing). */
async function traceBusy(cdp, fn) {
  const chunks = [];
  const done = new Promise((res) => cdp.once("Tracing.tracingComplete", res));
  await cdp.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: { includedCategories: ["toplevel", "disabled-by-default-devtools.timeline.frame", "__metadata", "viz"] },
  });
  await fn();
  await cdp.send("Tracing.end");
  const { stream } = await done;
  for (;;) {
    const r = await cdp.send("IO.read", { handle: stream, size: 1 << 20 });
    chunks.push(r.base64Encoded ? Buffer.from(r.data, "base64").toString() : r.data);
    if (r.eof) break;
  }
  await cdp.send("IO.close", { handle: stream });
  const parsed = JSON.parse(chunks.join(""));
  const ev = Array.isArray(parsed) ? parsed : parsed.traceEvents;
  const names = {};
  for (const e of ev) {
    const n = e.args?.data?.threadName || (e.name === "thread_name" && e.args?.name);
    if (n) names[`${e.pid}:${e.tid}`] = n;
  }
  let viz = 0;
  let main = 0;
  let frames = 0;
  for (const e of ev) {
    if (e.name === "DrawFrame") frames++;
    if (e.ph === "X" && e.dur > 0 && /RunTask/.test(e.name)) {
      const t = names[`${e.pid}:${e.tid}`] || "";
      if (/VizCompositor/.test(t)) viz += e.dur / 1000;
      if (/CrRendererMain/.test(t)) main += e.dur / 1000;
    }
  }
  return { vizMs: Math.round(viz), mainMs: Math.round(main), frames };
}

/** input event -> frame after handlers, per keystroke. */
async function typingLatency(page, text, delay = 80) {
  await page.evaluate(() => {
    window.__typing = [];
    window.__et = [];
    if (!window.__typingHooked) {
      window.__typingHooked = true;
      document.addEventListener(
        "input",
        (e) => {
          const t = e.timeStamp;
          requestAnimationFrame(() => setTimeout(() => window.__typing.push(performance.now() - t), 0));
        },
        { capture: true, passive: true },
      );
    }
  });
  await page.locator("#chat-composer").click();
  await page.keyboard.type(text, { delay });
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => ({
    lat: window.__typing,
    et: window.__et.filter(([n]) => /key|input|beforeinput/.test(n)).map(([, d]) => d),
  }));
  await page.locator("#chat-composer").fill("");
  return r;
}

/** rAF frame stats while `fn` runs (both engines). */
async function frameStats(page, fn) {
  await page.evaluate(() => {
    window.__frames = [];
    window.__frameOn = true;
    let last = -1;
    const tick = (t) => {
      if (last >= 0) window.__frames.push(t - last);
      last = t;
      if (window.__frameOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await fn();
  const deltas = await page.evaluate(() => {
    window.__frameOn = false;
    return window.__frames;
  });
  const sorted = [...deltas].sort((a, b) => a - b);
  const refresh = Math.max(4, Math.min(34, sorted[Math.floor(sorted.length * 0.1)] || 16.7));
  const dropped = deltas.filter((d) => d > refresh * 1.5).length;
  return {
    frames: deltas.length,
    droppedPct: deltas.length ? Math.round((dropped / deltas.length) * 1000) / 10 : null,
    stalls: deltas.filter((d) => d > 50).length,
    maxFrameMs: Math.round(sorted[sorted.length - 1] || 0),
    refreshMs: Math.round(refresh * 10) / 10,
  };
}

async function longTasksSince(page, t0) {
  return page.evaluate((since) => {
    const lt = window.__lt.filter(([s]) => s >= since).map(([, d]) => d);
    return {
      count: lt.length,
      totalMs: Math.round(lt.reduce((a, b) => a + b, 0)),
      maxMs: Math.round(Math.max(0, ...lt)),
      tbtMs: Math.round(lt.reduce((a, d) => a + Math.max(0, d - 50), 0)),
    };
  }, t0);
}

async function waitDone(page, maxMs = 240000) {
  const stop = page.getByRole("button", { name: "Stop generating" });
  await page.waitForTimeout(1500);
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(500);
    if ((await stop.count()) === 0) return true;
  }
  return false;
}

async function lastAnswerText(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    return rows[rows.length - 1]?.querySelector("[aria-live]")?.innerText || "";
  });
}

async function send(page, text) {
  await page.locator("#chat-composer").fill(text);
  const t0 = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: "Send message" }).click();
  const firstTokenMs = await page
    .waitForFunction(
      (since) => {
        const el = document.querySelector('[aria-live="polite"][aria-busy="true"]');
        return el && (el.textContent || "").trim().length > 0 ? performance.now() - since : null;
      },
      t0,
      { timeout: 180000, polling: 50 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  return { t0, firstTokenMs: firstTokenMs == null ? null : Math.round(firstTokenMs) };
}

async function discoverIds(page) {
  if (state.codeThread && state.plainThread) return;
  await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 60000 });
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('a[href*="/chat/"]')].map((a) => ({ href: a.getAttribute("href"), text: a.textContent || "" })),
  );
  const code = links.find((l) => /TCP|congestion/i.test(l.text));
  const plain = links.find((l) => /mutex|SSRF|photosynthesis/i.test(l.text)) || links[1];
  if (code) state.codeThread = code.href.split("/").pop();
  if (plain) state.plainThread = plain.href.split("/").pop();
  saveState();
}

// --------------------------------------------------------------------------- perf
const PERF_PROFILES = [
  { name: "pixel7-4x", type: chromium, ctx: { ...devices["Pixel 7"] }, cpu: 4, net: SLOW4G },
  { name: "lowend-6x", type: chromium, ctx: { ...devices["Moto G4"] }, cpu: 6, net: SLOW4G },
  { name: "desktop-1440", type: chromium, ctx: { viewport: { width: 1440, height: 900 } }, cpu: 1, net: null },
  { name: "iphone13-webkit", type: webkit, ctx: { ...devices["iPhone 13"] }, cpu: 1, net: null },
];

async function perfProfile(p) {
  log(`\n== ${p.name}`);
  const { browser, context, page } = await login(p.type, p.ctx, p.name);
  const isChromium = p.type === chromium;
  const cdp = isChromium ? await cdpFor(context, page) : null;
  if (cdp) await cdp.send("Performance.enable");
  await discoverIds(page);
  const threadId = state.longThread || state.plainThread;
  const runs = [];
  for (let run = 1; run <= RUNS; run++) {
    const r = { run };
    // ---- load: cold + warm (Chromium: throttled network + CPU) ----
    if (cdp) {
      for (const kind of ["cold", "warm"]) {
        await cdp.send("Network.enable");
        if (kind === "cold") await cdp.send("Network.clearBrowserCache");
        await cdp.send("Network.emulateNetworkConditions", p.net || NO_THROTTLE);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: p.cpu });
        let bytes = 0;
        const onDone = (e) => {
          bytes += e.encodedDataLength;
        };
        cdp.on("Network.loadingFinished", onDone);
        const t0 = Date.now();
        await page.goto(`${BASE}/en/chat`, { waitUntil: "commit" });
        await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 120000 });
        const usable = Date.now() - t0;
        await page.waitForTimeout(3000);
        cdp.off("Network.loadingFinished", onDone);
        const nav = await page.evaluate(() => {
          const f = performance.getEntriesByName("first-contentful-paint")[0];
          const lt = window.__lt.map(([, d]) => d);
          return { fcp: f ? f.startTime : null, tbt: lt.reduce((a, d) => a + Math.max(0, d - 50), 0) };
        });
        r[`${kind}Load`] = { composerUsableMs: usable, fcpMs: Math.round(nav.fcp), tbtMs: Math.round(nav.tbt), kbTransferred: Math.round(bytes / 1024) };
        await cdp.send("Network.emulateNetworkConditions", NO_THROTTLE);
      }
    } else {
      const t0 = Date.now();
      await page.goto(`${BASE}/en/chat`, { waitUntil: "commit" });
      await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 120000 });
      r.warmLoad = { composerUsableMs: Date.now() - t0 };
    }
    // ---- typing + caret on landing and thread ----
    for (const [where, url] of [["landing", "/en/chat"], ["thread", `/en/chat/${threadId}`]]) {
      await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 120000 });
      await page.waitForTimeout(3000);
      let typing;
      let busy = null;
      if (cdp) busy = await traceBusy(cdp, async () => { typing = await typingLatency(page, TYPE_TEXT); });
      else typing = await typingLatency(page, TYPE_TEXT);
      r[`typing_${where}`] = {
        p50: pct(typing.lat, 0.5), p90: pct(typing.lat, 0.9), max: pct(typing.lat, 1),
        eventTimingP90: typing.et.length ? pct(typing.et, 0.9) : 0,
        vizMs: busy?.vizMs ?? null, mainMs: busy?.mainMs ?? null,
      };
      if (cdp) {
        await page.locator("#chat-composer").click();
        const caret = await traceBusy(cdp, () => page.waitForTimeout(3000));
        r[`caret_${where}`] = { vizMs: caret.vizMs, frames: caret.frames };
      }
    }
    // ---- scroll the long thread ----
    await page.goto(`${BASE}/en/chat/${threadId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 120000 });
    await page.waitForTimeout(3000);
    const scroll = async () => {
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => {
          const el = document.querySelector("#chat-composer")?.closest("section, main, body");
          const sc = [...document.querySelectorAll("div")].find((d) => d.scrollHeight > d.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(d).overflowY));
          sc?.scrollTo({ top: 0, behavior: "smooth" });
          return !!el;
        });
        await page.waitForTimeout(1200);
        await page.evaluate(() => {
          const sc = [...document.querySelectorAll("div")].find((d) => d.scrollHeight > d.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(d).overflowY));
          sc?.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
        });
        await page.waitForTimeout(1200);
      }
    };
    const t0s = await page.evaluate(() => performance.now());
    if (cdp) {
      let fs1;
      const b = await traceBusy(cdp, async () => { fs1 = await frameStats(page, scroll); });
      r.scroll = { ...fs1, vizMs: b.vizMs, mainMs: b.mainMs, longTasks: await longTasksSince(page, t0s) };
    } else {
      r.scroll = { ...(await frameStats(page, scroll)) };
    }
    // ---- first code block: lazy highlight JS (Chromium, cache cleared) ----
    if (cdp && state.codeThread) {
      await cdp.send("Network.clearBrowserCache");
      await page.goto(`${BASE}/en/chat/${state.codeThread}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 120000 });
      await page.waitForTimeout(8000);
      r.codeBlock = await page.evaluate(() => {
        const at = window.__firstPreAt ?? Number.POSITIVE_INFINITY;
        const js = performance.getEntriesByType("resource").filter((e) => e.name.endsWith(".js") && e.startTime >= at);
        const lt = window.__lt.filter(([s]) => s >= at).map(([, d]) => d);
        return {
          lazyJsKB: Math.round(js.reduce((a, e) => a + (e.transferSize || e.encodedBodySize || 0), 0) / 1024),
          lazyJsFiles: js.length,
          longTaskMs: Math.round(lt.reduce((a, b) => a + b, 0)),
          maxTaskMs: Math.round(Math.max(0, ...lt)),
        };
      });
    }
    // ---- streaming: long prompt, typing during stream (one run per profile keeps generations bounded) ----
    if (run === 1 || arg("stream-every-run", "") === "1") {
      await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 120000 });
      await page.waitForTimeout(2000);
      const s = await send(page, LONG_PROMPT);
      let during = null;
      let frames = null;
      if (s.firstTokenMs != null) {
        frames = await frameStats(page, async () => {
          during = await typingLatency(page, "typing while it streams", 150).catch(() => null);
          await waitDone(page);
        });
      }
      const chars = (await lastAnswerText(page)).length;
      const lt = await longTasksSince(page, s.t0);
      r.streaming = {
        firstTokenMs: s.firstTokenMs,
        chars,
        frames,
        typingDuringP90: during ? pct(during.lat, 0.9) : null,
        longTasks: lt,
        longTaskMsPer1kChars: chars ? Math.round((lt.totalMs / chars) * 1000) : null,
      };
    }
    if (cdp) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    runs.push(r);
    log(`  run ${run}: ${JSON.stringify(r)}`);
  }
  await browser.close();
  return { profile: p.name, runs, median: medianOf(runs) };
}

/** Median of every numeric leaf across runs. */
function medianOf(runs) {
  const out = {};
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, key);
      else if (typeof v === "number" && k !== "run") (out[key] ||= []).push(v);
    }
  };
  for (const r of runs) walk(r, "");
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, median(v)]));
}

// ------------------------------------------------------------------------ network
async function networkMode() {
  const { browser, context, page } = await login(chromium, { ...devices["Pixel 7"] }, "network");
  const cdp = await cdpFor(context, page);
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const results = {};
  const feedbackVisible = () =>
    page.evaluate(() => {
      const re = /offline|reconnect|connection lost|no internet|not connected|trying to connect/i;
      return [...document.querySelectorAll("body *")].some((el) => {
        if (el.closest("[data-perf-probe]") || el.closest("div.my-5")) return false;
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ");
        if (!re.test(own)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    });
  let lossSupported = true;
  const conditions = async (c, loss = 0) => {
    try {
      await cdp.send("Network.emulateNetworkConditions", loss ? { ...c, packetLoss: loss } : c);
    } catch {
      lossSupported = false;
      await cdp.send("Network.emulateNetworkConditions", c);
    }
  };
  for (const [name, c, loss] of [["fast4g", FAST4G, 0], ["slow4g", SLOW4G, 0], ["high-latency-800ms", HIGHLAT, 0], ["slow4g-5pct-loss", SLOW4G, 5]]) {
    await conditions(c, loss);
    const t0 = Date.now();
    await page.goto(`${BASE}/en/chat`, { waitUntil: "commit" });
    await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 180000 });
    const usable = Date.now() - t0;
    await page.waitForTimeout(2000);
    const typing = await typingLatency(page, "short typing test", 80);
    const s = await send(page, SHORT_PROMPT);
    const done = await waitDone(page, 180000);
    results[name] = { composerUsableMs: usable, typingP90: pct(typing.lat, 0.9), firstTokenMs: s.firstTokenMs, completed: done, lossEmulated: loss ? lossSupported : undefined };
    log(`  ${name}: ${JSON.stringify(results[name])}`);
  }
  await conditions(SLOW4G);
  // Offline while idle -> back -> send.
  await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 120000 });
  await page.waitForTimeout(2000);
  await conditions(OFFLINE);
  await page.waitForTimeout(20000);
  const typingOffline = await typingLatency(page, "typing while offline", 80);
  const feedbackIdle = await feedbackVisible();
  await conditions(SLOW4G);
  const tBack = Date.now();
  const s1 = await send(page, SHORT_PROMPT);
  const done1 = await waitDone(page, 180000);
  results.offlineIdleThenSend = { typingOfflineP90: pct(typingOffline.lat, 0.9), feedbackShownWhileOffline: feedbackIdle, firstTokenAfterReconnectMs: s1.firstTokenMs, sinceOnlineMs: Date.now() - tBack, completed: done1 };
  log(`  offlineIdleThenSend: ${JSON.stringify(results.offlineIdleThenSend)}`);
  // Send while offline -> exactly once after reconnect.
  const marker = `offline-send-${Date.now()}`;
  await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 120000 });
  await page.waitForTimeout(2000);
  await conditions(OFFLINE);
  await page.waitForTimeout(3000);
  await page.locator("#chat-composer").fill(`Reply with exactly the word ok. ${marker}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForTimeout(8000);
  const feedbackSend = await feedbackVisible();
  const bubbleWhileOffline = await page.evaluate((m) => document.body.innerText.includes(m), marker);
  await conditions(SLOW4G);
  const done2 = await waitDone(page, 180000);
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);
  const copies = await page.evaluate((m) => document.body.innerText.split(m).length - 1, marker);
  results.sendWhileOffline = { optimisticBubbleShown: bubbleWhileOffline, feedbackShown: feedbackSend, completedAfterReconnect: done2, userMessageCopiesAfterReload: copies };
  log(`  sendWhileOffline: ${JSON.stringify(results.sendWhileOffline)}`);
  // Offline mid-stream, and a network "switch" (profile change + 2 s drop) mid-stream.
  for (const [name, drop] of [["offlineMidStream10s", 10000], ["networkSwitchMidStream", 2000]]) {
    await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 120000 });
    await page.waitForTimeout(2000);
    await conditions(name === "networkSwitchMidStream" ? FAST4G : SLOW4G);
    const s = await send(page, LONG_PROMPT);
    await page.waitForTimeout(3000);
    await conditions(OFFLINE);
    await page.waitForTimeout(drop);
    const fb = await feedbackVisible();
    await conditions(SLOW4G);
    const done = await waitDone(page, 240000);
    const text = await lastAnswerText(page);
    results[name] = { firstTokenMs: s.firstTokenMs, feedbackShownDuringDrop: fb, finalized: done, finalChars: text.length };
    log(`  ${name}: ${JSON.stringify(results[name])}`);
  }
  await browser.close();
  return results;
}

// ------------------------------------------------------------------------- memory
function countDetached(snapshot) {
  const { meta } = snapshot.snapshot;
  const f = meta.node_fields;
  const nameIdx = f.indexOf("name");
  const step = f.length;
  let n = 0;
  for (let i = 0; i < snapshot.nodes.length; i += step) {
    if ((snapshot.strings[snapshot.nodes[i + nameIdx]] || "").startsWith("Detached ")) n++;
  }
  return n;
}

async function heapSnapshotDetached(cdp) {
  const chunks = [];
  const onChunk = (e) => chunks.push(e.chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  return countDetached(JSON.parse(chunks.join("")));
}

async function memoryMode() {
  // ONE document for the whole run: every cycle navigates in-app (drawer links,
  // dialogs, attachments), because a leak only accumulates inside a page that is
  // never reloaded. (page.goto per cycle — the first version — reloaded the app
  // every time and could not see a leak by construction.)
  const { browser, context, page } = await login(chromium, { ...devices["Pixel 7"] }, "memory");
  const cdp = await cdpFor(context, page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  await cdp.send("Network.enable");
  await discoverIds(page);
  const long = state.longThread;
  if (!long) throw new Error("no long thread — run --mode seed first");
  let sockets = 0;
  const subs = new Set();
  cdp.on("Network.webSocketCreated", () => sockets++);
  cdp.on("Network.webSocketClosed", () => sockets--);
  cdp.on("Network.webSocketFrameSent", (e) => {
    const d = e.response.payloadData;
    if (!d.includes('"ModifyQuerySet"')) return;
    try {
      for (const m of JSON.parse(d).modifications || []) {
        if (m.type === "Add") subs.add(m.queryId);
        if (m.type === "Remove") subs.delete(m.queryId);
      }
    } catch {}
  });
  let reloads = 0;
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) reloads++;
  });
  const sample = async (label) => {
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(400);
    const { metrics } = await cdp.send("Performance.getMetrics");
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    return { label, heapMB: Math.round((m.JSHeapUsedSize / 1048576) * 10) / 10, nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents, sockets, subscriptions: subs.size };
  };
  const button = (name) => page.getByRole("button", { name, exact: true }).first();
  const clickButton = async (name) => {
    const b = button(name);
    if (!(await b.count()) || !(await b.isVisible().catch(() => false))) return false;
    await b.click();
    await page.waitForTimeout(500);
    return true;
  };
  const openDrawer = async () => {
    if (await page.locator('nav[aria-label="Conversations"].fixed').count()) return true;
    return clickButton("Open conversations");
  };
  const drawerLink = async (selector) => {
    if (!(await openDrawer())) return false;
    const link = page.locator(`nav[aria-label="Conversations"].fixed ${selector}`).first();
    if (!(await link.count())) {
      await page.keyboard.press("Escape");
      return false;
    }
    await link.click();
    await page.waitForTimeout(300);
    return true;
  };
  const toThread = async (id) => {
    const t0 = Date.now();
    if (!(await drawerLink(`a[href$="/chat/${id}"]`))) return null;
    await page.waitForFunction((tid) => location.pathname.endsWith(tid) && document.querySelectorAll("div.my-5").length >= 2, id, { timeout: 60000 }).catch(() => {});
    return Date.now() - t0;
  };
  const toPath = async (selector, re) => {
    if (!(await drawerLink(selector))) return false;
    await page.waitForURL(re, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    return true;
  };
  const results = { scenarios: {} };
  const scenarios = {
    navigation: async () => {
      const a = await toThread(long);
      await toPath('a[href="/projects"]', /\/projects$/);
      await toPath('a[href="/scheduled"]', /\/scheduled$/);
      if (state.plainThread) await toThread(state.plainThread);
      return { longThreadOpenMs: a };
    },
    dialogs: async () => {
      if (!page.url().includes(`/chat/${long}`)) await toThread(long);
      if (await clickButton("Share conversation")) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
      }
      if (await openDrawer()) {
        await clickButton("Account menu");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
      }
      return {};
    },
    projects: async () => {
      await toPath('a[href="/projects"]', /\/projects$/);
      const href = await page.evaluate(() => [...document.querySelectorAll('a[href*="/projects/"]')].map((x) => x.getAttribute("href")).find((h) => /\/projects\/[a-z0-9]{10,}/i.test(h)) || null);
      if (href) {
        await page.locator(`a[href="${href}"]`).first().click();
        await page.waitForTimeout(1500);
      }
      return { projectVisited: !!href };
    },
    uploads: async () => {
      if (!page.url().includes(`/chat/${long}`)) await toThread(long);
      const files = fixtureFiles();
      await page.locator('input[type="file"]').first().setInputFiles(files);
      await page.waitForTimeout(5000);
      for (const f of files) {
        const rm = page.getByRole("button", { name: `Remove ${path.basename(f)}` }).first();
        if (await rm.count()) {
          await rm.click();
          await page.waitForTimeout(700);
        }
      }
      return {};
    },
  };
  // Warm-up: land on the long thread once, then start counting.
  await toThread(long);
  const reloadsBefore = reloads;
  for (const [name, fn] of Object.entries(scenarios)) {
    const samples = [];
    const extra = [];
    for (let c = 1; c <= CYCLES; c++) {
      extra.push(await fn());
      if (c === 1 || c === Math.ceil(CYCLES / 2) || c === CYCLES) samples.push({ cycle: c, ...(await sample(name)) });
    }
    const warm = samples[0];
    const last = samples[samples.length - 1];
    results.scenarios[name] = {
      samples,
      heapGrowthPctAfterWarmup: warm.heapMB ? Math.round(((last.heapMB - warm.heapMB) / warm.heapMB) * 1000) / 10 : null,
      nodesDelta: last.nodes - warm.nodes,
      listenersDelta: last.listeners - warm.listeners,
      socketsDelta: last.sockets - warm.sockets,
      subscriptionsDelta: last.subscriptions - warm.subscriptions,
      firstOpenMs: extra[0]?.longThreadOpenMs ?? null,
      lastOpenMs: extra[extra.length - 1]?.longThreadOpenMs ?? null,
    };
    log(`  ${name}: ${JSON.stringify(results.scenarios[name])}`);
  }
  results.detachedAfterCycles = await heapSnapshotDetached(cdp);
  // Send / regenerate (bounded: generations are rate-limited), still in-app.
  const gens = Number(arg("gens", 5));
  try {
    if (await openDrawer()) {
      await page.locator('nav[aria-label="Conversations"].fixed').getByRole("button", { name: "New chat" }).first().click({ timeout: 10000 });
    }
    await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 60000 });
    const before = await sample("send-regenerate-start");
    for (let i = 0; i < gens; i++) {
      await send(page, SHORT_PROMPT);
      await waitDone(page, 120000);
      const regen = page.getByRole("button", { name: "Regenerate" }).last();
      if (await regen.count()) {
        await regen.click({ force: true, timeout: 10000 });
        await waitDone(page, 120000);
      }
    }
    const after = await sample("send-regenerate-end");
    results.sendRegenerate = { cycles: gens, before, after, heapGrowthPct: Math.round(((after.heapMB - before.heapMB) / before.heapMB) * 1000) / 10 };
  } catch (e) {
    results.sendRegenerate = { error: e.message.slice(0, 160) };
  }
  results.detachedEnd = await heapSnapshotDetached(cdp);
  results.fullReloadsDuringCycles = reloads - reloadsBefore;
  log(`  sendRegenerate: ${JSON.stringify(results.sendRegenerate)}  detached after cycles ${results.detachedAfterCycles}, end ${results.detachedEnd}, reloads ${results.fullReloadsDuringCycles}`);
  await browser.close();
  return results;
}

function fixtureFiles() {
  const dir = path.join(OUT, "fixtures");
  fs.mkdirSync(dir, { recursive: true });
  const png = path.join(dir, "perf-probe-image-with-a-deliberately-long-file-name-for-chip-layout.png");
  const txt = path.join(dir, "perf-notes.txt");
  const pdf = path.join(dir, "perf-sample.pdf");
  if (!fs.existsSync(png)) {
    fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  }
  if (!fs.existsSync(txt)) fs.writeFileSync(txt, "Perf harness fixture.\n".repeat(50));
  if (!fs.existsSync(pdf)) {
    fs.writeFileSync(pdf, "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  }
  return [png, txt, pdf];
}

// --------------------------------------------------------------------- longthread
// Hundreds of messages: open the seeded ~200-message thread, load every page,
// and measure what a long conversation costs on an emulated phone (4x CPU).
async function longThreadMode() {
  const { browser, context, page } = await login(chromium, { ...devices["Pixel 7"] }, "longthread");
  const cdp = await cdpFor(context, page);
  await cdp.send("Performance.enable");
  if (!state.longThread) throw new Error("no long thread — run --mode seed first");
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
  const rows = () => page.evaluate(() => document.querySelectorAll("div.my-5").length);
  const loadEarlier = page.getByRole("button", { name: "Load earlier messages" });
  const runs = [];
  for (let run = 1; run <= RUNS; run++) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 120000 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const t0 = Date.now();
    await page.goto(`${BASE}/en/chat/${state.longThread}`, { waitUntil: "domcontentloaded" });
    // The first live page (30) — not the 3-row cached/skeleton render.
    await page.waitForFunction(() => document.querySelectorAll("div.my-5").length >= 20, null, { timeout: 120000 });
    const firstPageMs = Date.now() - t0;
    const pageTimes = [];
    // The cached transcript fills the first rows instantly; the button only
    // appears once the live first page has loaded.
    await loadEarlier.waitFor({ timeout: 20000 }).catch(() => {});
    for (let i = 0; i < 12 && (await loadEarlier.count()); i++) {
      const before = await rows();
      const tp = Date.now();
      await loadEarlier.click();
      await page.waitForFunction((n) => document.querySelectorAll("div.my-5").length > n, before, { timeout: 60000 }).catch(() => {});
      pageTimes.push(Date.now() - tp);
      await page.waitForTimeout(800);
    }
    const all = await rows();
    await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
    const m = await metrics();
    const scroll = await frameStats(page, async () => {
      for (let i = 0; i < 2; i++) {
        for (const top of [0, 1e9]) {
          await page.evaluate((t) => {
            const sc = [...document.querySelectorAll("div")].find((d) => d.scrollHeight > d.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(d).overflowY));
            sc?.scrollTo({ top: t, behavior: "smooth" });
          }, top);
          await page.waitForTimeout(1500);
        }
      }
    });
    const typing = await typingLatency(page, TYPE_TEXT);
    const r = {
      run,
      firstPageMs,
      messagesRendered: all,
      loadEarlierP50Ms: pct(pageTimes, 0.5),
      loadEarlierMaxMs: pct(pageTimes, 1),
      domNodes: m.Nodes,
      heapMB: Math.round((m.JSHeapUsedSize / 1048576) * 10) / 10,
      listeners: m.JSEventListeners,
      scroll,
      typingP50: pct(typing.lat, 0.5),
      typingP90: pct(typing.lat, 0.9),
    };
    runs.push(r);
    log(`  run ${run}: ${JSON.stringify(r)}`);
  }
  await browser.close();
  return { runs, median: medianOf(runs) };
}

// ------------------------------------------------------------------------ battery
async function batteryMode() {
  const results = {};
  const measure = async (page, cdp, seconds) => {
    const { metrics: a } = await cdp.send("Performance.getMetrics");
    const s0 = await page.evaluate(() => ({ raf: window.__rafCalls, gl: window.__glDraws }));
    let requests = 0;
    const onReq = () => requests++;
    cdp.on("Network.requestWillBeSent", onReq);
    let wsOut = 0;
    const onWs = () => wsOut++;
    cdp.on("Network.webSocketFrameSent", onWs);
    await page.waitForTimeout(seconds * 1000);
    cdp.off("Network.requestWillBeSent", onReq);
    cdp.off("Network.webSocketFrameSent", onWs);
    const { metrics: b } = await cdp.send("Performance.getMetrics");
    const s1 = await page.evaluate(() => ({ raf: window.__rafCalls, gl: window.__glDraws }));
    const m = (arr, k) => arr.find((x) => x.name === k)?.value ?? 0;
    return {
      cpuPct: Math.round(((m(b, "TaskDuration") - m(a, "TaskDuration")) / seconds) * 1000) / 10,
      rafPerSec: Math.round(((s1.raf - s0.raf) / seconds) * 10) / 10,
      webglDrawsPerSec: Math.round(((s1.gl - s0.gl) / seconds) * 10) / 10,
      httpRequests: requests,
      wsFramesSent: wsOut,
    };
  };
  for (const p of [
    { name: "phone", ctx: { ...devices["Pixel 7"] } },
    { name: "tablet-1024L", ctx: { viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: "desktop-1440", ctx: { viewport: { width: 1440, height: 900 } } },
  ]) {
    const { browser, context, page } = await login(chromium, p.ctx, `battery-${p.name}`);
    const cdp = await cdpFor(context, page);
    await cdp.send("Performance.enable");
    await cdp.send("Network.enable");
    const r = {};
    await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 120000 });
    await page.waitForTimeout(10000);
    r.idleLanding30s = await measure(page, cdp, 30);
    await send(page, SHORT_PROMPT);
    await waitDone(page, 120000);
    await page.waitForTimeout(3000);
    r.idleAfterStreaming30s = await measure(page, cdp, 30);
    if (p.name === "phone" && (await page.getByRole("button", { name: "Open conversations" }).count())) {
      await page.getByRole("button", { name: "Open conversations" }).click();
      await page.waitForTimeout(3000);
      r.drawerOpen15s = await measure(page, cdp, 15);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(3000);
      r.drawerClosed15s = await measure(page, cdp, 15);
    }
    // Hidden: minimise the (headed) window — a second tab in front did not make
    // this page `hidden` in the baseline run, so that measurement was void.
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
    await page.waitForTimeout(2000);
    const vis = await page.evaluate(() => document.visibilityState);
    r.hidden60s = { visibilityState: vis, ...(await measure(page, cdp, 60)) };
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    results[p.name] = r;
    log(`  ${p.name}: ${JSON.stringify(r)}`);
    await browser.close();
  }
  return results;
}

// --------------------------------------------------------------------------- seed
async function seedMode() {
  const count = Number(arg("count", 100));
  const { browser, page } = await login(chromium, { viewport: { width: 1280, height: 800 } }, "seed");
  if (state.longThread) {
    await page.goto(`${BASE}/en/chat/${state.longThread}`, { waitUntil: "domcontentloaded" });
  } else {
    await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
  }
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 120000 });
  const kinds = [
    (i) => `Long-session fixture ${i}: reply with two short sentences about the number ${i}.`,
    (i) => `Long-session fixture ${i}: reply with a three-item markdown list about the number ${i}.`,
    (i) => `Long-session fixture ${i}: reply with a tiny python code block printing ${i}.`,
    (i) => `Long-session fixture ${i}: reply with a two-row markdown table with columns n and n squared for ${i}.`,
  ];
  const started = Date.now();
  for (let i = 1; i <= count; i++) {
    const t = Date.now();
    await send(page, kinds[i % kinds.length](i));
    await waitDone(page, 180000);
    if (!state.longThread) {
      const id = page.url().split("/").pop();
      if (/^[a-z0-9]{20,}$/i.test(id)) {
        state.longThread = id;
        saveState();
      }
    }
    // Stay under 120 generations/hour with margin: at least 40 s per send.
    const wait = 40000 - (Date.now() - t);
    if (wait > 0) await sleep(wait);
    if (i % 10 === 0) log(`  seeded ${i}/${count} (${Math.round((Date.now() - started) / 60000)} min)`);
  }
  await browser.close();
  return { longThread: state.longThread, sent: count };
}

// ------------------------------------------------------------------------ compare
function compareMode() {
  const against = arg("against", "baseline");
  const report = {};
  for (const mode of ["perf", "network", "memory", "battery"]) {
    const a = path.join(OUT, `${against}-${mode}.json`);
    const b = path.join(OUT, `${LABEL}-${mode}.json`);
    if (!fs.existsSync(a) || !fs.existsSync(b)) continue;
    report[mode] = { before: JSON.parse(fs.readFileSync(a, "utf8")), after: JSON.parse(fs.readFileSync(b, "utf8")) };
  }
  if (report.perf) {
    log("\nperf medians  (before -> after)");
    for (const after of report.perf.after.profiles) {
      const before = report.perf.before.profiles.find((x) => x.profile === after.profile);
      if (!before) continue;
      log(`\n  ${after.profile}`);
      for (const [k, v] of Object.entries(after.median)) {
        const bv = before.median[k];
        const change = bv ? `${Math.round(((v - bv) / bv) * 100)}%` : "";
        log(`    ${k.padEnd(44)} ${String(bv).padStart(8)} -> ${String(v).padStart(8)}  ${change}`);
      }
    }
  }
  return report;
}

// -------------------------------------------------------------------------- gates
// Numeric acceptance thresholds, baseline vs after. Noise tolerance on "no worse"
// gates: the larger of 5% and a small absolute slack, printed with every verdict.
function gatesMode() {
  const against = arg("against", "baseline");
  const load = (label, mode) => {
    const f = path.join(OUT, `${label}-${mode}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
  };
  const verdicts = [];
  const gate = (id, name, pass, detail) => {
    verdicts.push({ id, name, pass, detail });
    log(`${pass === null ? "N/A " : pass ? "PASS" : "FAIL"}  ${id} ${name} — ${detail}`);
  };
  const noWorse = (before, after, slack) => after <= Math.max(before * 1.05, before + slack);
  const pb = load(against, "perf");
  const pa = load(LABEL, "perf");
  const prof = (doc, name) => doc?.result.profiles.find((p) => p.profile === name)?.median;
  const b = prof(pb, "pixel7-4x");
  const a = prof(pa, "pixel7-4x");
  if (b && a) {
    for (const where of ["landing", "thread"]) {
      const k = `typing_${where}`;
      gate("G1", `typing ${where} (Pixel 7 4x)`, a[`${k}.p90`] <= 32 && noWorse(b[`${k}.p90`], a[`${k}.p90`], 2) && a[`${k}.vizMs`] <= b[`${k}.vizMs`] * 0.5,
        `p90 ${b[`${k}.p90`]} -> ${a[`${k}.p90`]} ms (<=32, no worse); compositor ${b[`${k}.vizMs`]} -> ${a[`${k}.vizMs`]} ms (<=50%)`);
      gate("G2", `caret idle ${where}`, a[`caret_${where}.vizMs`] <= b[`caret_${where}.vizMs`] * 0.3,
        `compositor ${b[`caret_${where}.vizMs`]} -> ${a[`caret_${where}.vizMs`]} ms (<=30%)`);
    }
    gate("G3", "scroll long thread", noWorse(b["scroll.droppedPct"], a["scroll.droppedPct"], 2) && (a["scroll.longTasks.maxMs"] ?? 0) <= 100,
      `dropped ${b["scroll.droppedPct"]} -> ${a["scroll.droppedPct"]} %; longest task ${a["scroll.longTasks.maxMs"]} ms (<=100)`);
    gate("G4", "cold/warm load slow-4G 4x", noWorse(b["coldLoad.composerUsableMs"], a["coldLoad.composerUsableMs"], 100) && noWorse(b["coldLoad.tbtMs"], a["coldLoad.tbtMs"], 50) && noWorse(b["warmLoad.composerUsableMs"], a["warmLoad.composerUsableMs"], 100),
      `cold usable ${b["coldLoad.composerUsableMs"]} -> ${a["coldLoad.composerUsableMs"]} ms, TBT ${b["coldLoad.tbtMs"]} -> ${a["coldLoad.tbtMs"]}, warm ${b["warmLoad.composerUsableMs"]} -> ${a["warmLoad.composerUsableMs"]}`);
    gate("G5", "first code block", a["codeBlock.lazyJsKB"] <= b["codeBlock.lazyJsKB"] * 0.4 && noWorse(b["codeBlock.longTaskMs"], a["codeBlock.longTaskMs"], 30),
      `lazy JS ${b["codeBlock.lazyJsKB"]} -> ${a["codeBlock.lazyJsKB"]} KB (<=40%); long tasks ${b["codeBlock.longTaskMs"]} -> ${a["codeBlock.longTaskMs"]} ms`);
    gate("G6", "streaming", noWorse(b["streaming.longTasks.maxMs"], a["streaming.longTasks.maxMs"], 20) && noWorse(b["streaming.longTaskMsPer1kChars"], a["streaming.longTaskMsPer1kChars"], 20),
      `longest task ${b["streaming.longTasks.maxMs"]} -> ${a["streaming.longTasks.maxMs"]} ms; long-task ms/1k chars ${b["streaming.longTaskMsPer1kChars"]} -> ${a["streaming.longTaskMsPer1kChars"]}`);
  } else gate("G1-G6", "perf (Pixel 7 4x)", null, "baseline or after perf run missing");
  const wb = prof(pb, "iphone13-webkit");
  const wa = prof(pa, "iphone13-webkit");
  if (wb && wa) {
    gate("G1w", "typing landing (WebKit iPhone 13)", noWorse(wb["typing_landing.p90"], wa["typing_landing.p90"], 5), `p90 ${wb["typing_landing.p90"]} -> ${wa["typing_landing.p90"]} ms`);
    gate("G1w", "typing thread (WebKit iPhone 13)", noWorse(wb["typing_thread.p90"], wa["typing_thread.p90"], 5), `p90 ${wb["typing_thread.p90"]} -> ${wa["typing_thread.p90"]} ms`);
  }
  const db = prof(pb, "desktop-1440");
  const da = prof(pa, "desktop-1440");
  if (db && da) {
    gate("G8", "desktop 1440 no regression", noWorse(db["coldLoad.composerUsableMs"], da["coldLoad.composerUsableMs"], 100) && noWorse(db["typing_landing.p90"], da["typing_landing.p90"], 3) && noWorse(db["scroll.droppedPct"], da["scroll.droppedPct"], 2),
      `cold ${db["coldLoad.composerUsableMs"]} -> ${da["coldLoad.composerUsableMs"]} ms, typing p90 ${db["typing_landing.p90"]} -> ${da["typing_landing.p90"]}, scroll drop ${db["scroll.droppedPct"]} -> ${da["scroll.droppedPct"]} %`);
  }
  const ma = load(LABEL, "memory");
  if (ma) {
    const r = ma.result;
    // Growth across the SECOND half (mid -> last cycle): the first cycles fill caches
    // (transcript cache, Convex query cache), which is warm-up, not a leak.
    const secondHalf = (s) => {
      const [, mid, last] = s.samples;
      return mid && last && mid.heapMB ? Math.round(((last.heapMB - mid.heapMB) / mid.heapMB) * 1000) / 10 : null;
    };
    const bad = Object.entries(r.scenarios).filter(([, s]) => secondHalf(s) > 10 || s.samples[s.samples.length - 1].listeners - s.samples[1].listeners > Math.max(20, s.samples[1].listeners * 0.05) || s.socketsDelta > 0 || s.subscriptionsDelta > 2);
    gate("G7", "memory over repeated interaction", bad.length === 0 && r.detachedEnd <= r.detachedAfterCycles + 50 && r.fullReloadsDuringCycles === 0,
      `${Object.entries(r.scenarios).map(([n, s]) => `${n}: heap 2nd-half ${secondHalf(s)}% (from cycle 1 ${s.heapGrowthPctAfterWarmup}%) listeners ${s.listenersDelta >= 0 ? "+" : ""}${s.listenersDelta} sockets Δ${s.socketsDelta} subs Δ${s.subscriptionsDelta}`).join("; ")}; detached ${r.detachedAfterCycles} -> ${r.detachedEnd}, reloads ${r.fullReloadsDuringCycles}`);
  } else gate("G7", "memory", null, "after memory run missing");
  const errors = ["perf", "network", "memory", "battery"].map((m) => load(LABEL, m)).filter(Boolean).reduce((n, d) => n + d.consoleErrors.length, 0);
  gate("G9", "console errors in after runs", errors === 0, `${errors} errors`);
  return verdicts;
}

(async () => {
  if (!["compare", "gates"].includes(MODE) && (!EMAIL || !PASSWORD)) throw new Error("QA_EMAIL and QA_PASSWORD must be set");
  let result;
  if (MODE === "perf") {
    const only = arg("profiles", "");
    const profiles = PERF_PROFILES.filter((p) => !only || only.split(",").includes(p.name));
    result = { profiles: [] };
    for (const p of profiles) result.profiles.push(await perfProfile(p));
  } else if (MODE === "network") result = await networkMode();
  else if (MODE === "memory") result = await memoryMode();
  else if (MODE === "longthread") result = await longThreadMode();
  else if (MODE === "battery") result = await batteryMode();
  else if (MODE === "seed") result = await seedMode();
  else if (MODE === "compare") result = compareMode();
  else if (MODE === "gates") result = gatesMode();
  else throw new Error(`unknown mode ${MODE}`);
  const benign = errs.filter((e) => !/favicon|third-party cookie/i.test(e));
  const file = path.join(OUT, `${LABEL}-${MODE}.json`);
  fs.writeFileSync(file, JSON.stringify({ base: BASE, mode: MODE, label: LABEL, at: new Date().toISOString(), result, consoleErrors: benign }, null, 2));
  log(`\nconsole errors: ${benign.length}`);
  for (const e of benign.slice(0, 8)) log(`  ! ${e}`);
  log(`wrote ${file}`);
  process.exit(benign.length ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e.stack);
  process.exit(2);
});
