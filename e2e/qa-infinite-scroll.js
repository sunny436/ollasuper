// Infinite scroll in the conversation rail, the account menu, and the 3-dot
// conversation menu — the acceptance gate for all three.
//
// House style: standalone node script, headed Chrome, zero console errors.
//
//   node qa-infinite-scroll.js
//
// HOW REQUESTS ARE COUNTED. Convex's usePaginatedQuery opens ONE subscription
// per page (each page is its own `paginate` call keyed by cursor), sent as a
// `ModifyQuerySet` frame with an `Add` for `chat/threads:list`. So counting
// those Adds over CDP *is* counting pagination requests: one per page is
// correct, anything more is a duplicate, and any Add after the end is a leak.
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const { email: EMAIL, password: PASSWORD } = require("./creds").account();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = 30; // chat-sidebar.tsx
const SECTIONS = ["static", "pagination", "menu-light", "collapse", "switch", "files", "menu-dark", "mobile"];
const FROM = (() => {
  const i = process.argv.indexOf("--from");
  return i === -1 ? 0 : Math.max(0, SECTIONS.indexOf(process.argv[i + 1]));
})();
const run = (name) => SECTIONS.indexOf(name) >= FROM;

const failures = [];
const fail = (w, why) => {
  failures.push(`${w}: ${why}`);
  console.log(`  FAIL  ${w} — ${why}`);
};
const ok = (w, d) => console.log(`  ok    ${w}${d ? ` — ${d}` : ""}`);
const check = (w, cond, detail) => (cond ? ok(w, detail) : fail(w, detail));

const RAIL = 'nav[aria-label="Conversations"]';
const ROWS = `${RAIL} a[href^="/chat/"]`;

async function login(page) {
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const f = document.querySelector("form");
      return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber"));
    },
    null,
    { timeout: 30000 },
  );
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
}

/** Counts `Add` frames per udfPath (optionally filtered by an args predicate). */
async function frameCounter(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  const adds = [];
  cdp.on("Network.webSocketFrameSent", (e) => {
    try {
      const m = JSON.parse(e.response.payloadData);
      if (m.type !== "ModifyQuerySet") return;
      for (const mod of m.modifications || []) {
        if (mod.type === "Add") adds.push({ t: Date.now(), path: mod.udfPath, args: mod.args?.[0] ?? {} });
      }
    } catch {}
  });
  return {
    railPages: () =>
      adds.filter((a) => a.path === "chat/threads:list" && a.args?.unassignedOnly === true).length,
    count: (path) => adds.filter((a) => a.path === path).length,
    since: (t, path) => adds.filter((a) => a.t >= t && a.path === path).length,
  };
}

