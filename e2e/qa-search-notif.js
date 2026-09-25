// Red-team gate for three UI changes: the Settings label is gone, "Search chats"
// beside the rail's logo, and "Clear all" in the notification centre.
//
//   node qa-search-notif.js <accountA.json> <accountB.json>
//
// Run it on TWO DISPOSABLE accounts from qa-throwaway.js — it deletes a chat,
// clears notifications, and account B creates 22 workspaces to invite A from
// (each invite is one real notification; B's own account deletion removes the
// workspaces, invites and memberships — their audit rows are retained by the
// product's deletion policy). Headed Chrome, zero console errors.
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CONVEX = `${BASE}/__cvx`;
const [FILE_A, FILE_B] = process.argv.slice(2);
if (!FILE_A || !FILE_B) {
  console.error("usage: node qa-search-notif.js <accountA.json> <accountB.json>");
  process.exit(2);
}
const A = JSON.parse(fs.readFileSync(FILE_A, "utf8"));
const B = JSON.parse(fs.readFileSync(FILE_B, "utf8"));
const SHOTS = process.env.SHOTS_DIR || path.join(require("node:os").tmpdir(), "qa-search-notif");
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RAND = Date.now().toString(36);

const failures = [];
const check = (what, cond, detail) => {
  if (!cond) failures.push(what);
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`);
};

const errors = [];
function watch(page, who) {
  page.on("console", (m) => {
    if (m.type() === "error" && !/chromestatus\.com/.test(m.text())) errors.push(`${who}: ${m.text().slice(0, 180)}`);
  });
  page.on("pageerror", (e) => errors.push(`${who} pageerror: ${String(e).slice(0, 180)}`));
}

async function signIn(page, { email, password }) {
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const f = document.querySelector("form");
      return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber"));
    },
    null,
    { timeout: 30000 },
  );
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
}

async function jwtOf(ctx) {
  return (await ctx.cookies()).find((k) => /convexAuthJWT/i.test(k.name)).value;
}

async function call(kind, jwt, fn, args) {
  const r = await fetch(`${CONVEX}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ path: fn, args, format: "json" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status === "error") throw new Error(`${fn}: ${j.errorMessage || r.status}`);
  return j.value;
}

/** Counts Convex subscription `Add` frames per function — the request count. */
async function frameCounter(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  const adds = [];
  cdp.on("Network.webSocketFrameSent", (e) => {
    try {
      const m = JSON.parse(e.response.payloadData);
      if (m.type !== "ModifyQuerySet") return;
      for (const mod of m.modifications || []) if (mod.type === "Add") adds.push({ t: Date.now(), path: mod.udfPath });
    } catch {}
  });
  return { since: (t, p) => adds.filter((a) => a.t >= t && a.path === p).length };
}

const RAIL = 'nav[aria-label="Conversations"]';
const DRAWER = 'nav.fixed[aria-label="Conversations"]';
const COMBO = 'input[role="combobox"][aria-label="Search chats"]';
const OPTIONS = '[role="listbox"] [role="option"]';
const searchDialog = (page) => page.locator('[role="dialog"]').filter({ has: page.locator(COMBO) });

async function optionTexts(page) {
  return page.locator(OPTIONS).evaluateAll((els) => els.map((e) => e.innerText.trim()));
}
async function typeQuery(page, q) {
  await page.locator(COMBO).fill(q);
  await sleep(250);
}
/** Wait until a predicate over the option texts holds (search is async). */
async function waitOptions(page, pred, ms = 8000) {
  const t0 = Date.now();
  let texts = [];
  while (Date.now() - t0 < ms) {
    texts = await optionTexts(page);
    if (pred(texts)) return texts;
    await sleep(150);
  }
  return texts;
}
async function openSearch(page, scope = RAIL) {
  await page.locator(`${scope} button[aria-label="Search chats"]:visible`).first().click();
  await page.locator(COMBO).waitFor({ timeout: 5000 });
}

