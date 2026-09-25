// Give a DISPOSABLE account (from qa-throwaway.js) enough rows that every one
// of the 16 infinite-scroll lists has several pages to load.
//
//   node qa-seed-lists.js <account.json>
//
// Everything goes through the user's OWN session over Convex's HTTP API — the
// same mutations the UI calls. Memories have no create mutation at all (only
// the model writes them, through its remember tool), so those two lists are
// filled the way a user would: by asking in a chat, once globally and once
// inside a Project. qa-throwaway.js already seeds 70 rail chats + 45 files.
//
// Writes <account.json>.lists.json with the ids qa-lists-all.js needs.
const fs = require("node:fs");
const crypto = require("node:crypto");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CONVEX = `${BASE}/__cvx`;
const [FILE] = process.argv.slice(2);
if (!FILE) {
  console.error("usage: node qa-seed-lists.js <account.json>");
  process.exit(2);
}
const ACCT = JSON.parse(fs.readFileSync(FILE, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (i) => String(i).padStart(3, "0");

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

async function allPages(jwt, fn, args) {
  const out = [];
  let cursor = null;
  for (;;) {
    const res = await call("query", jwt, fn, { ...args, paginationOpts: { numItems: 100, cursor } });
    out.push(...res.page);
    if (res.isDone) return out;
    cursor = res.continueCursor;
  }
}

/** One chat turn in the UI; waits until the reply has finished. */
async function turn(page, href, text) {
  await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded" });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  await page.locator("#chat-composer").fill(text);
  await page.keyboard.press("Enter");
  await page.locator('button[aria-label="Stop generating"]').waitFor({ timeout: 30000 }).catch(() => {});
  await page.locator('button[aria-label="Stop generating"]').waitFor({ state: "detached", timeout: 240000 });
}

const facts = (prefix, n) =>
  Array.from({ length: n }, (_, i) => `${i + 1}. ${prefix} fact ${pad(i + 1)}: my code word number ${i + 1} is ${crypto.randomBytes(3).toString("hex")}.`).join("\n");

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const f = document.querySelector("form"); return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber")); }, null, { timeout: 30000 });
  await page.locator('input[type="email"]').first().fill(ACCT.email);
  await page.locator('input[type="password"]').first().fill(ACCT.password);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
  const jwt = (await ctx.cookies()).find((k) => /convexAuthJWT/i.test(k.name)).value;
  const workspaceId = (await call("query", jwt, "orgs:myWorkspaces", {}))[0]._id;
  const seed = { workspaceId };

  // Projects: 70 = three pages of 30 for the Projects pane and the Move dialog.
  // The HOST is created first, so it is the OLDEST — it holds the Project lists.
  seed.hostId = await call("mutation", jwt, "projects:create", { workspaceId, name: "list-host" });
  for (let i = 1; i <= 69; i++) await call("mutation", jwt, "projects:create", { workspaceId, name: `list-proj ${pad(i)}` });
  console.log("  70 projects");

  // Project chats: 65 = pages of 30 + 30 + 5.
  for (let i = 1; i <= 65; i++) {
    const threadId = await call("mutation", jwt, "chat/threads:create", { workspaceId, title: `proj-chat ${pad(i)}` });
    await call("mutation", jwt, "projects:moveThread", { threadId, projectId: seed.hostId });
  }
  console.log("  65 project chats");

  // Archived: 45 = pages of 20 + 20 + 5.
  for (let i = 1; i <= 45; i++) {
    const threadId = await call("mutation", jwt, "chat/threads:create", { workspaceId, title: `archived ${pad(i)}` });
    await call("mutation", jwt, "chat/threads:archive", { threadId, archived: true });
  }
  console.log("  45 archived chats");

  // Project sources: every one of the 45 user files, linked to the host.
  const myFiles = await allPages(jwt, "userFiles:list", { workspaceId });
  for (const f of myFiles) await call("mutation", jwt, "projects:linkFile", { projectId: seed.hostId, fileId: f._id });
  console.log(`  ${myFiles.length} files linked to the host project`);

  // Workspace files (a different table from userFiles): 45.
  for (let i = 1; i <= 45; i++) {
    const bytes = Buffer.from(`workspace seed file ${i} — ${crypto.randomUUID()}\n`, "utf8");
    const url = await call("mutation", jwt, "files:generateUploadUrl", { workspaceId });
    const up = await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: bytes });
    const { storageId } = await up.json();
    await call("mutation", jwt, "files:saveFile", { workspaceId, storageId, name: `ws-seed-${pad(i)}.txt`, size: bytes.length, contentType: "text/plain" });
  }
  console.log("  45 workspace files");

  // Shares: 30 — the per-hour cap — = pages of 20 + 10.
  const rail = await allPages(jwt, "chat/threads:list", { workspaceId, unassignedOnly: true });
  for (const t of rail.slice(0, 30)) await call("mutation", jwt, "chat/shares:create", { shareType: "full_chat", threadId: t._id });
  console.log("  30 shares");

  // Custom skills: 50 — the per-user cap — = pages of 30 + 20.
  for (let i = 1; i <= 50; i++) {
    await call("mutation", jwt, "userSkills:create", {
      workspaceId,
      name: `Seed skill ${pad(i)}`,
      description: `A seeded skill number ${i} for pagination testing.`,
      instructions: `When asked about seed ${i}, answer briefly.`,
    });
  }
  console.log("  50 skills");

  // Memories: only the model writes them. One turn globally, one in the host.
  const ask = (what, n) =>
    `Please save each of the following ${n} numbered items as its OWN separate memory about me (one memory per line, ${n} memories in total, do not merge them). ${what}\n${facts(what, n)}\nReply only with "saved".`;
  await turn(page, "/chat", ask("Personal", 40));
  const projThread = await call("mutation", jwt, "chat/threads:create", { workspaceId, title: "memory host chat" });
  await call("mutation", jwt, "projects:moveThread", { threadId: projThread, projectId: seed.hostId });
  await turn(page, `/chat/${projThread}`, ask("Project", 30));
  await sleep(4000);
  const mem = await call("query", jwt, "memories:list", { workspaceId, paginationOpts: { numItems: 200, cursor: null } }).catch(() => null);
  const pmem = await allPages(jwt, "projects:listMemories", { projectId: seed.hostId });
  console.log(`  memories: ${mem ? mem.page.length : "?"} global-list rows, ${pmem.length} project rows (model-written)`);

  fs.writeFileSync(`${FILE}.lists.json`, JSON.stringify(seed, null, 2));
  await browser.close();
  console.log("SEED OK");
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