/** The rail's scroller: the overflow container that holds the thread links. */
const scrollerHandle = (page) =>
  page.evaluateHandle(
    ([rows]) => {
      const a = document.querySelector(rows);
      let p = a?.parentElement;
      while (p && !/auto|scroll/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
      return p;
    },
    [ROWS],
  );

const railState = (page) =>
  page.evaluate(
    ([rows]) => {
      const ids = [...document.querySelectorAll(rows)].map((a) => a.getAttribute("href"));
      return { count: ids.length, unique: new Set(ids).size };
    },
    [ROWS],
  );

/** Scroll the rail to the bottom and wait for it to grow; returns the new count. */
async function scrollRailOnce(page, how, before) {
  const sc = await scrollerHandle(page);
  if (how === "jump") {
    await sc.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  } else if (how === "wheel") {
    const box = await sc.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    for (let i = 0; i < 25; i++) await page.mouse.wheel(0, 900); // wheel spam
  } else if (how === "end") {
    await sc.evaluate((el) => {
      el.tabIndex = -1;
      el.focus();
    });
    await page.keyboard.press("End");
    await page.keyboard.press("PageDown");
    await page.keyboard.press("End");
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 9000) {
    const s = await railState(page);
    if (s.count > before) return s.count;
    await sleep(150);
  }
  return (await railState(page)).count;
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const errors = [];
  const watch = (page, tag) => {
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`${tag}: ${m.text().slice(0, 160)}`);
    });
    page.on("pageerror", (e) => errors.push(`${tag}: pageerror ${String(e).slice(0, 160)}`));
  };

  // ======================================================== desktop, light
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
  const page = await ctx.newPage();
  watch(page, "desktop");
  const frames = await frameCounter(ctx, page);
  let s = null;
  await login(page);
  await page.locator(ROWS).first().waitFor({ timeout: 30000 });
  await sleep(2500);

  if (run("static")) {
  console.log("\nstatic");
  const body = await page.locator("body").innerText();
  check("no \"Load more\" anywhere on /chat", !/Load more/i.test(body));
  await page.getByRole("button", { name: "Account menu" }).click();
  await sleep(400);
  const menuLinks = await page.locator(`${RAIL} a`).allInnerTexts();
  const joined = menuLinks.join(" | ");
  check("account menu has no \"Shared Chats\"", !/Shared Chats/.test(joined), joined.slice(0, 120));
  check("account menu still has Settings", /Settings/.test(joined));
  check("account menu still has Billing (not in the Settings nav)", /Billing/.test(joined));
  await page.keyboard.press("Escape");
  await sleep(300);

  }
  // ------------------------------------------------ pagination by scrolling
  if (run("pagination")) {
  console.log("\nrail pagination");
  s = await railState(page);
  const initial = s.count;
  const pagesAtStart = frames.railPages();
  console.log(`  initial rows ${initial}, rail subscriptions ${pagesAtStart}`);
  check("first page is one subscription", pagesAtStart === 1, `${pagesAtStart}`);

  // Preload: stop SHORT of the bottom and a page must still arrive.
  if (initial >= PAGE) {
    const sc = await scrollerHandle(page);
    const beforeTop = await sc.evaluate((el) => {
      el.scrollTop = el.scrollHeight - el.clientHeight - 90; // 90px shy of the end
      return el.scrollTop;
    });
    const t0 = Date.now();
    let grew = false;
    while (Date.now() - t0 < 9000) {
      if ((await railState(page)).count > initial) {
        grew = true;
        break;
      }
      await sleep(150);
    }
    const afterTop = await sc.evaluate((el) => el.scrollTop);
    check("a page loads BEFORE the absolute bottom", grew, `stopped 90px short, grew=${grew}`);
    check("scroll position does not jump when a page appends", afterTop >= beforeTop - 2, `${beforeTop} -> ${afterTop}`);
  } else {
    console.log(`  (only ${initial} threads — one page, nothing to paginate)`);
  }

  // Walk to the end with every scroll modality, including a resize mid-scroll.
  const modes = ["wheel", "jump", "end", "wheel", "jump", "end"];
  let stable = 0;
  let prev = (await railState(page)).count;
  let i = 0;
  while (stable < 3 && i < 80) {
    const how = modes[i % modes.length];
    if (i === 3) await page.setViewportSize({ width: 1180, height: 760 });
    if (i === 5) await page.setViewportSize({ width: 1280, height: 800 });
    const next = await scrollRailOnce(page, how, prev);
    stable = next > prev ? 0 : stable + 1;
    prev = next;
    i++;
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(500);
  s = await railState(page);
  const pages = Math.ceil(s.count / PAGE);
  const subs = frames.railPages();
  console.log(`  reached end: ${s.count} rows, ${pages} page(s), ${subs} rail subscription(s)`);
  check("rows grew with no click", s.count > initial || initial < PAGE, `${initial} -> ${s.count}`);
  check("thread ids are unique across every page", s.unique === s.count, `${s.unique}/${s.count}`);
  check(
    "exactly one subscription per page — no duplicates under wheel spam, jumps, End/PageDown and resize",
    subs === pages,
    `${subs} subscriptions for ${pages} pages`,
  );

  // At the end nothing more may be requested, however hard we scroll.
  const endSubs = frames.railPages();
  const tEnd = Date.now();
  for (let k = 0; k < 6; k++) await scrollRailOnce(page, modes[k % 3], s.count + 1000);
  check(
    "no request after the end",
    frames.railPages() === endSubs,
    `${frames.railPages() - endSubs} extra in ${Math.round((Date.now() - tEnd) / 1000)}s`,
  );

  }
  // ---------------------------------------------------- the 3-dot menu
  async function menuOnLastRow(tag) {
    const sc = await scrollerHandle(page);
    await sc.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await sleep(700);
    // The last row whose bottom is inside the scroller — the one the report
    // showed being cut off by the footer.
    const idx = await page.evaluate(
      ([rows]) => {
        const as = [...document.querySelectorAll(rows)];
        const a0 = as[0];
        let p = a0?.parentElement;
        while (p && !/auto|scroll/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
        const box = p.getBoundingClientRect();
        let best = -1;
        as.forEach((a, n) => {
          const r = a.getBoundingClientRect();
          if (r.bottom <= box.bottom && r.top >= box.top) best = n;
        });
        return best;
      },
      [ROWS],
    );
    const row = page.locator(ROWS).nth(idx).locator("xpath=..");
    await row.hover();
    const trigger = row.getByRole("button", { name: "Conversation actions" });
    await trigger.click();
    await sleep(500);
    const m = await page.evaluate(
      ([rail]) => {
        const item = [...document.querySelectorAll("button")].find((b) => /^(Pin|Unpin)$/.test(b.textContent.trim()));
        const menu = item?.parentElement;
        if (!menu) return null;
        const r = menu.getBoundingClientRect();
        const items = [...menu.querySelectorAll("button")];
        const covered = items.filter((b) => {
          const br = b.getBoundingClientRect();
          const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
          return !(hit === b || b.contains(hit));
        }).map((b) => b.textContent.trim());
        const nav = document.querySelector(rail);
        const cs = getComputedStyle(menu);
        const trig = document.querySelector('[aria-expanded="true"][aria-label="Conversation actions"]');
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          left: Math.round(r.left),
          right: Math.round(r.right),
          vh: innerHeight,
          vw: innerWidth,
          covered,
          items: items.length,
          insideRail: !!nav?.contains(menu),
          inWorkspace: !!menu.closest(".workspace"),
          bg: cs.backgroundColor,
          railBg: nav ? getComputedStyle(nav).backgroundColor : null,
          border: cs.borderTopColor,
          triggerOpacity: trig ? getComputedStyle(trig).opacity : null,
        };
      },
      [RAIL],
    );
    if (!m) {
      fail(`${tag} menu`, "the menu did not open");
      return;
    }
    check(
      `${tag}: menu on the last visible row is fully inside the viewport`,
      m.top >= 0 && m.bottom <= m.vh && m.left >= 0 && m.right <= m.vw,
      `y ${m.top}..${m.bottom} of ${m.vh}, x ${m.left}..${m.right} of ${m.vw}`,
    );
    check(`${tag}: no menu item is covered (footer, scroller)`, m.covered.length === 0, m.covered.join(",") || `${m.items} items clear`);
    check(`${tag}: menu has left the rail's clip context (portalled)`, !m.insideRail);
    check(`${tag}: menu carries the workspace palette`, m.inWorkspace && m.bg === m.railBg, `bg ${m.bg} rail ${m.railBg}`);
    check(`${tag}: the 3-dot stays visible while its menu is open`, m.triggerOpacity === "1", `opacity ${m.triggerOpacity}`);

    // Dismissal: Escape, click-away, and scrolling the rail.
    await page.keyboard.press("Escape");
    await sleep(300);
    check(`${tag}: Escape closes it`, (await page.getByRole("button", { name: /^(Pin|Unpin)$/ }).count()) === 0);
    await row.hover();
    await trigger.click();
    await sleep(400);
    await page.mouse.click(900, 300);
    await sleep(300);
    check(`${tag}: click-away closes it`, (await page.getByRole("button", { name: /^(Pin|Unpin)$/ }).count()) === 0);
    await row.hover();
    await trigger.click();
    await sleep(400);
    await (await scrollerHandle(page)).evaluate((el) => {
      el.scrollTop = Math.max(0, el.scrollTop - 200);
    });
    await sleep(400);
    check(`${tag}: scrolling the rail closes it`, (await page.getByRole("button", { name: /^(Pin|Unpin)$/ }).count()) === 0);

    // KEYBOARD — the red-team case. The portal moved the menu to the END of
    // <body>, out of the tab order next to its trigger; without the focus
    // contract, Tab from the 3-dot lands on the next row and the items are
    // unreachable except by tabbing through the whole page.
    await row.hover();
    await trigger.focus();
    await page.keyboard.press("Enter");
    await sleep(400);
    const first = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    check(`${tag}: opening by keyboard puts focus in the menu`, /^(Pin|Unpin)$/.test(first), `focus on "${first}"`);
    await page.keyboard.press("Tab");
    const second = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    check(`${tag}: Tab walks the menu items`, second === "Rename", `then "${second}"`);
    await page.keyboard.press("Escape");
    await sleep(300);
    const back = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    check(`${tag}: Escape returns focus to the 3-dot`, back === "Conversation actions", `focus on ${back}`);
    check(`${tag}: …and the menu is closed`, (await page.getByRole("button", { name: /^(Pin|Unpin)$/ }).count()) === 0);
  }

  if (run("menu-light")) {
  console.log("\n3-dot menu, desktop light");
  await menuOnLastRow("1280x800 light");

  }
  // ------------------------------------------ collapse / expand the rail
  if (run("collapse")) {
  console.log("\ncollapse / expand");
  const beforeCollapse = frames.railPages();
  await page.getByRole("button", { name: "Hide conversations" }).first().click();
  await sleep(900);
  check("collapsed rail requests nothing", frames.railPages() === beforeCollapse);
  await page.locator('button[aria-label="Open conversations"]:visible').first().click();
  await sleep(900);
  s = await railState(page);
  check("expanded rail still holds every row, unique", s.unique === s.count && s.count > 0, `${s.count}`);

  }
  // --------------------------------- switching chats while a page is in flight
  if (run("switch")) {
  console.log("\nswitch chats mid-load");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(ROWS).first().waitFor({ timeout: 30000 });
  await sleep(2000);
  const sc2 = await scrollerHandle(page);
  await sc2.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.locator(ROWS).nth(1).click(); // mid-load
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 20000 });
  await sleep(3000);
  s = await railState(page);
  check("rail consistent after switching mid-load", s.unique === s.count && s.count >= 1, `${s.unique}/${s.count}`);

  }
  // ------------------------------------------------ the short-scroller trap
  if (run("files")) {
  console.log("\nchat Files section (256px scroller)");
  // The Files query subscribes its FIRST page on mount, open or not, so the
  // signal is how many EXTRA pages expanding it pulls. The regression the
  // derived rootMargin prevents: a flat 400px margin on this 256px scroller
  // made the sentinel intersect on first render and pull every page at once.
  const filesToggle = page.getByRole("button", { name: /^Files/ }).first();
  if (await filesToggle.count()) {
    const before = frames.count("userFiles:list");
    await filesToggle.click();
    await sleep(5000);
    const extra = frames.count("userFiles:list") - before;
    const shown = await page.locator(`${RAIL} .max-h-64 > *`).count();
    check(
      "opening the 256px Files section pulls NO extra pages",
      extra === 0,
      `${extra} extra page(s); ${shown} rows rendered`,
    );
    // …and it still paginates when the user actually scrolls it.
    await page.evaluate(([rail]) => {
      const el = document.querySelector(`${rail} .max-h-64`);
      if (el) el.scrollTop = el.scrollHeight;
    }, [RAIL]);
    const t0 = Date.now();
    let grew = 0;
    while (Date.now() - t0 < 9000) {
      grew = (await page.locator(`${RAIL} .max-h-64 > *`).count()) - shown;
      if (grew > 0) break;
      await sleep(200);
    }
    check("scrolling the Files section still loads the next page", grew > 0, `+${grew} rows`);
    await filesToggle.click().catch(() => {});
  } else {
    fail("Files section", "toggle not found");
  }

  }
  // ------------------------------------------------------ dark theme menu
  if (run("menu-dark")) {
  console.log("\n3-dot menu, desktop dark");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => {
    try {
      localStorage.setItem("theme", "dark");
      localStorage.setItem("theme_ts", String(Date.now()));
    } catch {}
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(ROWS).first().waitFor({ timeout: 30000 });
  await sleep(2500);
  await menuOnLastRow("1280x800 dark");
  await page.evaluate(() => {
    try {
      localStorage.removeItem("theme");
      localStorage.removeItem("theme_ts");
    } catch {}
  });
  }
  await ctx.close();

  // ============================================================ mobile drawer
  if (run("mobile")) {
  console.log("\nmobile drawer 390x844");
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const mpage = await mctx.newPage();
  watch(mpage, "mobile");
  const mframes = await frameCounter(mctx, mpage);
  await login(mpage);
  // Below md the DOCKED rail is still mounted — just display:none — and it
  // comes FIRST in the DOM, so every selector here is scoped to the drawer
  // (the only rail nav that is position:fixed). That hidden rail also holds
  // its own first-page subscription: usePaginatedQuery adds a private id to
  // its args, so the two instances cannot share one. Pre-existing, and not a
  // pagination duplicate — it is counted below rather than hidden.
  const DRAWER = 'nav.fixed[aria-label="Conversations"]';
  const DROWS = `${DRAWER} a[href^="/chat/"]`;
  const drawerState = () =>
    mpage.evaluate(
      ([rows]) => {
        const ids = [...document.querySelectorAll(rows)].map((x) => x.getAttribute("href"));
        return { count: ids.length, unique: new Set(ids).size };
      },
      [DROWS],
    );
  await mpage.locator('button[aria-label="Open conversations"]:visible').first().click();
  await mpage.locator(DROWS).first().waitFor({ timeout: 30000 });
  await sleep(2000);
  const subsOpen = mframes.railPages();
  const m0 = (await drawerState()).count;
  await mpage.evaluate(
    ([rows]) => {
      const x = document.querySelector(rows);
      let p = x?.parentElement;
      while (p && !/auto|scroll/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
      if (p) p.scrollTop = p.scrollHeight;
    },
    [DROWS],
  );
  const t0 = Date.now();
  let mNext = m0;
  while (Date.now() - t0 < 9000) {
    mNext = (await drawerState()).count;
    if (mNext > m0) break;
    await sleep(150);
  }
  check("the drawer paginates by scrolling too", mNext > m0 || m0 < PAGE, `${m0} -> ${mNext}`);
  const ms = await drawerState();
  check("drawer ids unique", ms.unique === ms.count, `${ms.unique}/${ms.count}`);
  const drawerPages = Math.ceil(ms.count / PAGE);
  const loads = mframes.railPages() - subsOpen;
  check(
    "drawer: exactly one request per page it scrolled into",
    loads === drawerPages - 1,
    `${loads} load(s) for ${drawerPages - 1} additional page(s)`,
  );
  console.log(
    `  note: ${subsOpen} first-page subscription(s) when the drawer opened — ${subsOpen - 1} of them is the hidden docked rail (pre-existing)`,
  );

  // The reported bug, on a phone: the menu on the drawer's last visible row.
  const lastIdx = await mpage.evaluate(
    ([rows]) => {
      const as = [...document.querySelectorAll(rows)];
      let p = as[0]?.parentElement;
      while (p && !/auto|scroll/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
      const box = p.getBoundingClientRect();
      let best = -1;
      as.forEach((x, n) => {
        const r = x.getBoundingClientRect();
        if (r.bottom <= box.bottom && r.top >= box.top) best = n;
      });
      return best;
    },
    [DROWS],
  );
  const mrow = mpage.locator(DROWS).nth(lastIdx).locator("xpath=..");
  await mrow.getByRole("button", { name: "Conversation actions" }).click();
  await sleep(500);
  const mm = await mpage.evaluate(() => {
    const item = [...document.querySelectorAll("button")].find((x) => /^(Pin|Unpin)$/.test(x.textContent.trim()));
    const menu = item?.parentElement;
    if (!menu) return null;
    const r = menu.getBoundingClientRect();
    const covered = [...menu.querySelectorAll("button")].filter((x) => {
      const br = x.getBoundingClientRect();
      const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
      return !(hit === x || x.contains(hit));
    }).length;
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vh: innerHeight, vw: innerWidth, covered };
  });
  check(
    "390x844: drawer's last-row menu fully on screen and uncovered",
    !!mm && mm.top >= 0 && mm.bottom <= mm.vh && mm.left >= 0 && mm.right <= mm.vw && mm.covered === 0,
    mm ? `y ${mm.top}..${mm.bottom} of ${mm.vh}, x ${mm.left}..${mm.right} of ${mm.vw}, covered ${mm.covered}` : "menu did not open",
  );
  await mctx.close();

  }
  await browser.close();

  console.log(`\n${"=".repeat(62)}`);
  for (const e of errors.slice(0, 8)) console.log(`CONSOLE  ${e}`);
  const verdict = failures.length === 0 && errors.length === 0 ? "PASS" : "FAIL";
  console.log(`===== INFINITE SCROLL: ${verdict} | failures: ${failures.length} | console errors: ${errors.length} =====`);
  if (verdict !== "PASS") process.exitCode = 1;
})();