const bell = (page) => page.locator('button[aria-label="Notifications"]:visible').first();
async function badge(page) {
  const b = page.locator('[aria-label$="unread"]:visible').first();
  if (!(await b.count())) return "";
  return (await b.textContent()).trim();
}
async function waitFor(fn, ms = 10000, step = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}
const panelRows = (page) =>
  page.locator('[role="menu"] p', { hasText: "Workspace invitation" }).count();

// ONLY=settings,search,clear,visual runs a subset. "clear" is the expensive one:
// it needs 21+ fresh notifications, i.e. 21 invites from B.
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);
const on = (s) => !ONLY.length || ONLY.includes(s);

/**
 * Switch theme through the product's own toggle. OS emulation is not enough:
 * an account preference (synced to localStorage) beats the OS, so a "light"
 * screenshot taken under emulateMedia can silently be dark.
 */
async function setTheme(page, mode) {
  const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
  if ((await isDark()) === (mode === "dark")) return;
  await page.locator('button[aria-label="Toggle dark and light theme"]:visible').first().click();
  await waitFor(async () => (await isDark()) === (mode === "dark"), 3000);
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  watch(page, "A");
  watch(pageB, "B");
  const frames = await frameCounter(ctxA, page);

  await signIn(page, A);
  await signIn(pageB, B);
  const jwtA = await jwtOf(ctxA);
  const jwtB = await jwtOf(ctxB);
  const wsA = (await call("query", jwtA, "orgs:myWorkspaces", {}))[0]._id;
  const wsB = (await call("query", jwtB, "orgs:myWorkspaces", {}))[0]._id;

  // Data the checks need, created through each user's OWN session.
  const TITLE = `qa title qattl${RAND}`;
  const titleId = await call("mutation", jwtA, "chat/threads:create", { workspaceId: wsA, title: TITLE });
  const markHost = await call("mutation", jwtA, "chat/threads:create", { workspaceId: wsA, title: "qa marker host" });
  const MARK = `mrk${RAND}`;
  const ISO = `isob${RAND}`;
  await call("mutation", jwtB, "chat/threads:create", { workspaceId: wsB, title: `private ${ISO}` });
  // One real message so there is message TEXT to find (costs one generation).
  if (on("search")) {
    await page.goto(`${BASE}/chat/${markHost}`, { waitUntil: "domcontentloaded" });
    await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
    await page.locator("#chat-composer").fill(`Reply with just the word ok. (search marker ${MARK})`);
    await page.keyboard.press("Enter");
    await page.getByText(MARK).first().waitFor({ timeout: 20000 });
    console.log("data: 2 chats + 1 message for A, 1 private chat for B");
  }

  // ── 1. Settings: the label under the logo is gone, at every size ─────────
  if (on("settings")) {
  console.log("\n[settings]");
  await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
  await page.locator("h1").first().waitFor({ timeout: 15000 });
  await setTheme(page, "light");
  for (const [w, h] of [[1920, 1080], [1280, 800], [820, 1180], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
    await page.locator("h1").first().waitFor({ timeout: 15000 });
    if (w < 768) {
      await page.getByRole("button", { name: "Open settings menu" }).click();
      await sleep(400);
    }
    const r = await page.evaluate(() => {
      const close = [...document.querySelectorAll('a[aria-label="Close settings"]')].find((a) => a.getClientRects().length);
      if (!close) return null;
      const header = close.parentElement;
      const wrap = header.firstElementChild;
      const brand = wrap.firstElementChild;
      const hr = header.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      const br = brand.getBoundingClientRect();
      const cr = close.getBoundingClientRect();
      const texts = [...header.querySelectorAll("*")].filter((e) => e.childElementCount === 0).map((e) => e.textContent.trim()).filter(Boolean);
      return {
        h: Math.round(hr.height),
        // The header can be no taller than its tallest child plus py-4 (32px),
        // and the logo's wrapper no taller than the logo: anything more is the
        // leftover space the removed label would leave behind.
        expected: Math.round(Math.max(br.height, cr.height) + 32),
        extra: Math.round(wr.height - br.height),
        dy: Math.abs(br.top + br.height / 2 - (cr.top + cr.height / 2)),
        texts,
      };
    });
    check(
      `${w}x${h}: settings header is logo + close only, aligned, no leftover gap`,
      !!r && !r.texts.includes("Settings") && r.dy <= 2 && r.extra <= 0 && r.h <= r.expected + 1,
      r ? `height ${r.h}px (expected ${r.expected}), ${r.extra}px under the logo, centre offset ${r.dy.toFixed(1)}px, text ${JSON.stringify(r.texts)}` : "no header",
    );
    if (w === 1280 || w === 390) await page.screenshot({ path: path.join(SHOTS, `settings-${w}-light.png`) });
  }
  // Dark: switch while the drawer is closed (its overlay covers the toggle).
  await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
  await page.locator("h1").first().waitFor({ timeout: 15000 });
  await setTheme(page, "dark");
  await page.getByRole("button", { name: "Open settings menu" }).click();
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, "settings-390-dark.png") });
  await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
  await page.locator("h1").first().waitFor({ timeout: 15000 });
  await setTheme(page, "light");
  }

  // ── 2. Search button placement, at every size ────────────────────────────
  if (on("search")) {
  console.log("\n[search button]");
  for (const [w, h] of [[1920, 1080], [1280, 800], [820, 1180], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
    let scope = RAIL;
    if (w < 768) {
      await page.locator('button[aria-label="Open conversations"]:visible').first().click();
      await page.locator(DRAWER).waitFor({ timeout: 5000 });
      scope = DRAWER;
    }
    const r = await page.evaluate((sel) => {
      const nav = [...document.querySelectorAll(sel)].find((n) => n.getClientRects().length);
      const btn = nav?.querySelector('button[aria-label="Search chats"]');
      if (!btn) return null;
      const header = btn.parentElement;
      const brand = header.firstElementChild;
      const b = btn.getBoundingClientRect();
      const g = brand.getBoundingClientRect();
      const n = nav.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return {
        right: b.left >= g.right, inside: b.right <= n.right + 0.5 && b.left >= n.left,
        dy: Math.abs(b.top + b.height / 2 - (g.top + g.height / 2)),
        uncovered: hit === btn || btn.contains(hit), w: Math.round(b.width),
      };
    }, scope);
    check(
      `${w}x${h}: "Search chats" sits right of the logo, on its row, uncovered`,
      !!r && r.right && r.inside && r.dy <= 4 && r.uncovered,
      r ? `centre offset ${r.dy.toFixed(1)}px, ${r.w}px wide` : "button not found",
    );
  }

  // ── 3. Search behaviour (1280, light) ────────────────────────────────────
  console.log("\n[search]");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });

  // Keyboard reachability: Tab from the top of the page lands on the button,
  // with a visible focus ring, and Enter opens the modal.
  await setTheme(page, "light");
  await page.evaluate(() => document.activeElement?.blur());
  let reached = false;
  let ring = "none";
  for (let i = 0; i < 6 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Search chats";
  }
  if (reached) {
    // `transition` animates box-shadow over 150ms; read the settled ring.
    await sleep(300);
    ring = await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow);
  }
  check("keyboard: Tab reaches the button with a visible focus ring", reached && /0px 0px 0px 2px/.test(ring), ring.slice(0, 90));
  await page.keyboard.press("Enter");
  await page.locator(COMBO).waitFor({ timeout: 5000 });
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("role"));
  const recents = await optionTexts(page);
  check("Enter opens the modal with the input focused and recent chats listed", focused === "combobox" && recents.length > 0, `${recents.length} recent`);
  await page.screenshot({ path: path.join(SHOTS, "search-1280-recents-light.png") });

  let t = Date.now();
  await typeQuery(page, "a");
  await sleep(800);
  check("one character sends no search request", frames.since(t, "chat/search:combined") === 0);

  t = Date.now();
  await typeQuery(page, `qattl${RAND}`);
  let texts = await waitOptions(page, (x) => x.some((s) => s.includes(TITLE)));
  check("title search finds the chat", texts.some((s) => s.includes(TITLE)), `${texts.length} result(s)`);
  check("…with one request for the settled query, not one per keystroke", frames.since(t, "chat/search:combined") <= 2, `${frames.since(t, "chat/search:combined")} Add frame(s)`);

  await typeQuery(page, MARK);
  texts = await waitOptions(page, (x) => x.some((s) => s.includes(MARK)), 15000);
  const hit = await page.locator(OPTIONS).filter({ hasText: MARK }).first().getAttribute("href").catch(() => null);
  check("message-text search finds the chat, with a snippet", hit === `/chat/${markHost}` && texts.some((s) => s.split(String.fromCharCode(10)).length >= 2 && s.includes(MARK)), texts[0]?.split(String.fromCharCode(10)).join(" | ").slice(0, 90));
  await page.screenshot({ path: path.join(SHOTS, "search-1280-snippet-light.png") });
  await page.locator(OPTIONS).filter({ hasText: MARK }).first().click();
  await page.waitForURL(new RegExp(`/chat/${markHost}`), { timeout: 10000 });
  check("clicking a result opens that chat and closes the modal", await waitFor(async () => (await searchDialog(page).count()) === 0, 2000));

  // Arrow keys move the highlight; Enter opens the highlighted chat.
  await openSearch(page);
  await typeQuery(page, "seed");
  texts = await waitOptions(page, (x) => x.length >= 3);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  const sel = await page.evaluate(() => {
    const opts = [...document.querySelectorAll('[role="listbox"] [role="option"]')];
    const i = opts.findIndex((o) => o.getAttribute("aria-selected") === "true");
    const input = document.querySelector('input[role="combobox"]');
    return {
      i, href: opts[i]?.getAttribute("href"),
      desc: input.getAttribute("aria-activedescendant") === opts[i]?.id,
      tabbable: opts.filter((o) => o.tabIndex >= 0).length,
    };
  });
  check("↓↓↑ highlights the 2nd result, announced via aria-activedescendant", sel.i === 1 && sel.desc, `index ${sel.i}`);
  check("results are not Tab stops (listbox pattern)", sel.tabbable === 0);
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => u.pathname.endsWith(sel.href), { timeout: 10000 }).catch(() => {});
  check("Enter opens the highlighted chat", page.url().endsWith(sel.href), page.url().replace(BASE, ""));

  await openSearch(page);
  await typeQuery(page, `zzqqxx nomatch ${RAND}`);
  const none = await waitFor(() => page.getByText("No chats found").isVisible(), 8000);
  check('gibberish shows "No chats found"', none);

  // Hostile input renders as text; nothing executes, nothing breaks.
  for (const q of ['<img src=x onerror="window.__xss=1">', ".*[(", "नमस्ते 你好 🚀", "word ".repeat(60)]) {
    await typeQuery(page, q);
    await sleep(900);
  }
  const hostile = await page.evaluate(() => ({
    xss: window.__xss === 1,
    img: !!document.querySelector('[role="dialog"] img[src="x"]'),
    len: document.querySelector('input[role="combobox"]').value.length,
  }));
  check("HTML/regex/unicode/60-word queries: no execution, no injected node, capped at 200 chars", !hostile.xss && !hostile.img && hostile.len <= 200, `value length ${hostile.len}`);

  await page.keyboard.press("Escape");
  await sleep(300);
  const back = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  check("Escape closes the modal and returns focus to the button", (await searchDialog(page).count()) === 0 && back === "Search chats", `focus on ${back}`);

  await openSearch(page);
  await page.mouse.click(1250, 780); // the overlay, well outside the top-anchored box
  await sleep(300);
  check("clicking the overlay closes the modal", (await searchDialog(page).count()) === 0);

  // A chat deleted while its result is on screen drops out, live.
  await openSearch(page);
  await typeQuery(page, `qattl${RAND}`);
  await waitOptions(page, (x) => x.some((s) => s.includes(TITLE)));
  await call("mutation", jwtA, "chat/threads:remove", { threadId: titleId });
  const gone = await waitFor(async () => !(await optionTexts(page)).some((s) => s.includes(TITLE)), 8000);
  check("a chat deleted while listed drops out of the results", gone);

  // Isolation: B's chat is indexed (B finds it) and A never does.
  const bSees = await call("query", jwtB, "chat/search:combined", { workspaceId: wsB, query: ISO });
  const aSees = await call("query", jwtA, "chat/search:combined", { workspaceId: wsA, query: ISO });
  await typeQuery(page, ISO);
  const aUi = await waitFor(() => page.getByText("No chats found").isVisible(), 8000);
  check("isolation: B's private chat is findable by B, never by A (API and UI)", bSees.length >= 1 && aSees.length === 0 && aUi, `B ${bSees.length}, A ${aSees.length}`);
  await page.keyboard.press("Escape");
  await sleep(300);
  await setTheme(page, "dark");
  await openSearch(page);
  await typeQuery(page, "seed");
  await waitOptions(page, (x) => x.length >= 3);
  await page.screenshot({ path: path.join(SHOTS, "search-1280-dark.png") });
  await page.keyboard.press("Escape");
  await sleep(300);
  await setTheme(page, "light");

  // ── 4. Search on a phone, inside the drawer ──────────────────────────────
  console.log("\n[search, 390x844]");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  await page.locator('button[aria-label="Open conversations"]:visible').first().click();
  await page.locator(DRAWER).waitFor({ timeout: 5000 });
  await openSearch(page, DRAWER);
  await typeQuery(page, "seed");
  await waitOptions(page, (x) => x.length >= 3);
  const fit = await page.evaluate(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => x.querySelector('input[role="combobox"]'));
    const r = d.getBoundingClientRect();
    return {
      ok: r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      rect: `${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)} in ${innerWidth}x${innerHeight}`,
    };
  });
  check("390x844: the modal fits the viewport, no horizontal overflow", fit.ok && !fit.overflow, fit.rect);
  await page.screenshot({ path: path.join(SHOTS, "search-390-light.png") });
  await page.keyboard.press("Escape");
  await sleep(400);
  const drawerStays = (await searchDialog(page).count()) === 0 && (await page.locator(DRAWER).count()) === 1;
  await page.keyboard.press("Escape");
  await sleep(400);
  const drawerGoes = (await page.locator(DRAWER).count()) === 0;
  check("Escape closes only the modal; a second Escape closes the drawer", drawerStays && drawerGoes);
  // Dark, on the phone: switch while the drawer is closed, then reopen.
  await setTheme(page, "dark");
  await page.locator('button[aria-label="Open conversations"]:visible').first().click();
  await page.locator(DRAWER).waitFor({ timeout: 5000 });
  await openSearch(page, DRAWER);
  await typeQuery(page, "seed");
  await waitOptions(page, (x) => x.length >= 3);
  await page.screenshot({ path: path.join(SHOTS, "search-390-dark.png") });
  await page.keyboard.press("Escape");
  await sleep(300);
  await page.keyboard.press("Escape");
  await sleep(300);
  await setTheme(page, "light");
  await page.locator('button[aria-label="Open conversations"]:visible').first().click();
  await page.locator(DRAWER).waitFor({ timeout: 5000 });
  await openSearch(page, DRAWER);
  const firstHref = await page.locator(OPTIONS).first().getAttribute("href");
  await page.locator(OPTIONS).first().click();
  await page.waitForURL((u) => u.pathname.endsWith(firstHref), { timeout: 10000 }).catch(() => {});
  await sleep(500);
  check("picking a result on a phone opens it and closes the drawer", page.url().endsWith(firstHref) && (await page.locator(DRAWER).count()) === 0);

  }

  // ── 5. Clear all ──────────────────────────────────────────────────────────
  if (on("clear")) {
  console.log("\n[clear all]");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  const mine = (await call("query", jwtB, "orgs:myWorkspaces", {})).filter((w) => /^qa-notif-/.test(w.name));
  const pool = mine.map((w) => w._id);
  for (let i = pool.length; i < 22; i++) {
    pool.push(await call("mutation", jwtB, "orgs:createWorkspace", { name: `qa-notif-${RAND}-${i + 1}` }));
  }
  const lastWs = pool.pop();
  console.log(`  inviting from ${pool.length} workspaces (${mine.length} reused)`);
  for (const ws of pool) {
    await call("mutation", jwtB, "orgs:invite", { workspaceId: ws, email: A.email, role: "member" });
  }
  check("21+ real invitations reach A without a reload", await waitFor(async () => (await badge(page)) === "9+", 20000), `badge "${await badge(page)}"`);

  await bell(page).click();
  await page.locator('[role="menu"]').waitFor({ timeout: 5000 });
  await waitFor(async () => (await panelRows(page)) === 20, 8000);
  check(
    'panel: 20 rows, "Show older", and a "Clear all" item',
    (await panelRows(page)) === 20 &&
      (await page.getByRole("button", { name: "Show older" }).count()) === 1 &&
      (await page.getByRole("menuitem", { name: "Clear all" }).count()) === 1,
  );
  await page.screenshot({ path: path.join(SHOTS, "notif-1280-light.png") });
  await page.keyboard.press("Escape");
  await sleep(300);

  // Keyboard: open by keyboard → the item has focus → Enter → Cancel has focus.
  await bell(page).focus();
  await page.keyboard.press("Enter");
  await sleep(400);
  const onItem = await page.evaluate(() => document.activeElement?.textContent?.trim());
  await page.keyboard.press("Enter");
  await page.getByText("Clear all notifications?").waitFor({ timeout: 5000 });
  const onCancel = await page.evaluate(() => document.activeElement?.textContent?.trim());
  await page.keyboard.press("Escape");
  await sleep(400);
  const dialogGone = (await page.getByText("Clear all notifications?").count()) === 0;
  const menuStays = (await page.locator('[role="menu"]').count()) === 1;
  await page.keyboard.press("Escape");
  await sleep(400);
  check(
    "keyboard: item focused on open, Enter confirms with Cancel focused, Esc closes dialog then panel",
    onItem === "Clear all" && onCancel === "Cancel" && dialogGone && menuStays && (await page.locator('[role="menu"]').count()) === 0,
    `focus "${onItem}" → "${onCancel}"`,
  );
  check("…and nothing was cleared", (await badge(page)) === "9+");

  await bell(page).click();
  await page.getByRole("menuitem", { name: "Clear all" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await sleep(500);
  check("Cancel keeps every notification", (await panelRows(page)) === 20 && (await badge(page)) === "9+");

  // Go to the OLDER page — the case where a careless reset would flash rows back.
  await page.getByRole("button", { name: "Show older" }).click();
  const older = await waitFor(async () => (await panelRows(page)) >= 1 && (await page.getByRole("button", { name: "Back to latest" }).count()) === 1, 8000);
  check('"Show older" pages to the older rows', older, `${await panelRows(page)} older row(s)`);
  const page2 = await ctxA.newPage();
  watch(page2, "A/tab2");
  await page2.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
  await page2.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  await bell(page2).click();
  await waitFor(async () => (await panelRows(page2)) === 20, 8000);
  check("second tab shows the same 20 before the clear", (await panelRows(page2)) === 20);
  await page.bringToFront();

  await page.getByRole("menuitem", { name: "Clear all" }).click();
  const confirm = page.getByRole("dialog").getByRole("button", { name: "Clear all", exact: true });
  const t0 = Date.now();
  await confirm.click();
  let emptyAt = 0;
  let maxRows = 0;
  while (Date.now() - t0 < 3000) {
    const n = await panelRows(page);
    maxRows = Math.max(maxRows, n);
    if (!emptyAt && (await page.getByText("No notifications").count())) emptyAt = Date.now() - t0;
    await sleep(40);
  }
  check('confirm → "No notifications" immediately', emptyAt > 0 && emptyAt < 600, `${emptyAt} ms`);
  check("no pre-clear row flashes back while it resolves", maxRows === 0, `max rows seen ${maxRows}`);
  check(
    'badge, "Show older", "Back to latest" and "Clear all" all gone',
    (await badge(page)) === "" &&
      (await page.getByRole("button", { name: "Show older" }).count()) === 0 &&
      (await page.getByRole("button", { name: "Back to latest" }).count()) === 0 &&
      (await page.getByRole("menuitem", { name: "Clear all" }).count()) === 0,
  );
  const tab2 = await waitFor(async () => (await badge(page2)) === "" && (await page2.getByText("No notifications").count()) === 1, 8000);
  check("the second tab empties on its own, no reload", tab2);
  await page2.close();

  await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  await sleep(1500);
  await bell(page).click();
  await page.getByText("No notifications").waitFor({ timeout: 8000 }).catch(() => {});
  check("after a reload it is still empty (persisted server-side)", (await badge(page)) === "" && (await page.getByText("No notifications").count()) === 1);
  await page.keyboard.press("Escape");

  await call("mutation", jwtB, "orgs:invite", { workspaceId: lastWs, email: A.email, role: "member" });
  check("a NEW notification still arrives after the clear, live", await waitFor(async () => (await badge(page)) === "1", 15000), `badge "${await badge(page)}"`);
  }

  // ── 6. Visual: the popover and its confirmation, light + dark, 1280 + 390 ─
  if (on("visual")) {
    console.log("\n[visual]");
    for (const [w, h] of [[1280, 800], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
      await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
      for (const mode of ["light", "dark"]) {
        await setTheme(page, mode);
        await bell(page).click();
        await page.locator('[role="menu"]').waitFor({ timeout: 5000 });
        await sleep(600);
        const menuFit = await page.evaluate(() => {
          const r = document.querySelector('[role="menu"]').getBoundingClientRect();
          return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        });
        await page.screenshot({ path: path.join(SHOTS, `notif-${w}-${mode}.png`) });
        let dialogFit = true;
        if (await page.getByRole("menuitem", { name: "Clear all" }).count()) {
          await page.getByRole("menuitem", { name: "Clear all" }).click();
          await page.getByText("Clear all notifications?").waitFor({ timeout: 5000 });
          await sleep(300);
          dialogFit = await page.evaluate(() => {
            const d = [...document.querySelectorAll('[role="dialog"]')].pop();
            const r = d.getBoundingClientRect();
            return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
          });
          await page.screenshot({ path: path.join(SHOTS, `notif-confirm-${w}-${mode}.png`) });
          await page.getByRole("button", { name: "Cancel" }).click();
          await sleep(300);
        }
        await page.keyboard.press("Escape");
        await sleep(300);
        check(`${w}x${h} ${mode}: popover and confirmation fit the viewport`, menuFit && dialogFit);
      }
      await setTheme(page, "light");
    }
  }

  await browser.close();
  for (const e of errors.slice(0, 8)) console.log("CONSOLE", e);
  console.log(`\nscreenshots: ${SHOTS}`);
  console.log(`\n===== SEARCH + NOTIFICATIONS RED TEAM: ${failures.length ? "FAIL" : "PASS"} | failures: ${failures.length} | console errors: ${errors.length} =====`);
  if (failures.length) console.log("failed: " + failures.join(" | "));
  if (failures.length || errors.length) process.exitCode = 1;
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
