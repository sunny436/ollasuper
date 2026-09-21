// User-perceived latency harness with India emulation, in the house style:
// standalone node script, headed Chrome, hard count of console errors.
//
// It measures the milestones a user actually waits for, N times, and prints
// medians and p90s — never single samples. Emulation is done through CDP, the
// same mechanism DevTools uses (Sensors → Location, Network → throttling):
//
//   node perf-india.js --profile us          # this machine, unthrottled
//   node perf-india.js --profile india       # 260 ms RTT, 20↓/8↑ Mbps, Mumbai
//   node perf-india.js --profile india-poor  # 400 ms RTT, 4↓/1↑ Mbps
//   node perf-india.js --self-check          # is the WebSocket throttled at all?
//   node perf-india.js --measure-only --label real-india   # run from India as-is
//
// The Convex WebSocket is delayed by the harness itself (routeWebSocket) because
// Chrome network conditions do not touch it — see routeSocket.
//
// Caveat printed with every emulated result: CDP throttling adds the RTT to
// EVERY request, including edge-cached static files that a real Indian user
// gets from the Mumbai edge in ~30 ms. Cold-load numbers are therefore
// pessimistic; dynamic (RSC, /api/auth, WebSocket) numbers are representative.
//
// Results: e2e/.perf/<label>-<profile>.json. Creds: QA_EMAIL / QA_PASSWORD
// (see creds.js). Every run signs in fresh (new context, empty cache), creates
// ONE chat, sends two short prompts, and deletes the chat again.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const { email: EMAIL, password: PASSWORD } = require("./creds").account();

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i === -1 ? d : process.argv[i + 1];
};
const has = (n) => process.argv.includes("--" + n);
const PROFILE = arg("profile", "us");
const RUNS = Number(arg("runs", 10));
const LABEL = arg("label", "run");
const SELF_CHECK = has("self-check");

// Mbps → bytes/s for CDP.
const mbps = (n) => (n * 1e6) / 8;
const PROFILES = {
  us: null,
  india: {
    latency: 260,
    down: mbps(20),
    up: mbps(8),
    geo: { latitude: 19.076, longitude: 72.8777, accuracy: 50 },
    tz: "Asia/Kolkata",
    locale: "en-IN",
  },
  "india-poor": {
    latency: 400,
    down: mbps(4),
    up: mbps(1),
    geo: { latitude: 28.6139, longitude: 77.209, accuracy: 50 },
    tz: "Asia/Kolkata",
    locale: "en-IN",
  },
};
if (!(PROFILE in PROFILES)) {
  console.error(`unknown --profile ${PROFILE}; one of ${Object.keys(PROFILES).join(", ")}`);
  process.exit(2);
}
const P = PROFILES[PROFILE];

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (v, p) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round((s.length - 1) * p))];
};
const fmt = (x) => (x === null || x === undefined ? "  n/a" : String(Math.round(x)).padStart(5));

/**
 * CDP network conditions throttle HTTP only — measured: the Convex WebSocket
 * round trip was 251 ms under the "india" profile vs 171-225 ms unthrottled, so
 * the socket is NOT throttled by Chrome. The WebSocket is therefore delayed
 * here, in the harness, through Playwright's routeWebSocket: every frame in
 * each direction waits latency/2 plus its serialisation time at the profile's
 * bandwidth, through an ORDER-PRESERVING queue (a reordered frame would corrupt
 * the sync protocol). Bytes are counted in the same place.
 */
const dropped = [];
function delayQueue(oneWayMs, bytesPerSec, send) {
  // One serial drain loop per direction: strict FIFO. Independent setTimeouts
  // with near-equal due times can fire out of order, and one reordered frame
  // gives the Convex client "Invalid start version" (seen in a probe run).
  const q = [];
  let due = 0;
  let draining = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    while (q.length) {
      const head = q[0];
      const wait = head.at - Date.now();
      if (wait > 0) await sleep(wait);
      q.shift();
      try {
        send(head.msg);
      } catch (e) {
        dropped.push(String(e).slice(0, 80));
      }
    }
    draining = false;
  };
  return (msg) => {
    const bytes = typeof msg === "string" ? msg.length : msg.byteLength ?? 0;
    const at = Math.max(Date.now() + oneWayMs + (bytes / bytesPerSec) * 1000, due);
    due = at;
    q.push({ msg, at });
    void drain();
  };
}

