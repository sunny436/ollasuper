// Projects — races against the INGESTION window.
//
// Ingestion is the one Project operation with a real duration: parse, chunk,
// embed, write. That window is where "the Project decides what is retrievable"
// can quietly stop being true, because the file is already becoming searchable
// while the thing that scoped it is being taken away.
//
// Three races, each asking whether a document that finished ingesting into a
// scope that no longer exists can still be reached:
//
//   A. DELETE the Project mid-ingestion.
//   B. UNLINK the file mid-ingestion.
//   C. RETRY afterwards — the question asked a second time, because a stale
//      cache or a half-written edge would show up on the second ask, not the
//      first.
//
// The file is deliberately large enough to take real time to embed; a 200-byte
// file finishes in ~2s and there is no window to race.
//
//   E2E_BASE_URL=https://app.ollasuper.com CONVEX_URL=http://127.0.0.1:3210 \
//     node qa-projects-ingest-race.js
const { chromium } = require("playwright");
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";

const RUN = Date.now().toString(36).slice(-6);
const MARK_DEL = `INGESTDELETE${RUN.toUpperCase()}`;
const MARK_UNLINK = `INGESTUNLINK${RUN.toUpperCase()}`;

const errs = [];
const results = [];
const notes = [];
const step = async (n, f) => {
  try {
    await f();
    results.push(true);
    console.log("PASS  " + n);
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + n + " — " + String(e.message).split("\n")[0]);
  }
};

const settle = async (page, ms = 240000) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ timeout: 25000 }).catch(() => {});
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await stop.count()) === 0) return true;
    await page.waitForTimeout(600);
  }
  return false;
};

async function admin() {
  const c = new ConvexHttpClient(CONVEX_URL);
  const r = await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email: EMAIL, password: PASSWORD, flow: "signIn" },
  });
  const a = new ConvexHttpClient(CONVEX_URL);
  a.setAuth(r.tokens.token);
  return a;
}

/** Big enough that parse+chunk+embed is a window, not an instant. */
function bigFile(marker, label) {
  const tmp = path.join(os.tmpdir(), `qa-ingrace-${label}-${RUN}.txt`);
  const filler = [];
  for (let i = 0; i < 400; i++) {
    filler.push(
      `Section ${i}. Operational notes for the ${label} programme covering supply, staffing, logistics, procurement cadence, vendor scoring, and quarterly review posture. Each section repeats deliberately so the document produces many chunks and therefore a real embedding window.`,
    );
    if (i === 200) filler.push(`The ${label} verification marker is ${marker}.`);
  }
  fs.writeFileSync(tmp, filler.join("\n\n"), "utf8");
  return tmp;
}

