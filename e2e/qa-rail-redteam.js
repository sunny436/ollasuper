// Red-team the paginated rail: mutations on rows that came from LATER pages,
// and abuse of the portalled 3-dot menu. Run it on a DISPOSABLE account — it
// pins, renames and deletes. Headed Chrome, zero console errors.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-rail-redteam.js
//
// The gate (qa-infinite-scroll.js) proves pagination and the menu in
// isolation. What it does not attack is the seam between them: p-chat mutates
// rows on page 1 only, so a row that arrived with page 3 had never been
// pinned, renamed or deleted under test.
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const { email: EMAIL, password: PASSWORD } = require("./creds").account();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RAIL = 'nav[aria-label="Conversations"]';
const ROWS = `${RAIL} a[href^="/chat/"]`;

const failures = [];
const check = (w, cond, d) => {
  if (!cond) failures.push(w);
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${w}${d ? ` — ${d}` : ""}`);
};

const state = (page) =>
  page.evaluate(
    ([rows]) => {
      const as = [...document.querySelectorAll(rows)];
      const ids = as.map((a) => a.getAttribute("href"));
      return { count: ids.length, unique: new Set(ids).size, titles: as.map((a) => a.innerText.trim()) };
    },
    [ROWS],
  );

async function scrollToEnd(page) {
  let prev = -1;
  for (let i = 0; i < 20; i++) {
    await page.evaluate(
      ([rows]) => {
        let p = document.querySelector(rows)?.parentElement;
        while (p && !/auto|scroll/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
        if (p) p.scrollTop = p.scrollHeight;
      },
      [ROWS],
    );
    await sleep(1500);
    const c = (await state(page)).count;
    if (c === prev) return c;
    prev = c;
  }
  return prev;
}

async function openMenuFor(page, title) {
  const link = page.locator(ROWS).filter({ hasText: new RegExp(`^${title}$`) }).first();
  await link.scrollIntoViewIfNeeded();
  const row = link.locator("xpath=..");
  await row.hover();
  await row.getByRole("button", { name: "Conversation actions" }).click();
  await sleep(350);
}

(async () => {
  const b = await chromium.launch({ headless: false });
  const page = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  page.on("pageerror", (e) => errors.push(`pageerror ${String(e).slice(0, 160)}`));

  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const f = document.querySelector("form"); return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber")); }, null, { timeout: 30000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.locator(ROWS).first().waitFor({ timeout: 30000 });
  await sleep(2000);

  const total = await scrollToEnd(page);
  let s = await state(page);
  console.log(`loaded ${total} rows by scrolling`);
  const deep = s.titles[s.titles.length - 1]; // arrived with the LAST page
  const deep2 = s.titles[s.titles.length - 2];
  const deep3 = s.titles[s.titles.length - 3];

  // 1. PIN a row from the last page — it must jump to Pinned, not vanish or
  //    duplicate, and the list must not collapse back to page one.
  await openMenuFor(page, deep);
  await page.getByRole("button", { name: "Pin" }).click();
  await sleep(2500);
  s = await state(page);
  const pinnedHead = await page.evaluate(([rail]) => {
    const labels = [...document.querySelectorAll(`${rail} p`)].map((p) => p.textContent.trim());
    return labels[0] || "";
  }, [RAIL]);
  check(`pin a last-page row ("${deep}")`, s.count === total && s.unique === s.count && s.titles[0] === deep,
    `count ${s.count}/${total}, first row "${s.titles[0]}", first group "${pinnedHead}"`);

  // 2. RENAME another last-page row — updated in place, nothing reloads.
  const renamed = `renamed ${Date.now().toString(36)}`;
  await scrollToEnd(page);
  await openMenuFor(page, deep2);
  page.once("dialog", (d) => d.accept(renamed));
  await page.getByRole("button", { name: "Rename" }).click();
  await sleep(2500);
  s = await state(page);
  check(`rename a last-page row`, s.titles.includes(renamed) && !s.titles.includes(deep2) && s.count === total && s.unique === s.count,
    `count ${s.count}, renamed present ${s.titles.includes(renamed)}`);

  // 3. DELETE the last row currently loaded — the list shrinks by exactly one
  //    and does NOT reset to the first page.
  await scrollToEnd(page);
  await openMenuFor(page, deep3);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await sleep(3000);
  s = await state(page);
  check(`delete the last loaded row ("${deep3}")`, s.count === total - 1 && s.unique === s.count && !s.titles.includes(deep3),
    `count ${total} -> ${s.count}`);

  // 4. Menu abuse: open five menus back to back as fast as the pointer can.
  //    At most one menu may be open, and no orphaned portal may remain.
  for (let i = 0; i < 5; i++) {
    const row = page.locator(ROWS).nth(i).locator("xpath=..");
    await row.hover();
    await row.getByRole("button", { name: "Conversation actions" }).click({ force: true });
  }
  await sleep(500);
  const menusOpen = await page.getByRole("button", { name: /^(Pin|Unpin)$/ }).count();
  check("rapid menu opening leaves at most one menu", menusOpen <= 1, `${menusOpen} open`);
  await page.keyboard.press("Escape");
  await sleep(300);

  // 5. Double-click the 3-dot: must end in a consistent open-or-closed state,
  //    never two stacked portals.
  const r0 = page.locator(ROWS).nth(2).locator("xpath=..");
  await r0.hover();
  await r0.getByRole("button", { name: "Conversation actions" }).dblclick();
  await sleep(400);
  const afterDbl = await page.getByRole("button", { name: /^(Pin|Unpin)$/ }).count();
  check("double-click on the 3-dot leaves 0 or 1 menu", afterDbl <= 1, `${afterDbl}`);
  await page.keyboard.press("Escape");
  await sleep(300);
  // Count MENU portals only. `body > .workspace` also matches the app's own
  // root shell ((workspace)/layout.tsx renders a .workspace div straight under
  // <body>), which is there on a fresh page before any menu is ever opened —
  // counting it was a false positive in the first version of this check.
  const leftovers = await page.evaluate(
    () =>
      [...document.querySelectorAll("body > .workspace")].filter((el) =>
        [...el.querySelectorAll("button")].some((b) => /^(Pin|Unpin)$/.test(b.textContent.trim())),
      ).length,
  );
  check("no orphaned menu portals left in <body>", leftovers === 0, `${leftovers}`);

  // 6. Reload: the list comes back consistent from the server (pin and
  //    rename persisted, deleted row gone).
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(ROWS).first().waitFor({ timeout: 30000 });
  await sleep(2000);
  const after = await scrollToEnd(page);
  s = await state(page);
  check("after reload: pin, rename and delete all persisted", after === total - 1 && s.titles[0] === deep && s.titles.includes(renamed) && !s.titles.includes(deep3),
    `${after} rows, first "${s.titles[0]}"`);

  await b.close();
  for (const e of errors.slice(0, 6)) console.log("CONSOLE", e);
  console.log(`\n===== RAIL RED TEAM: ${failures.length ? "FAIL" : "PASS"} | failures: ${failures.length} | console errors: ${errors.length} =====`);
  if (failures.length || errors.length) process.exitCode = 1;
})();
