// All 16 infinite-scroll lists, verified live — not "the code looks right".
//
//   node qa-lists-all.js <account.json>
//
// Run on a DISPOSABLE account seeded by qa-throwaway.js + qa-seed-lists.js.
// Headed Chrome, zero console errors.
//
// The wire is the authority. Every page of a usePaginatedQuery is its own
// Convex subscription, so each `ModifyQuerySet Add` IS a page request and each
// Transition carries that page's rows. Per list this proves, against totals
// read from the API up front:
//   INITIAL   exactly one first-page request on load
//   PAGES     one request per page — also under rapid scrolling
//   COMPLETE  every row delivered (no skipped page), none twice (no duplicate)
//   END       nothing requested once the last page is in, however long you scroll
//   STABLE    scrollTop never jumps backwards when a page lands
//   NO BUTTON no "Load more" anywhere
const fs = require("node:fs");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CONVEX = `${BASE}/__cvx`;
const [FILE] = process.argv.slice(2);
if (!FILE) {
  console.error("usage: node qa-lists-all.js <account.json>");
  process.exit(2);
}
const ACCT = JSON.parse(fs.readFileSync(FILE, "utf8"));
const SEED = JSON.parse(fs.readFileSync(`${FILE}.lists.json`, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RAIL = 'nav[aria-label="Conversations"]';
const failures = [];
const matrix = [];
const errors = [];
const check = (what, cond, detail) => {
  if (!cond) failures.push(what);
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`);
  return cond;
};

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
async function total(jwt, fn, args) {
  let n = 0;
  let cursor = null;
  for (;;) {
    const res = await call("query", jwt, fn, { ...args, paginationOpts: { numItems: 100, cursor } });
    n += res.page.length;
    if (res.isDone) return n;
    cursor = res.continueCursor;
  }
}

/** Pagination subscriptions, grouped per list instance (usePaginatedQuery's private id). */
async function wire(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  const q = new Map(); // queryId -> {path, key, cursor}
  const adds = [];
  const removes = [];
  const pages = new Map(); // queryId -> latest page ids + isDone
  // Query ids are per CONNECTION and restart at 0 on every page load, so a
  // new WebSocket starts a new id space: forget the old one, or a reloaded
  // page's queryId 3 collides with the previous page's queryId 3.
  cdp.on("Network.webSocketCreated", () => {
    q.clear();
    pages.clear();
  });
  cdp.on("Network.webSocketFrameSent", (e) => {
    try {
      const m = JSON.parse(e.response.payloadData);
      if (m.type !== "ModifyQuerySet") return;
      for (const mod of m.modifications || []) {
        if (mod.type === "Remove") {
          const r = q.get(mod.queryId);
          if (r) removes.push({ t: Date.now(), key: r.key, cursor: r.cursor });
          q.delete(mod.queryId);
          pages.delete(mod.queryId);
          continue;
        }
        if (mod.type !== "Add") continue;
        const a = mod.args?.[0] ?? {};
        if (!a.paginationOpts) continue;
        const { paginationOpts, ...rest } = a;
        const key = `${mod.udfPath} ${JSON.stringify(rest)} ${paginationOpts.id ?? ""}`;
        q.set(mod.queryId, { path: mod.udfPath, key, cursor: paginationOpts.cursor ?? null });
        adds.push({ t: Date.now(), path: mod.udfPath, key, args: rest, cursor: paginationOpts.cursor ?? null });
      }
    } catch {}
  });
  cdp.on("Network.webSocketFrameReceived", (e) => {
    try {
      const m = JSON.parse(e.response.payloadData || "");
      if (m.type !== "Transition") return;
      for (const mod of m.modifications || []) {
        if (mod.type !== "QueryUpdated" || !q.has(mod.queryId)) continue;
        const v = mod.value || {};
        if (!Array.isArray(v.page)) continue;
        pages.set(mod.queryId, { ids: v.page.map((r) => r._id), isDone: !!v.isDone });
      }
    } catch {}
  });
  return {
    adds: (t0, fn) => adds.filter((x) => x.t >= t0 && fn(x)),
    group(key, since = 0) {
      const qids = [...q.entries()].filter(([, v]) => v.key === key).map(([id]) => id);
      const ids = qids.flatMap((id) => pages.get(id)?.ids ?? []);
      const done = qids.some((id) => pages.get(id)?.isDone);
      const all = adds.filter((a) => a.key === key && a.t >= since);
      const cursors = all.map((a) => (a.cursor === null ? "∅" : String(a.cursor).slice(0, 10)));
      return {
        requests: all.length,
        live: qids.length,
        removed: removes.filter((r) => r.key === key).length,
        delivered: ids.length,
        unique: new Set(ids).size,
        done,
        cursors,
      };
    },
  };
}

/**
 * Bring every list's end into view — each sentinel, in its own scroller, the
 * way a user reaching the bottom of THAT list does. Jumping a shared page
 * scroller straight to its bottom skipped an upper list's end entirely (two
 * lists stacked on /settings/files), which no gradual scroll ever does.
 */
function scrollAll(page, rapid = false, turn = -1) {
  return page.evaluate(([rapid, turn]) => {
    const all = [...document.querySelectorAll('div.h-px[aria-hidden="true"]')];
    // ONE list's end per call when `turn` is given: several scrollIntoView calls
    // in one task leave only the LAST position for IntersectionObserver to see,
    // so on a page with two lists stacked in one scroller the upper list's end
    // was never "reached". A user passes it on the way down; so does this.
    const sentinels = turn < 0 || all.length === 0 ? all : [all[turn % all.length]];
    const out = [];
    for (const s of sentinels) {
      let p = s.parentElement;
      while (p && !/^(auto|scroll|overlay)$/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
      const el = p || document.scrollingElement;
      const before = el.scrollTop;
      if (rapid) {
        for (let i = 0; i < 12; i++) el.scrollTop = i % 2 ? 0 : el.scrollHeight;
      }
      s.scrollIntoView({ block: "end" });
      out.push({ before, after: el.scrollTop });
    }
    // Remember where each scroller was left, for jumpedBack().
    window.__marks = sentinels.map((s) => {
      let p = s.parentElement;
      while (p && !/^(auto|scroll|overlay)$/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
      const el = p || document.scrollingElement;
      return { el, top: el.scrollTop };
    });
    return out;
  }, [rapid, turn]);
}

/** Did a scroller move BACK on its own while a page landed? (STABLE) */
function jumpedBack(page) {
  return page.evaluate(() => (window.__marks || []).some((m) => m.el.isConnected && m.el.scrollTop + 2 < m.top));
}

async function signIn(page) {
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const f = document.querySelector("form"); return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber")); }, null, { timeout: 30000 });
  await page.locator('input[type="email"]').first().fill(ACCT.email);
  await page.locator('input[type="password"]').first().fill(ACCT.password);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
}

/**
 * One list, end to end. `open` brings it on screen; `pick` chooses its
 * subscription group among the page's pagination subscriptions.
 */
async function verify(page, w, list, { mobile = false } = {}) {
  const t0 = Date.now();
  await page.goto(BASE + list.route, { waitUntil: "domcontentloaded" });
  await sleep(1500);
  // A list behind an action (dialog, section) is identified by the
  // subscription that action created — the same query may already be live
  // elsewhere on the page (the rail's Files section also reads userFiles).
  const tOpen = Date.now();
  if (list.open) await list.open(page);
  await sleep(2500);
  // Dialogs and pickers create their own subscription on open; an expanded
  // section or an opened drawer must NOT (it already holds one from load).
  const since = list.opensNew ? tOpen : t0;
  const first = w.adds(since, (a) => a.path === list.path && a.cursor === null && list.pick(a.args));
  const key = first[0]?.key;
  const label = `${list.n}. ${list.name}${mobile ? " @390" : ""}`;
  console.log(`\n[${label}] expected ${list.total} rows, page ${list.size}`);
  if (!key) {
    check(`${label}: first page requested`, false, "no subscription seen");
    matrix.push({ list: label, result: "FAIL" });
    return;
  }
  const initialOk = check(`${label}: INITIAL — exactly one first-page request`, first.length === 1, `${first.length}`);

  // Rapid scrolling first: jump up and down before page 2 lands.
  await scrollAll(page, true);
  let stable = true;
  let idle = 0;
  let last = -1;
  for (let i = 0; i < 60 && idle < 6; i++) {
    await scrollAll(page, false, i);
    await sleep(700);
    if (await jumpedBack(page)) stable = false;
    const g = w.group(key, t0);
    if (g.requests === last) idle++;
    else idle = 0;
    last = g.requests;
  }
  const g = w.group(key, t0);
  const expPages = Math.max(1, Math.ceil(list.total / list.size));
  const pagesOk = g.requests === expPages || (list.total % list.size === 0 && g.requests === expPages + 1);
  check(`${label}: PAGES — one request per page, rapid scrolling included`, pagesOk, `${g.requests} request(s) for ${expPages} page(s)`);
  const completeOk = check(`${label}: COMPLETE — every row delivered, none twice`, g.unique === list.total && g.delivered === g.unique, `${g.unique}/${list.total} unique, ${g.delivered - g.unique} duplicate(s)`);
  if (!pagesOk || !completeOk) {
    console.log(`        cursors requested: [${g.cursors.join(", ")}] · live ${g.live} · removed ${g.removed}`);
  }

  // End: keep scrolling; no further page may be requested.
  const before = g.requests;
  for (let i = 0; i < 5; i++) {
    await scrollAll(page);
    await sleep(500);
  }
  const endOk = check(`${label}: END — nothing requested after the last page`, g.done && w.group(key, t0).requests === before, `done=${g.done}, +${w.group(key, t0).requests - before}`);
  const stableOk = check(`${label}: STABLE — scroll position never jumps back`, stable);
  const noButton = check(`${label}: no "Load more" button`, (await page.getByRole("button", { name: /load more/i }).count()) === 0);
  matrix.push({
    list: label,
    initial: initialOk ? "1 req" : "FAIL",
    page2: g.requests >= 2 || expPages === 1 ? "auto" : "FAIL",
    pages: `${g.requests}/${expPages}`,
    end: endOk ? "stops" : "FAIL",
    duplicates: completeOk ? "0" : "FAIL",
    rows: `${g.unique}/${list.total}`,
    stable: stableOk && noButton ? "yes" : "FAIL",
    result: initialOk && pagesOk && completeOk && endOk && stableOk && noButton ? "PASS" : "FAIL",
  });
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  page.on("pageerror", (e) => errors.push(`pageerror ${String(e).slice(0, 160)}`));
  const w = await wire(ctx, page);
  await signIn(page);
  const jwt = (await ctx.cookies()).find((k) => /convexAuthJWT/i.test(k.name)).value;
  const ws = SEED.workspaceId;
  const host = SEED.hostId;

  const T = {
    rail: await total(jwt, "chat/threads:list", { workspaceId: ws, unassignedOnly: true }),
    archived: await total(jwt, "chat/threads:list", { workspaceId: ws, status: "archived", withProject: true }),
    myFiles: await total(jwt, "userFiles:list", { workspaceId: ws }),
    wsFiles: await total(jwt, "files:listPaged", { workspaceId: ws }),
    projects: await total(jwt, "projects:list", { workspaceId: ws }),
    projThreads: await total(jwt, "projects:listThreads", { projectId: host }),
    projFiles: await total(jwt, "projects:listFiles", { projectId: host }),
    projMem: await total(jwt, "projects:listMemories", { projectId: host }),
    memories: await total(jwt, "memories:list", { workspaceId: ws }),
    skills: await total(jwt, "userSkills:list", { workspaceId: ws }),
    shares: await total(jwt, "chat/shares:listMine", { workspaceId: ws }),
  };
  console.log("API totals:", JSON.stringify(T));

  const any = () => true;
  const LISTS = [
    { n: 1, name: "Conversation rail", route: "/chat", path: "chat/threads:list", pick: (a) => a.unassignedOnly === true, size: 30, total: T.rail },
    { n: 2, name: "Chat Files section", route: "/chat", path: "userFiles:list", pick: any, size: 20, total: T.myFiles,
      open: async (p) => { await p.locator(RAIL).getByRole("button", { name: /^Files/ }).first().click(); } },
    { n: 3, name: "Move to project dialog", opensNew: true, route: "/chat", path: "projects:list", pick: any, size: 30, total: T.projects,
      open: async (p) => {
        const row = p.locator(`${RAIL} a[href^="/chat/"]`).first().locator("xpath=..");
        await row.hover();
        await row.getByRole("button", { name: "Conversation actions" }).click();
        await p.getByRole("button", { name: "Move to project" }).click();
      } },
    { n: 4, name: "Projects pane", route: "/projects", path: "projects:list", pick: any, size: 30, total: T.projects },
    { n: 5, name: "Project chats", route: `/projects/${host}`, path: "projects:listThreads", pick: any, size: 30, total: T.projThreads },
    { n: 6, name: "Project memories (settings)", opensNew: true, route: `/projects/${host}`, path: "projects:listMemories", pick: any, size: 20, total: T.projMem,
      open: async (p) => {
        await p.getByRole("button", { name: "Project actions" }).click();
        await p.getByRole("button", { name: /Project settings/ }).click();
      } },
    { n: 7, name: "Project sources", route: `/projects/${host}?tab=sources`, path: "projects:listFiles", pick: any, size: 20, total: T.projFiles },
    { n: 8, name: "Project sources: attach picker", opensNew: true, route: `/projects/${host}?tab=sources`, path: "userFiles:list", pick: any, size: 20, total: T.myFiles,
      open: async (p) => { await p.getByRole("button", { name: /Attach existing/ }).click(); } },
    { n: 9, name: "Settings → Archived", route: "/settings/archived", path: "chat/threads:list", pick: (a) => a.status === "archived", size: 20, total: T.archived },
    { n: 10, name: "Settings → Memories", route: "/settings/memories", path: "memories:list", pick: any, size: 30, total: T.memories },
    { n: 11, name: "Settings → My Skills", route: "/settings/skills", path: "userSkills:list", pick: any, size: 30, total: T.skills },
    { n: 12, name: "Settings → Shared Links", route: "/settings/shared", path: "chat/shares:listMine", pick: any, size: 20, total: T.shares },
    { n: 13, name: "Settings → Files (workspace)", route: "/settings/files", path: "files:listPaged", pick: any, size: 20, total: T.wsFiles },
    { n: 14, name: "Settings → Files (mine)", route: "/settings/files", path: "userFiles:list", pick: any, size: 20, total: T.myFiles },
    { n: 15, name: "/files (workspace)", route: "/files", path: "files:listPaged", pick: any, size: 20, total: T.wsFiles },
    { n: 16, name: "/files (mine)", route: "/files", path: "userFiles:list", pick: any, size: 20, total: T.myFiles },
  ];
  for (const list of LISTS) await verify(page, w, list);

  // Collapsed rail: a zero-width rail must not paginate.
  console.log("\n[collapsed rail]");
  await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded" });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  await sleep(1500);
  await page.getByRole("button", { name: "Hide conversations" }).click();
  await sleep(800);
  const tc = Date.now();
  // A real wheel where the rail was: a collapsed rail is invisible and zero
  // wide, so nothing a user does can scroll it. (Setting scrollTop from script
  // does scroll it — and does load a page — but no user can do that.)
  await page.mouse.move(120, 400);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 800);
  await sleep(2500);
  check("collapsed rail requests no pages", w.adds(tc, (a) => a.path === "chat/threads:list" && a.cursor !== null).length === 0);
  await page.getByRole("button", { name: "Open conversations" }).first().click();
  await sleep(800);

  // Offline mid-list, then back: no runaway, no duplicate rows.
  console.log("\n[offline / reconnect — rail]");
  await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded" });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  await sleep(2500);
  const to = Date.now();
  const k0 = w.adds(to - 60000, (a) => a.path === "chat/threads:list" && a.args.unassignedOnly === true && a.cursor === null).pop()?.key;
  await ctx.setOffline(true);
  for (let i = 0; i < 6; i++) { await scrollAll(page); await sleep(400); }
  await ctx.setOffline(false);
  for (let i = 0; i < 12; i++) { await scrollAll(page); await sleep(700); }
  const gr = w.group(k0);
  const reAdds = w.adds(to, (a) => a.key === k0).length;
  check("offline then online: the rail completes with no duplicates and no request storm",
    gr.unique === T.rail && gr.delivered === gr.unique && reAdds <= Math.ceil(T.rail / 30) * 2 + 2,
    `${gr.unique}/${T.rail} rows, ${reAdds} page adds incl. reconnect re-subscribes`);

  // Phone widths: the rail (drawer), Projects and a Settings list.
  const state = await ctx.storageState();
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: state });
  const m = await mctx.newPage();
  m.on("console", (x) => { if (x.type() === "error") errors.push(x.text().slice(0, 160)); });
  const mw = await wire(mctx, m);
  await verify(m, mw, { ...LISTS[0], open: async (p) => { await p.locator('button[aria-label="Open conversations"]:visible').first().click(); } }, { mobile: true });
  await verify(m, mw, LISTS[3], { mobile: true });
  await verify(m, mw, LISTS[10], { mobile: true });
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  check("390px: no horizontal overflow", !overflow);

  await browser.close();
  console.log("\nLIST | INITIAL | PAGE 2 | PAGES | END | DUPLICATES | ROWS | STABLE | RESULT");
  for (const r of matrix) console.log(`${r.list} | ${r.initial} | ${r.page2} | ${r.pages} | ${r.end} | ${r.duplicates} | ${r.rows} | ${r.stable} | ${r.result}`);
  for (const e of errors.slice(0, 6)) console.log("CONSOLE", e);
  console.log(`\n===== 16 LISTS: ${failures.length ? "FAIL" : "PASS"} | failures: ${failures.length} | console errors: ${errors.length} =====`);
  if (failures.length || errors.length) process.exitCode = 1;
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