async function routeSocket(context, rec) {
  if (!P) return;
  await context.routeWebSocket(/\/__cvx\//, (ws) => {
    const server = ws.connectToServer();
    const up = delayQueue(P.latency / 2, P.up, (m) => server.send(m));
    const down = delayQueue(P.latency / 2, P.down, (m) => ws.send(m));
    ws.onMessage((m) => {
      rec.wsOut.push({ t: now(), bytes: typeof m === "string" ? m.length : m.byteLength ?? 0 });
      up(m);
    });
    server.onMessage((m) => {
      rec.wsIn.push({ t: now(), bytes: typeof m === "string" ? m.length : m.byteLength ?? 0 });
      down(m);
    });
    ws.onClose((code, reason) => server.close({ code, reason }));
    server.onClose((code, reason) => ws.close({ code, reason }));
  });
}

/** Attach CDP: emulation + request/WS accounting. Returns a recorder. */
async function instrument(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  if (P) {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: P.latency,
      downloadThroughput: P.down,
      uploadThroughput: P.up,
    });
    // geolocation / timezone / locale are applied by the browser context
    // (newContext below); setting them again over CDP throws "already in effect".
    //
    // Measured: the network conditions above throttle fetch/XHR/RSC/assets but
    // NOT the top-level document navigation (throttled TTFB 110 ms vs 228 plain,
    // fetch 471 vs 114). The document request gets the profile's RTT here.
    await page.route(
      (u) => u.origin === BASE && !u.pathname.startsWith("/_next/") && !u.pathname.startsWith("/__cvx"),
      async (route) => {
        const r = route.request();
        if (r.isNavigationRequest() && r.resourceType() === "document") await sleep(P.latency);
        await route.continue();
      },
    );
  }
  const rec = {
    requests: [], // {t, method, url, status, bytes}
    wsIn: [], // {t, bytes}
    wsOut: [],
    byId: new Map(),
    mark: now(),
  };
  cdp.on("Network.requestWillBeSent", (e) => {
    const r = { t: now(), method: e.request.method, url: e.request.url, status: null, bytes: 0 };
    rec.byId.set(e.requestId, r);
    rec.requests.push(r);
  });
  cdp.on("Network.responseReceived", (e) => {
    const r = rec.byId.get(e.requestId);
    if (r) r.status = e.response.status;
  });
  cdp.on("Network.loadingFinished", (e) => {
    const r = rec.byId.get(e.requestId);
    if (r) r.bytes = e.encodedDataLength;
  });
  if (!P) {
    // Unrouted socket: count frames from CDP. (Routed sockets are counted in
    // routeSocket, where the frames actually pass.)
    cdp.on("Network.webSocketFrameReceived", (e) => {
      rec.wsIn.push({ t: now(), bytes: (e.response.payloadData || "").length });
    });
    cdp.on("Network.webSocketFrameSent", (e) => {
      rec.wsOut.push({ t: now(), bytes: (e.response.payloadData || "").length });
    });
  }
  rec.since = (t) => rec.requests.filter((r) => r.t >= t);
  rec.wsBytesBetween = (a, b) =>
    rec.wsIn.filter((f) => f.t >= a && f.t <= b).reduce((s, f) => s + f.bytes, 0);
  rec.firstWsAfter = (t, minBytes = 200) => {
    const f = rec.wsIn.find((x) => x.t >= t && x.bytes >= minBytes);
    return f ? f.t : null;
  };
  return rec;
}

const shortUrl = (u) => {
  try {
    const x = new URL(u);
    if (x.origin !== BASE) return x.host + x.pathname;
    return x.pathname + (x.search.includes("_rsc") ? "?_rsc" : "");
  } catch {
    return u;
  }
};

