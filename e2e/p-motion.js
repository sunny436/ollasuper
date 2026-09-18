// Verify the four things the other suites cannot judge.
//
// The load-bearing one is (2): the composer must ANIMATE to the bottom while the
// URL changes from /chat to /chat/<id>. Those are different route segments, so if
// the composer still lived in ChatPane the subtree would remount mid-flight and
// the spring would snap. Counting intermediate positions is what tells the two
// apart — a snap yields one jump, a spring yields a run of frames.
//
// Checks:
//   1. the composer is CENTRED on an empty thread
//   2. it ANIMATES (not snaps) to the bottom on first send, and survives the
//      /chat -> /chat/<id> URL change while doing so
//   3. a fast reply finishes revealing shortly after the stream ends
//   4. a thread with history mounts already-docked (no fly-up on load)
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const { email: EMAIL, password: PASSWORD } = require("./creds").account();

const box = (page) =>
  page.evaluate(() => {
    const ta = document.querySelector("#chat-composer");
    if (!ta) return null;
    const r = ta.getBoundingClientRect();
    return { top: Math.round(r.top), h: window.innerHeight };
  });

(async () => {
  const b = await chromium.launch({ headless: true });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);

  // ---- 1. centred on an empty thread -------------------------------------
  await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 20000 });
  await page.waitForTimeout(2500);
  const start = await box(page);
  const centreBand = [start.h * 0.25, start.h * 0.75];
  const isCentred = start.top > centreBand[0] && start.top < centreBand[1];
  console.log(`1. empty thread: composer top=${start.top} of ${start.h}  -> ${isCentred ? "CENTRED ✓" : "NOT centred ✗"}`);

  // ---- 2. animates to the bottom, across the URL change ------------------
  const urlBefore = page.url();
  await page.locator("#chat-composer").fill("Reply with exactly the word: PONG");
  await page.keyboard.press("Enter");

  // Sample the composer position every 40ms. A SNAP shows one huge jump; a
  // spring shows a run of intermediate positions.
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 2600) {
    const s = await box(page).catch(() => null);
    if (s) samples.push(s.top);
    await page.waitForTimeout(40);
  }
  const urlAfter = page.url();
  const moved = Math.abs(samples[0] - samples[samples.length - 1]);
  const uniq = [...new Set(samples)].length;
  console.log(`2. url ${urlBefore.split("/").pop()} -> ${urlAfter.split("/").pop()}  (changed: ${urlBefore !== urlAfter ? "yes ✓" : "NO ✗"})`);
  console.log(`   composer moved ${moved}px over ${uniq} distinct positions`);
  console.log(`   -> ${uniq >= 5 ? "ANIMATED ✓ (intermediate frames observed)" : "SNAPPED ✗ (no intermediate frames)"}`);
  console.log(`   final top=${samples[samples.length - 1]} (docked near ${start.h})`);

  // ---- 3. reveal keeps up with the stream --------------------------------
  const stop = page.getByRole("button", { name: "Stop generating" });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && (await stop.count()) > 0) await page.waitForTimeout(100);
  const streamEnded = Date.now();
  await page.waitForFunction(() => document.body.innerText.includes("PONG"), { timeout: 20000 });
  console.log(`3. text complete ${Date.now() - streamEnded}ms after the stream ended -> ${Date.now() - streamEnded < 1500 ? "KEEPS UP ✓" : "LAGS ✗"}`);

  // ---- 4. a thread with history mounts docked, no fly-up -----------------
  const threadUrl = page.url();
  await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 20000 });
  const early = await box(page);
  await page.waitForTimeout(1800);
  const late = await box(page);
  const drift = Math.abs(early.top - late.top);
  console.log(`4. reload with history: top ${early.top} -> ${late.top} (drift ${drift}px) -> ${drift < 40 ? "NO fly-up ✓" : "FLEW UP ✗"}`);

  console.log(`\nconsole errors: ${errs.length}`);
  errs.slice(0, 5).forEach((e) => console.log("  - " + e.slice(0, 160)));
  await b.close();
})().catch((e) => { console.error("FATAL " + e.message); process.exit(1); });
