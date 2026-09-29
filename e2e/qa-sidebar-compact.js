// The workspace rail, ChatGPT-style: a compact primary nav and the collapse
// toggle inside the rail's own header. ONE focused check, desktop + phone, run
// against a deployed stack in a real (headed) Chromium.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-sidebar-compact.js
//   BASELINE=1 …  measure only (the build before the change fails the checks
//                 by design: this records its numbers for the comparison)
//
// Desktop 1280x800: nav gaps, the toggle inside the rail header (right-most,
// centred on the brand), exactly one visible toggle in each state, collapse and
// expand by mouse AND keyboard with focus handed to the replacement control,
// persistence across a reload — on /chat, /library, /projects, /scheduled
// (+ one project page when the account has one). Phone 390x844 (touch): the
// page opener opens the drawer, the header toggle closes it (44px target,
// focus back on the opener), backdrop and Escape still close it. Both: no
// horizontal overflow, zero console errors, screenshots.
const path = require("node:path");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const BASELINE = process.env.BASELINE === "1";
const OUT = process.env.OUT_DIR || path.join(__dirname, "out", "sidebar-compact");
const HIDE = "Hide conversations";
const TOGGLE_NAMES = [HIDE, "Open conversations", "Show conversations"];

let fails = 0;
function check(name, ok, detail = "") {
  if (BASELINE) return console.log(`  measure  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  // Fill only after hydration, or the form submits empty.
  await page.waitForFunction(() => {
    const f = document.querySelector("form");
    return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber"));
  }, null, { timeout: 30000 });
  await page.locator('input[type="email"]').first().fill(process.env.QA_EMAIL);
  await page.locator('input[type="password"]').first().fill(process.env.QA_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 90000, waitUntil: "commit" });
}

// Geometry of the rail, read in the page. Everything is located from the rail
// itself, never by position.
function layout(page) {
  return page.evaluate((names) => {
    const nav = document.querySelector('nav[aria-label="Conversations"]');
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
    };
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const newChat = [...nav.querySelectorAll("button")].find((b) => b.textContent.trim() === "New chat");
    const link = (s) => nav.querySelector(`a[href$="${s}"]`);
    // The first history group label; on an account with no conversations,
    // the list's first element (its empty state) — the same section edge.
    const hist = nav.querySelector("p.uppercase") ?? nav.querySelector(".overflow-y-auto")?.firstElementChild;
    const toggle = nav.querySelector(`button[aria-label="${names[0]}"]`);
    const search = nav.querySelector('button[aria-label="Search chats"]');
    const header = toggle?.parentElement?.parentElement;
    const brand = header?.firstElementChild;
    const toggles = [...document.querySelectorAll("button")].filter(
      (b) => names.includes(b.getAttribute("aria-label")) && shown(b),
    );
    const navBox = box(nav);
    return {
      nav: navBox,
      navShown: shown(nav) && navBox.w > 200,
      newChat: box(newChat),
      library: box(link("library")),
      projects: box(link("projects")),
      scheduled: box(link("scheduled")),
      hist: box(hist),
      toggle: box(toggle),
      toggleInNav: !!toggle && nav.contains(toggle) && shown(toggle),
      search: box(search),
      brand: box(brand),
      visibleToggles: toggles.map((b) => ({
        label: b.getAttribute("aria-label"),
        inNav: nav.contains(b),
      })),
      active: document.activeElement?.getAttribute("aria-label") ?? null,
      activeIsOpener: !!document.activeElement?.hasAttribute("data-rail-opener"),
      activeIsHider: !!document.activeElement?.hasAttribute("data-rail-hider"),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  }, TOGGLE_NAMES);
}

const gap = (a, b) => (a && b ? Math.round((b.top - a.bottom) * 10) / 10 : null);
const mid = (b) => (b.top + b.bottom) / 2;

// The conversation list loads over a subscription: measure only once it has.
async function historyLoaded(page) {
  await page.waitForFunction(() => {
    const n = document.querySelector('nav[aria-label="Conversations"]');
    return !!n && (!!n.querySelector("p.uppercase") || /No conversations yet/.test(n.textContent));
  }, null, { timeout: 20000 }).catch(() => undefined);
}

async function railSettled(page, expanded, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const l = await layout(page);
    if (l.navShown === expanded && l.visibleToggles.length === 1) return l;
    if (Date.now() - t0 > ms) return l;
    await page.waitForTimeout(100);
  }
}

async function waitFocus(page, want, ms = 2000) {
  const t0 = Date.now();
  for (;;) {
    const l = await layout(page);
    if ((want === "opener" && l.activeIsOpener) || (want === "hider" && l.activeIsHider)) return true;
    if (Date.now() - t0 > ms) return false;
    await page.waitForTimeout(50);
  }
}

function gapsReport(tag, l) {
  const g = {
    "new chat→library": gap(l.newChat, l.library),
    "library→projects": gap(l.library, l.projects),
    "projects→scheduled": gap(l.projects, l.scheduled),
    "scheduled→history": gap(l.scheduled, l.hist),
  };
  console.log(`  ${tag} gaps (px): ${JSON.stringify(g)}`);
  return g;
}

function headerChecks(tag, l, { touch }) {
  check(`${tag}: the toggle is inside the rail and visible`, l.toggleInNav);
  if (!l.toggleInNav || !l.toggle) return;
  check(`${tag}: the toggle is the right-most header control`,
    l.search && l.toggle.left >= l.search.right - 0.5 && l.nav.right - l.toggle.right <= 20,
    `toggle.right ${Math.round(l.toggle.right)}, rail.right ${Math.round(l.nav.right)}`);
  const d = Math.abs(mid(l.toggle) - mid(l.brand));
  check(`${tag}: the toggle is vertically centred on the brand`, d <= 2, `Δ ${d.toFixed(1)}px`);
  if (touch) check(`${tag}: the toggle is a ≥44px touch target`, l.toggle.w >= 44 && l.toggle.h >= 44,
    `${Math.round(l.toggle.w)}x${Math.round(l.toggle.h)}`);
}

async function desktop(browser, errors) {
  console.log("\n=== DESKTOP 1280x800");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`desktop: ${m.text().slice(0, 200)}`));
  page.on("pageerror", (e) => errors.push(`desktop pageerror: ${String(e).slice(0, 200)}`));
  await login(page);
  await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 30000 });
  await historyLoaded(page);
  let l = await railSettled(page, true);
  const g = gapsReport("/chat", l);
  check("new chat→library gap reduced (<20px)", g["new chat→library"] < 20, `${g["new chat→library"]}px`);
  check("library→projects is compact (≤4px)", g["library→projects"] <= 4, `${g["library→projects"]}px`);
  check("projects→scheduled is compact (≤4px)", g["projects→scheduled"] <= 4, `${g["projects→scheduled"]}px`);
  check("scheduled→history keeps a larger section gap (≥16px)", g["scheduled→history"] >= 16, `${g["scheduled→history"]}px`);
  headerChecks("/chat", l, { touch: false });
  check("/chat expanded: exactly one visible toggle, in the rail",
    l.visibleToggles.length === 1 && l.visibleToggles[0].inNav,
    JSON.stringify(l.visibleToggles));
  check("/chat: no horizontal overflow (expanded)", l.overflow <= 0, `${l.overflow}px`);
  await page.screenshot({ path: path.join(OUT, `${BASELINE ? "before" : "after"}-desktop-expanded.png`) });
  if (BASELINE) {
    await ctx.close();
    return;
  }

  // Keyboard: Enter on the header toggle collapses, focus lands on the page
  // opener; Enter again expands, focus lands back on the header toggle.
  await page.locator(`nav button[aria-label="${HIDE}"]`).focus();
  await page.keyboard.press("Enter");
  l = await railSettled(page, false);
  check("keyboard: Enter on the header toggle collapses the rail", !l.navShown);
  check("keyboard: focus is handed to the page opener", await waitFocus(page, "opener"));
  l = await layout(page);
  check("/chat collapsed: exactly one visible toggle, outside the rail",
    l.visibleToggles.length === 1 && !l.visibleToggles[0].inNav, JSON.stringify(l.visibleToggles));
  check("/chat: no horizontal overflow (collapsed)", l.overflow <= 0, `${l.overflow}px`);
  await page.screenshot({ path: path.join(OUT, "after-desktop-collapsed.png") });
  await page.keyboard.press("Enter");
  l = await railSettled(page, true);
  check("keyboard: Enter on the page opener expands the rail", l.navShown);
  check("keyboard: focus is handed back to the header toggle", await waitFocus(page, "hider"));

  // Persistence: collapse by mouse, reload, still collapsed; reopen by mouse.
  await page.locator(`nav button[aria-label="${HIDE}"]`).click();
  await railSettled(page, false);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 30000 });
  l = await railSettled(page, false);
  check("collapsed state survives a reload", !l.navShown && l.visibleToggles.length === 1);
  await page.getByRole("button", { name: "Open conversations" }).click();
  l = await railSettled(page, true);
  check("mouse: the page opener re-expands the rail", l.navShown);

  // The other panes, both collapsed-label variants.
  const routes = ["/en/library", "/en/projects", "/en/scheduled"];
  const project = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a[href*="/projects/"]')][0];
    return a ? new URL(a.href).pathname : null;
  });
  if (project) routes.push(project);
  for (const r of routes) {
    await page.goto(`${BASE}${r}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
    l = await railSettled(page, true);
    check(`${r} expanded: one visible toggle, in the rail header`,
      l.visibleToggles.length === 1 && l.visibleToggles[0].inNav, JSON.stringify(l.visibleToggles));
    await page.locator(`nav button[aria-label="${HIDE}"]`).click();
    l = await railSettled(page, false);
    const opener = l.visibleToggles[0]?.label;
    check(`${r} collapsed: one visible opener, outside the rail`,
      !l.navShown && l.visibleToggles.length === 1 && !l.visibleToggles[0].inNav, opener);
    await page.getByRole("button", { name: opener }).click();
    l = await railSettled(page, true);
    check(`${r}: the opener re-expands the rail`, l.navShown && l.overflow <= 0);
  }
  if (!project) console.log("  (no project on this account: /projects/<id> not checked)");
  await ctx.close();
}