const CONVO = '[aria-label="Conversation"]';
// Both user and assistant rows carry `group my-5`; skeleton rows do not.
const ROW = `${CONVO} .group.my-5`;

async function waitRows(page, min, timeout = 30000) {
  await page.waitForFunction(
    ([sel, n]) => document.querySelectorAll(`${sel}:not([data-perf-old])`).length >= n,
    [ROW, min],
    { timeout, polling: "raf" },
  );
}

/**
 * Tag the rows on screen BEFORE a thread switch. The App Router can commit the
 * new URL while the previous segment is still in the DOM, so counting rows
 * right after the URL changes could count the OLD transcript (seen: a "first
 * row" 37 ms after click). New rows are new nodes and carry no tag.
 */
async function markOldRows(page) {
  await page.evaluate((sel) => {
    for (const el of document.querySelectorAll(sel)) el.setAttribute("data-perf-old", "1");
  }, ROW);
}

async function waitAssistantText(page, timeout = 120000) {
  await page.waitForFunction(
    (sel) => {
      const rows = [...document.querySelectorAll(sel)];
      const last = rows[rows.length - 1];
      if (!last || last.classList.contains("items-end")) return false;
      // The assistant row renders its meta header ("Assistant" + time) BEFORE
      // any token — and so does the optimistic placeholder — so only text past
      // the first two lines counts as a token.
      return last.innerText.trim().split(/\r?\n/).slice(2).join("").trim().length > 0;
    },
    ROW,
    { timeout, polling: "raf" },
  );
}

/**
 * Server ack of a send = the streaming row exists = the composer shows Stop.
 * A very short reply can finish before a 150 ms poll sees the button, so the
 * assistant text itself also counts (a later, conservative estimate).
 */
async function waitAck(page, stop, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await stop.count()) > 0) return;
    // Fast-reply race: the whole turn can finish between two polls. Real
    // text past the meta header means the turn was acked AND answered — the
    // optimistic placeholder never has any (it shows a typing indicator).
    const rows = await page.locator(ROW).count();
    if (rows > 0) {
      const done = await page
        .locator(ROW)
        .last()
        .evaluate(
          (r) =>
            !r.classList.contains("items-end") &&
            r.innerText.trim().split(/\r?\n/).slice(2).join("").trim().length > 0,
        );
      if (done) return;
    }
    await sleep(10);
  }
  throw new Error("no ack (no Stop button and no assistant text) within " + timeout + " ms");
}

async function settle(page, timeout = 240000) {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await stop.count()) === 0) return true;
    await sleep(150);
  }
  return false;
}

const HARNESS_TITLE = /^Reply with exactly the word: [A-Z]+/;

async function cleanupLeftovers(page) {
  let n = 0;
  for (let k = 0; k < 10; k++) {
    const link = page.locator('a[href^="/chat/"]').filter({ hasText: HARNESS_TITLE }).first();
    if ((await link.count()) === 0) break;
    const href = await link.getAttribute("href");
    if (!(await deleteThread(page, href))) break;
    n++;
    await sleep(400);
  }
  return n;
}

