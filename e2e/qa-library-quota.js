// File Library — the 100 MB quota on a DEPLOYED stack, as a real user.
//
// Fills a DISPOSABLE account to ~92 MB, then proves in the browser:
//   * the one-time "almost out of space" notice,
//   * an upload that does not fit opens "Free up space" with the OLDEST file
//     pre-selected, and Cancel deletes nothing,
//   * approving deletes exactly the selected file, uploads the new one, and
//     notifies,
//   * a file in a Project is never offered.
// Everything it uploads is removed at the end.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-library-quota.js      (use a THROWAWAY account)
const { chromium } = require("playwright");
const { account } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CONVEX = process.env.E2E_CONVEX_URL || `${BASE}/__cvx`;
const MB = 1024 * 1024;
const who = account();
const results = [];
const errors = [];
const step = async (name, fn) => {
  try {
    const d = await fn();
    results.push(true);
    console.log(`PASS  ${name}${d ? ` — ${d}` : ""}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name} — ${String(e.message || e).split("\n")[0]}`);
  }
};

async function call(kind, jwt, path, args) {
  const r = await fetch(`${CONVEX}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status === "error") throw new Error(`${path}: ${j.errorMessage || r.status}`);
  return j.value;
}

async function apiUpload(jwt, ws, name, bytes) {
  const begin = await call("mutation", jwt, "library:beginUpload", {
    workspaceId: ws, name, contentType: "application/zip", size: bytes.length, purpose: "library",
  });
  if (!begin.ok) throw new Error(`no room for ${name}: ${begin.reason}`);
  const up = await fetch(begin.uploadUrl, { method: "POST", headers: { "content-type": "application/zip" }, body: bytes });
  if (up.status !== 200) throw new Error(`upload ${name}: HTTP ${up.status}`);
  const { storageId } = await up.json();
  const fin = await call("mutation", jwt, "library:finishUpload", {
    intentId: begin.intentId, storageId, name, contentType: "application/zip",
  });
  if (!fin.ok) throw new Error(`finish ${name}: ${fin.code}`);
  return fin.fileId;
}

(async () => {
  const browser = await chromium.launch({ headless: !!process.env.HEADLESS });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  const tag = Date.now().toString(36);
  let jwt;
  let ws;
  const mine = [];

  await step("sign in (throwaway account)", async () => {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="email"]').first().fill(who.email);
    await page.locator('input[type="password"]').first().fill(who.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/chat/, { timeout: 30000 });
    jwt = (await ctx.cookies()).find((k) => /convexAuthJWT/i.test(k.name)).value;
    ws = (await call("query", jwt, "orgs:myWorkspaces", {}))[0]._id;
  });

  await step("fill to ~92 MB: the one-time 'almost out of space' notice fires once", async () => {
    // Oldest first: q-0 is the file Free up space must pre-select.
    for (let i = 0; i < 4; i++) {
      const bytes = Buffer.alloc(23 * MB, 65 + i); // distinct bytes per file
      mine.push(await apiUpload(jwt, ws, `q-${i}-${tag}.zip`, bytes));
      await new Promise((r) => setTimeout(r, 400)); // distinct createdAt
    }
    const s = await call("query", jwt, "library:storageSummary", {});
    if (s.usedBytes < 90 * MB) throw new Error(`only ${(s.usedBytes / MB).toFixed(1)} MB used`);
    const notes = (await call("query", jwt, "notifications:myNotifications", {})).page;
    const near = notes.filter((n) => n.type === "library.near_full");
    if (near.length !== 1) throw new Error(`${near.length} near-full notices`);
    return `${(s.usedBytes / MB).toFixed(1)} MB used, 1 notice`;
  });

  await step("a file in a Project is never offered for deletion", async () => {
    const projectId = await call("mutation", jwt, "projects:create", { workspaceId: ws, name: `quota-${tag}` });
    await call("mutation", jwt, "projects:linkFile", { projectId, fileId: mine[1] });
    const c = await call("query", jwt, "library:freeUpCandidates", { needBytes: 20 * MB });
    const ids = c.files.map((f) => f._id);
    if (ids.includes(mine[1])) throw new Error("the Project file was offered");
    if (!ids.includes(mine[0])) throw new Error("the oldest upload was not offered");
    return `${ids.length} offered`;
  });

  const newName = `q-new-${tag}.zip`;
  // The server's own oldest-first suggestion for a 20 MB upload: the panel must
  // pre-select exactly these, and approving must delete exactly these.
  let suggested = [];
  let offered = [];
  const pickNew = async () => {
    await page.goto(`${BASE}/en/library`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Library" }).waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.locator('input[type="file"]').first().setInputFiles({
      name: newName, mimeType: "application/zip", buffer: Buffer.alloc(20 * MB, 90),
    });
    const dialog = page.getByRole("dialog");
    await dialog.getByText(`Not enough space for ${newName}`).waitFor({ timeout: 60000 });
    return dialog;
  };

  await step("an upload that does not fit asks first — and Cancel deletes nothing", async () => {
    const c = await call("query", jwt, "library:freeUpCandidates", { needBytes: 20 * MB });
    suggested = c.plan.suggested;
    offered = c.files;
    const dialog = await pickNew();
    const boxes = dialog.getByRole("checkbox");
    const labels = await dialog.locator("label").allInnerTexts();
    if (!labels[0]?.includes(offered[0].name)) {
      throw new Error(`first offered: ${labels[0]?.split("\n")[0]} (expected the oldest, ${offered[0].name})`);
    }
    for (let i = 0; i < offered.length; i++) {
      const want = suggested.includes(offered[i]._id);
      if ((await boxes.nth(i).isChecked()) !== want) {
        throw new Error(`${offered[i].name}: pre-selected=${!want}, expected ${want}`);
      }
    }
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached", timeout: 10000 });
    await page.waitForTimeout(1500);
    for (const id of mine) {
      if (!(await call("query", jwt, "library:get", { fileId: id }))) throw new Error("Cancel deleted a file");
    }
    const list = await call("query", jwt, "library:list", {
      workspaceId: ws, paginationOpts: { numItems: 50, cursor: null }, search: newName,
    });
    if (list.page.some((f) => f.name === newName)) throw new Error("Cancel still uploaded the file");
  });

  await step("approving deletes exactly the selected file, uploads, and notifies", async () => {
    const dialog = await pickNew();
    await dialog.getByRole("button", { name: "Delete selected and upload" }).click();
    const n = suggested.length;
    await page
      .getByText(`Deleted ${n} file${n === 1 ? "" : "s"} to make room for ${newName}`)
      .waitFor({ timeout: 90000 });
    for (const f of offered) {
      const alive = !!(await call("query", jwt, "library:get", { fileId: f._id }));
      const selected = suggested.includes(f._id);
      if (selected && alive) throw new Error(`selected ${f.name} survived`);
      if (!selected && !alive) throw new Error(`UNSELECTED ${f.name} was deleted`);
    }
    if (!(await call("query", jwt, "library:get", { fileId: mine[1] }))) {
      throw new Error("the Project-linked file was deleted");
    }
    const list = await call("query", jwt, "library:list", {
      workspaceId: ws, paginationOpts: { numItems: 50, cursor: null }, search: newName,
    });
    const created = list.page.find((f) => f.name === newName);
    if (!created) throw new Error("the new file is not in the Library");
    mine.push(created._id);
    const s = await call("query", jwt, "library:storageSummary", {});
    if (s.usedBytes > 100 * MB) throw new Error(`over quota: ${(s.usedBytes / MB).toFixed(1)} MB`);
    const notes = (await call("query", jwt, "notifications:myNotifications", {})).page;
    if (!notes.some((n) => n.type === "library.evicted")) throw new Error("no 'deleted to make room' notification");
    return `${n} deleted exactly as selected, ${(s.usedBytes / MB).toFixed(1)} MB used after`;
  });

  await step("cleanup: everything this run uploaded is removed", async () => {
    // Anything this suite named — including a new file a failed step left.
    const all = await call("query", jwt, "library:list", {
      workspaceId: ws, paginationOpts: { numItems: 50, cursor: null },
    });
    for (const f of all.page) {
      if (/^q-(\d|new)-[a-z0-9]+\.zip$/.test(f.name)) {
        await call("mutation", jwt, "userFiles:remove", { fileId: f._id }).catch(() => {});
      }
    }
    const s = await call("query", jwt, "library:storageSummary", {});
    return `${(s.usedBytes / MB).toFixed(1)} MB left (seeded files excluded)`;
  });

  await browser.close();
  const pass = results.filter(Boolean).length;
  console.log(`console errors: ${errors.length}${errors.length ? ` — ${errors[0]}` : ""}`);
  const ok = pass === results.length && errors.length === 0;
  console.log(`\n=== LIBRARY QUOTA: ${pass}/${results.length}, ${ok ? "PASS" : "FAIL"} ===`);
  process.exit(ok ? 0 : 1);
})();