async function phone(browser, errors) {
  console.log("\n=== PHONE 390x844 (touch)");
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`phone: ${m.text().slice(0, 200)}`));
  page.on("pageerror", (e) => errors.push(`phone pageerror: ${String(e).slice(0, 200)}`));
  await login(page);
  await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 30000 });
  const opener = page.locator('button[aria-label="Open conversations"]:visible').first();
  const openDrawer = async () => {
    await opener.tap();
    await page.waitForFunction(() => {
      const n = document.querySelector('nav[aria-label="Conversations"]');
      return n && n.getBoundingClientRect().width > 200;
    }, null, { timeout: 5000 });
  };
  const drawerOpen = () => page.evaluate(() => {
    const n = document.querySelector('nav[aria-label="Conversations"]');
    return !!n && n.getBoundingClientRect().width > 200;
  });
  await openDrawer();
  await historyLoaded(page);
  const l = await layout(page);
  gapsReport("drawer", l);
  check("drawer: library→projects is compact (≤4px)", gap(l.library, l.projects) <= 4);
  check("drawer: projects→scheduled is compact (≤4px)", gap(l.projects, l.scheduled) <= 4);
  headerChecks("drawer", l, { touch: true });
  check("phone: no horizontal overflow (drawer open)", l.overflow <= 0, `${l.overflow}px`);
  await page.screenshot({ path: path.join(OUT, `${BASELINE ? "before" : "after"}-phone-drawer.png`) });
  if (BASELINE) {
    await ctx.close();
    return;
  }
  await page.locator(`nav button[aria-label="${HIDE}"]`).tap();
  await page.waitForTimeout(400);
  check("phone: the header toggle closes the drawer", !(await drawerOpen()));
  check("phone: focus returns to the page opener",
    (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Open conversations");
  await openDrawer();
  await page.mouse.click(370, 500); // the backdrop, right of the 272px drawer
  await page.waitForTimeout(400);
  check("phone: the backdrop still closes the drawer", !(await drawerOpen()));
  await openDrawer();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check("phone: Escape still closes the drawer", !(await drawerOpen()));
  check("phone: no horizontal overflow (drawer closed)",
    (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
  await ctx.close();
}

(async () => {
  if (!process.env.QA_EMAIL || !process.env.QA_PASSWORD) throw new Error("QA_EMAIL and QA_PASSWORD must be set");
  require("node:fs").mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: process.env.HEADLESS === "1" });
  const errors = [];
  try {
    await desktop(browser, errors);
    await phone(browser, errors);
  } finally {
    await browser.close();
  }
  console.log(`\nconsole errors: ${errors.length}`);
  for (const e of errors) console.log(`  ${e}`);
  if (!BASELINE) check("zero console errors", errors.length === 0);
  console.log(BASELINE ? "\n=== BASELINE recorded" : `\n=== SIDEBAR COMPACT: ${fails === 0 ? "PASS" : `FAIL (${fails})`} ===`);
  process.exit(BASELINE || fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