async function deleteThread(page, href) {
  const link = page.locator(`a[href="${href}"]`).first();
  await link.waitFor({ timeout: 15000 }).catch(() => {});
  const row = link.locator("xpath=..");
  if ((await row.count()) === 0) return false;
  await row.hover();
  await row.getByRole("button", { name: "Conversation actions" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await sleep(300);
  return true;
}

async function oneRun(browser, i) {
  const partial = {};
  try {
    return await oneRunInner(browser, i, partial);
  } catch (e) {
    e.partial = partial;
    try {
      const pg = partial.__page;
      if (pg) {
        fs.mkdirSync(path.join(__dirname, ".perf"), { recursive: true });
        await pg.screenshot({ path: path.join(__dirname, ".perf", `fail-${LABEL}-${i}.png`) });
        e.partial.url = pg.url();
        e.partial.rows = await pg.locator(ROW).count();
      }
    } catch {}
    throw e;
  }
}

async function oneRunInner(browser, i, out0) {
  const context = await browser.newContext({
    viewport: { width: 1360, height: 860 },
    ...(P ? { locale: P.locale, timezoneId: P.tz, geolocation: P.geo, permissions: ["geolocation"] } : {}),
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  const rec = await instrument(context, page);
  await routeSocket(context, rec);
  const out = Object.assign(out0, { run: i, errors });
  const droppedBefore = dropped.length;
  Object.defineProperty(out, "__page", { value: page, enumerable: false });

  // 1. cold /login
  out.stage = "cold-login";
  {
    const t0 = now();
    await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
    out.login_dcl_ms = now() - t0;
    await page.waitForLoadState("load");
    out.login_load_ms = now() - t0;
    await page.locator('input[type="email"]').first().waitFor();
    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0];
      return n ? { ttfb: n.responseStart - n.startTime, dcl: n.domContentLoadedEventEnd - n.startTime } : null;
    });
    out.login_ttfb_ms = nav?.ttfb ?? null;
    const reqs = rec.since(t0);
    out.login_requests = reqs.length;
    out.login_bytes = reqs.reduce((s, r) => s + (r.bytes || 0), 0);
    out.login_fonts = reqs.filter((r) => /\.woff2/.test(r.url)).length;
  }

  // 2. sign in → composer usable
  out.stage = "signin";
  {
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    const t0 = now();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat/, { timeout: 30000 });
    out.signin_url_ms = now() - t0;
    await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
    out.signin_composer_ms = now() - t0;
    await page.locator('a[href^="/chat/"]').first().waitFor({ timeout: 30000 });
    out.signin_rail_ms = now() - t0;
    const t1 = now();
    out.signin_requests = rec
      .since(t0)
      .filter((r) => r.t <= t1)
      .map((r) => `${r.method} ${shortUrl(r.url)} ${r.status ?? "-"}`);
    out.signin_sequential_dynamic = out.signin_requests.filter(
      (s) => /\/api\/auth|\?_rsc|POST \/login|POST \/en\/login|GET \/$/.test(s),
    ).length;
  }

  // 3. thread open — hovered (intent) and not hovered
  out.stage = "thread-open";
  {
    // Leftovers from an aborted earlier run (their title is the harness prompt)
    // are deleted first so the rail order is stable and no empty chat is opened.
    out.leftovers_deleted = await cleanupLeftovers(page);
    // Only threads with a real transcript (an untitled chat is still "New chat").
    const links = page.locator('a[href^="/chat/"]').filter({ hasNotText: /^New chat$/ });
    const n = await links.count();
    if (n >= 3) {
      // hovered (intent): the old segment stays in the DOM until the new one
      // commits, so wait for the URL to change BEFORE counting rows.
      const href1 = await links.nth(1).getAttribute("href");
      await links.nth(1).hover();
      await sleep(900);
      await markOldRows(page);
      let t0 = now();
      await links.nth(1).click();
      await page.waitForURL((u) => u.pathname === href1, { timeout: 30000 });
      out.open_hover_url_ms = now() - t0;
      await waitRows(page, 1);
      const tRow = now();
      out.open_hover_first_row_ms = tRow - t0;
      const ws1 = rec.firstWsAfter(t0, 2000);
      out.open_hover_painted_before_ws = ws1 === null ? true : tRow < ws1;
      await sleep(1500);
      // not hovered: move the pointer away first so no intent fires
      await page.mouse.move(700, 400);
      await sleep(300);
      const href = await links.nth(2).getAttribute("href");
      await markOldRows(page);
      t0 = now();
      await page.evaluate((h) => {
        const a = document.querySelector(`a[href="${h}"]`);
        a && a.click();
      }, href);
      await page.waitForURL((u) => u.pathname === href, { timeout: 30000 });
      out.open_nohover_url_ms = now() - t0;
      await waitRows(page, 1);
      out.open_nohover_first_row_ms = now() - t0;
      await sleep(1500);
    }
  }

  // 4. new chat: first send
  let createdHref = null;
  out.stage = "new-chat";
  {
    await page.getByRole("button", { name: "New chat" }).click();
    await page.waitForURL(/\/chat\/?$/, { timeout: 15000 }).catch(() => {});
    const composer = page.locator("#chat-composer");
    await composer.fill("Reply with exactly the word: PONG");
    const stop = page.getByRole("button", { name: "Stop generating" });
    const t0 = now();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (sel) => [...document.querySelectorAll(sel)].some((r) => r.classList.contains("items-end") && /PONG/.test(r.innerText)),
      ROW,
      { timeout: 30000, polling: "raf" },
    );
    out.newchat_echo_ms = now() - t0;
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 30000 });
    out.newchat_url_ms = now() - t0;
    createdHref = new URL(page.url()).pathname;
    await waitAck(page, stop);
    out.newchat_ack_ms = now() - t0;
    await waitAssistantText(page);
    out.newchat_first_token_ms = now() - t0;
    await settle(page);
    out.newchat_done_ms = now() - t0;
    out.newchat_ws_bytes = rec.wsBytesBetween(t0, now());
    out.newchat_requests = rec.since(t0).filter((r) => r.t <= t0 + out.newchat_ack_ms).map((r) => `${r.method} ${shortUrl(r.url)} ${r.status ?? "-"}`);
  }

  // 5. existing thread: second send
  out.stage = "send";
  {
    const composer = page.locator("#chat-composer");
    await composer.fill("Reply with exactly the word: PING");
    const stop = page.getByRole("button", { name: "Stop generating" });
    const t0 = now();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (sel) => [...document.querySelectorAll(sel)].some((r) => r.classList.contains("items-end") && /PING/.test(r.innerText)),
      ROW,
      { timeout: 30000, polling: "raf" },
    );
    out.send_echo_ms = now() - t0;
    await waitAck(page, stop);
    out.send_ack_ms = now() - t0;
    await waitAssistantText(page);
    out.send_first_token_ms = now() - t0;
    await settle(page);
    out.send_done_ms = now() - t0;
    out.send_ws_bytes = rec.wsBytesBetween(t0, now());
  }

  // 6. hover sweep: how many transcript fetches does a fast sweep cost?
  out.stage = "sweep";
  {
    const links = page.locator('a[href^="/chat/"]');
    const n = Math.min(await links.count(), 10);
    const t0 = now();
    for (let k = 0; k < n; k++) {
      await links.nth(k).hover();
      await sleep(60);
    }
    await page.mouse.move(700, 400);
    await sleep(2500);
    out.sweep_ws_bytes = rec.wsBytesBetween(t0, now());
  }

  // cleanup: delete the chat this run created
  if (createdHref) {
    try {
      await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded" });
      await page.locator("#chat-composer").waitFor({ timeout: 20000 });
      out.cleanup = await deleteThread(page, createdHref);
    } catch (e) {
      out.cleanup = `failed: ${String(e).slice(0, 80)}`;
    }
  }

  out.ws_frames_dropped = dropped.length - droppedBefore;
  if (out.ws_frames_dropped) out.ws_drop_samples = dropped.slice(droppedBefore, droppedBefore + 3);
  await context.close();
  return out;
}

