// Projects — is Project memory a real storage scope, or just a label?
//
// Phase 4 stores project-scoped memory as scope:"project" + projectId, derived
// SERVER-SIDE from the stream's thread. The claim under test is not "the row has
// a field" but the consequence: a memory learned inside a Project must be
// invisible to a chat outside it.
//
// So this proves the boundary twice, at two different layers:
//   1. STORAGE — the row comes back from projects.listMemories for its own
//      Project, carries scope "project", and names that projectId.
//   2. RETRIEVAL — an unrelated chat, in the same workspace and the same
//      account, cannot produce the secret.
//
// Layer 2 alone would be weak (a model can decline for its own reasons) and
// layer 1 alone would be weaker still (a field is not a boundary). Together they
// distinguish "scoped" from "merely tagged".
//
//   E2E_BASE_URL=https://app.ollasuper.com node qa-projects-memory-isolation.js
const { chromium } = require("playwright");
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();

const RUN = Date.now().toString(36).slice(-6);
const NAME = `QA Mem ${RUN}`;
const SECRET = `VAULT${RUN.toUpperCase()}`;

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

const settle = async (page, ms = 180000) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ timeout: 25000 }).catch(() => {});
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await stop.count()) === 0) return true;
    await page.waitForTimeout(500);
  }
  return false;
};

async function convexAsAdmin() {
  const c = new ConvexHttpClient(CONVEX_URL);
  const r = await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email: EMAIL, password: PASSWORD, flow: "signIn" },
  });
  const a = new ConvexHttpClient(CONVEX_URL);
  a.setAuth(r.tokens.token);
  return a;
}

(async () => {
  const C = await convexAsAdmin();
  const ws = (await C.query(anyApi.orgs.myWorkspaces, {}))[0]._id;

  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 45,
  });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.on("dialog", (d) => d.accept().catch(() => {}));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });

  let pid = null;
  let stored = null;

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 25000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
  });

  await step("create the Project", async () => {
    pid = await C.mutation(anyApi.projects.create, { workspaceId: ws, name: NAME });
    if (!pid) throw new Error("no project");
  });

  await step("teach the Project a secret, inside a Project chat", async () => {
    await page.goto(BASE + `/en/projects/${pid}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Start chat" }).click();
    await page.waitForURL(/\/chat\?project=/, { timeout: 15000 });
    await page.waitForSelector("#chat-composer", { timeout: 15000 });
    await page
      .locator("#chat-composer")
      .fill(
        `Please remember this for later, it is important for this project: the project vault code is ${SECRET}. Save it to memory now.`,
      );
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    await settle(page);
  });

  await step("STORAGE: the memory exists, scoped to this Project", async () => {
    // Poll: the ingress write lands shortly after the turn finishes.
    let found = null;
    for (let i = 0; i < 20 && !found; i++) {
      const page1 = await C.query(anyApi.projects.listMemories, {
        projectId: pid,
        paginationOpts: { numItems: 50, cursor: null },
      });
      found = (page1?.page ?? []).find((m) => (m.content || "").includes(SECRET));
      if (!found) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!found) {
      notes.push("the model did not call the remember tool for this turn");
      throw new Error(
        "no Project memory was created — cannot test scope without one",
      );
    }
    stored = found;
    // projects.listMemories pins .eq("projectId", id) on its INDEX, so any row
    // it returns necessarily carries this projectId — stronger than reading a
    // field back. But that projection omits scope, so assert it through the
    // settings-page query (toClient), which is what renders the "Project only"
    // badge and therefore what a user actually sees.
    const all = await C.query(anyApi.memories.list, {
      workspaceId: ws,
      paginationOpts: { numItems: 100, cursor: null },
    });
    const row = (all?.page ?? []).find((m) => (m.content || "").includes(SECRET));
    if (!row) throw new Error("the memory is not visible in Settings -> Memories");
    if (row.scope !== "project")
      throw new Error(`scope is "${row.scope}", not "project"`);
    if (String(row.projectId) !== String(pid))
      throw new Error(`projectId is ${row.projectId}, expected ${pid}`);
    console.log(`      memory ${row._id} scope=${row.scope} kind=${row.kind} projectId=${row.projectId}`);
  });

  await step("STORAGE: a sibling Project cannot see that memory", async () => {
    const other = await C.mutation(anyApi.projects.create, {
      workspaceId: ws,
      name: `QA Mem Other ${RUN}`,
    });
    const inOther = await C.query(anyApi.projects.listMemories, {
      projectId: other,
      paginationOpts: { numItems: 50, cursor: null },
    });
    if ((inOther?.page ?? []).some((m) => (m.content || "").includes(SECRET)))
      throw new Error("CROSS-PROJECT MEMORY LEAK: sibling Project sees the secret");
    await C.mutation(anyApi.projects.remove, { projectId: other });
  });

  await step("RETRIEVAL: an UNRELATED chat cannot produce the secret", async () => {
    // A brand-new chat with NO project: same user, same workspace.
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    await page
      .locator("#chat-composer")
      .fill(
        "What is the project vault code? Search your memory. If you do not have it, reply exactly NOVAULT.",
      );
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    await settle(page);
    const body = await page.locator("body").innerText();
    if (body.includes(SECRET))
      throw new Error(
        "PROJECT MEMORY LEAKED into an unrelated chat: the secret was produced",
      );
  });

  await step("the memory is still there afterwards (the probe did not delete it)", async () => {
    const page1 = await C.query(anyApi.projects.listMemories, {
      projectId: pid,
      paginationOpts: { numItems: 50, cursor: null },
    });
    if (!(page1?.page ?? []).some((m) => (m.content || "").includes(SECRET)))
      throw new Error("the Project memory vanished during the test");
  });

  await step("cleanup: forget the memory and trash the Project", async () => {
    if (stored) await C.mutation(anyApi.memories.remove, { memoryId: stored._id });
    await C.mutation(anyApi.projects.remove, { projectId: pid });
  });

  const pass = results.filter(Boolean).length;
  console.log(
    `\n===== PROJECT MEMORY ISOLATION: ${pass}/${results.length} | console errors: ${errs.length} =====`,
  );
  if (notes.length) console.log("notes: " + notes.join(" | "));
  await b.close();
  process.exit(pass === results.length ? 0 : 1);
})();