/** Upload and return as soon as the row is VISIBLY processing (the window). */
async function startIngestion(page, pid, file) {
  await page.goto(BASE + `/en/projects/${pid}?tab=sources`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(1000);
  await page.locator('input[type="file"]').setInputFiles(file);
  const name = path.basename(file);
  await page.getByText(name, { exact: false }).first().waitFor({ timeout: 90000 });
  return name;
}

async function waitIngested(page, pid, name, ms = 300000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await page.goto(BASE + `/en/projects/${pid}?tab=sources`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(1500);
    const body = await page.locator("body").innerText();
    if (!body.includes("Processing") && !body.includes("Extracting")) return true;
    await page.waitForTimeout(3000);
  }
  return false;
}

(async () => {
  const C = await admin();
  const ws = (await C.query(anyApi.orgs.myWorkspaces, {}))[0]._id;

  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 35,
  });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.on("dialog", (d) => d.accept().catch(() => {}));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });

  let pDel = null;
  let pUnlink = null;
  let pProbe = null;

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 25000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
  });

  await step("provision three Projects", async () => {
    pDel = await C.mutation(anyApi.projects.create, { workspaceId: ws, name: `QA IngDel ${RUN}` });
    pUnlink = await C.mutation(anyApi.projects.create, { workspaceId: ws, name: `QA IngUnlink ${RUN}` });
    pProbe = await C.mutation(anyApi.projects.create, { workspaceId: ws, name: `QA IngProbe ${RUN}` });
  });

  // ---------------------------------------------- RACE A: delete mid-ingestion
  await step("RACE A: the Project is DELETED while its file is still ingesting", async () => {
    const f = bigFile(MARK_DEL, "DELETE");
    const name = await startIngestion(page, pDel, f);
    // Delete immediately — the row exists, the embedding does not.
    await C.mutation(anyApi.projects.remove, { projectId: pDel });
    const p = await C.query(anyApi.projects.get, { projectId: pDel });
    if (!p || p.status !== "trashed")
      throw new Error(`project should be trashed, is ${p?.status}`);
    notes.push(`race A raced ingestion of ${name}`);
    // Let ingestion run to completion against the now-dead Project.
    await page.waitForTimeout(20000);
  });

  await step("RACE A: the file survived, but the dead Project exposes nothing", async () => {
    // The user's file must still exist (it is theirs, not the Project's)...
    let cursor = null;
    let alive = false;
    for (let i = 0; i < 6 && !alive; i++) {
      const pg = await C.query(anyApi.userFiles.list, {
        workspaceId: ws,
        paginationOpts: { numItems: 50, cursor },
      });
      alive = (pg.page ?? []).some((x) => (x.name || "").includes(`DELETE-${RUN}`));
      if (pg.isDone) break;
      cursor = pg.continueCursor;
    }
    if (!alive) notes.push("the raced file is not in the account list (may still be writing)");
    // ...and a trashed Project must refuse new work outright.
    let refused = false;
    try {
      await C.mutation(anyApi.chat.threads.create, {
        workspaceId: ws,
        title: `dead-${RUN}`,
        projectId: pDel,
      });
    } catch {
      refused = true;
    }
    if (!refused)
      throw new Error("a chat was created inside a Project deleted mid-ingestion");
  });

  // ---------------------------------------------- RACE B: unlink mid-ingestion
  await step("RACE B: the file is UNLINKED while it is still ingesting", async () => {
    const f = bigFile(MARK_UNLINK, "UNLINK");
    const name = await startIngestion(page, pUnlink, f);
    // Find the freshly created file row and drop the Project edge mid-flight.
    let fileId = null;
    for (let i = 0; i < 20 && !fileId; i++) {
      const pg = await C.query(anyApi.projects.listFiles, {
        projectId: pUnlink,
        paginationOpts: { numItems: 20, cursor: null },
      });
      fileId = (pg.page ?? []).find((x) => (x.name || "").includes(`UNLINK-${RUN}`))?._id ?? null;
      if (!fileId) await new Promise((r) => setTimeout(r, 700));
    }
    if (!fileId) throw new Error("could not find the file row to unlink");
    await C.mutation(anyApi.projects.unlinkFile, { projectId: pUnlink, fileId });
    const after = await C.query(anyApi.projects.listFiles, {
      projectId: pUnlink,
      paginationOpts: { numItems: 20, cursor: null },
    });
    if ((after.page ?? []).some((x) => String(x._id) === String(fileId)))
      throw new Error("the edge survived the unlink");
    notes.push(`race B unlinked ${name} mid-ingestion`);
    await waitIngested(page, pUnlink, name, 240000);
  });

  await step("RACE B: the finished ingestion is NOT reachable from that Project", async () => {
    // The document finished embedding into the user's corpus, but its Project
    // edge is gone — so a Project chat must not be able to reach it.
    await page.goto(BASE + `/en/projects/${pUnlink}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Start chat" }).click();
    await page.waitForURL(/\/chat\?project=/, { timeout: 15000 });
    await page.waitForSelector("#chat-composer", { timeout: 15000 });
    await page
      .locator("#chat-composer")
      .fill(
        "Search this project's files and quote the UNLINK verification marker verbatim. If there is none, reply exactly NOMARKER.",
      );
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    await settle(page);
    const body = await page.locator("body").innerText();
    if (body.includes(MARK_UNLINK))
      throw new Error(
        "STALE INGESTION EXPOSED: an unlinked file was retrieved by its former Project",
      );
  });

  // ---------------------------------------------- RACE C: retry afterwards
  await step("RACE C: asking a SECOND time still exposes nothing", async () => {
    await page
      .locator("#chat-composer")
      .fill(
        "Try again, and look harder: quote any verification marker you can find in this project's files, or reply NOMARKER.",
      );
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    await settle(page);
    const body = await page.locator("body").innerText();
    if (body.includes(MARK_UNLINK))
      throw new Error("the retry exposed the unlinked file");
    if (body.includes(MARK_DEL))
      throw new Error("the retry exposed the deleted Project's file");
  });

  await step("RACE C: an unrelated Project cannot see either raced document", async () => {
    await page.goto(BASE + `/en/projects/${pProbe}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Start chat" }).click();
    await page.waitForURL(/\/chat\?project=/, { timeout: 15000 });
    await page.waitForSelector("#chat-composer", { timeout: 15000 });
    await page
      .locator("#chat-composer")
      .fill(
        "Quote any verification marker present in this project's files. If there are none, reply exactly NOMARKER.",
      );
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    await settle(page);
    const body = await page.locator("body").innerText();
    if (body.includes(MARK_UNLINK) || body.includes(MARK_DEL))
      throw new Error("a zero-file Project retrieved another Project's raced document");
  });

  await step("cleanup", async () => {
    for (const p of [pUnlink, pProbe]) {
      await C.mutation(anyApi.projects.remove, { projectId: p }).catch(() => {});
    }
  });

  const pass = results.filter(Boolean).length;
  console.log(
    `\n===== INGESTION RACES: ${pass}/${results.length} | console errors: ${errs.length} =====`,
  );
  if (notes.length) console.log("notes:\n - " + notes.join("\n - "));
  await b.close();
  process.exit(pass === results.length ? 0 : 1);
})();