async function selfCheck(browser) {
  // Does CDP throttling apply to WebSocket frames? Compare send→ack with and
  // without the profile. Run once each; the difference should be ≈ 2×latency.
  console.log("self-check: run --profile us and --profile india once each and compare send_ack_ms;");
  console.log("if india − us ≈ 2×260 ms the WebSocket is throttled; if ≈ 0 it is NOT and WS numbers must be discounted.");
}

(async () => {
  const b = await chromium.launch({ headless: false, channel: process.env.PW_CHANNEL || undefined });
  if (SELF_CHECK) {
    await selfCheck(b);
    await b.close();
    return;
  }
  const runs = [];
  for (let i = 1; i <= RUNS; i++) {
    try {
      const r = await oneRun(b, i);
      runs.push(r);
      console.log(
        `run ${i}: login_dcl=${fmt(r.login_dcl_ms)} signin_url=${fmt(r.signin_url_ms)} composer=${fmt(r.signin_composer_ms)} ` +
          `open_hover=${fmt(r.open_hover_first_row_ms)} open_nohover=${fmt(r.open_nohover_first_row_ms)} ` +
          `new_echo=${fmt(r.newchat_echo_ms)} new_ack=${fmt(r.newchat_ack_ms)} new_tok=${fmt(r.newchat_first_token_ms)} ` +
          `send_ack=${fmt(r.send_ack_ms)} send_tok=${fmt(r.send_first_token_ms)} errors=${r.errors.length}`,
      );
    } catch (e) {
      console.log(`run ${i}: FAILED at stage ${e.partial?.stage} url=${e.partial?.url} rows=${e.partial?.rows} — ${String(e).slice(0, 160)}`);
      runs.push({ run: i, failed: String(e).slice(0, 300), errors: e.partial?.errors ?? [], ...e.partial });
    }
  }
  await b.close();

  const ok = runs.filter((r) => !r.failed);
  const keys = [
    "login_ttfb_ms",
    "login_dcl_ms",
    "login_load_ms",
    "login_requests",
    "login_bytes",
    "login_fonts",
    "signin_url_ms",
    "signin_composer_ms",
    "signin_rail_ms",
    "signin_sequential_dynamic",
    "open_hover_first_row_ms",
    "open_hover_url_ms",
    "open_nohover_url_ms",
    "open_nohover_first_row_ms",
    "newchat_echo_ms",
    "newchat_url_ms",
    "newchat_ack_ms",
    "newchat_first_token_ms",
    "newchat_done_ms",
    "newchat_ws_bytes",
    "send_echo_ms",
    "send_ack_ms",
    "send_first_token_ms",
    "send_done_ms",
    "send_ws_bytes",
    "sweep_ws_bytes",
  ];
  const summary = {};
  console.log(`\n== ${LABEL} / ${PROFILE} — ${ok.length}/${runs.length} runs ok ==`);
  console.log(`${"metric".padEnd(28)} ${"median".padStart(8)} ${"p90".padStart(8)} ${"min".padStart(8)} ${"max".padStart(8)}`);
  for (const k of keys) {
    const v = ok.map((r) => r[k]).filter((x) => typeof x === "number");
    summary[k] = { median: pct(v, 0.5), p90: pct(v, 0.9), min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null, n: v.length };
    console.log(`${k.padEnd(28)} ${fmt(summary[k].median).padStart(8)} ${fmt(summary[k].p90).padStart(8)} ${fmt(summary[k].min).padStart(8)} ${fmt(summary[k].max).padStart(8)}`);
  }
  const painted = ok.map((r) => r.open_hover_painted_before_ws).filter((x) => typeof x === "boolean");
  summary.open_hover_painted_before_ws = painted.length ? painted.filter(Boolean).length / painted.length : null;
  console.log(`open_hover_painted_before_ws   ${summary.open_hover_painted_before_ws === null ? "n/a" : Math.round(summary.open_hover_painted_before_ws * 100) + "%"}`);
  const errs = ok.reduce((s, r) => s + r.errors.length, 0);
  console.log(`console errors across runs: ${errs}`);
  if (ok[0]) {
    console.log("\nsign-in request sequence (run 1):");
    for (const s of ok[0].signin_requests || []) console.log("  " + s);
    console.log("new-chat requests until ack (run 1):");
    for (const s of ok[0].newchat_requests || []) console.log("  " + s);
  }
  if (P) console.log("\ncaveat: emulation adds the RTT to edge-cached static files too — cold-load numbers are pessimistic vs a real Indian user; dynamic/WS numbers are representative.");
  fs.mkdirSync(path.join(__dirname, ".perf"), { recursive: true });
  const file = path.join(__dirname, ".perf", `${LABEL}-${PROFILE}.json`);
  fs.writeFileSync(file, JSON.stringify({ label: LABEL, profile: PROFILE, base: BASE, at: new Date().toISOString(), summary, runs }, null, 2));
  console.log(`\nwrote ${file}`);
})();
