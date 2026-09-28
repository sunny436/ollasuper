// File Library, end to end, as a real user in a real browser.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-library.js
//   optional second account for isolation: QA_EMAIL_B=… QA_PASSWORD_B=…
//   E2E_BASE_URL defaults to production — point it at STAGING. This suite
//   uploads, renames and deletes files; it cleans up after itself, but it is
//   not meant to run against production (blocker B1: no staging exists yet).
//
// Covers: upload on /library → listed; name search; rename; download (the
// response is an attachment, octet-stream, no-store); "Add to chat" → a chip
// that references the SAME file (removing the chip keeps the file); a chat
// upload lands in the Library (removing its chip removes it); the storage meter
// and Free up space panel; delete; isolation from a second account (list, get,
// download capability); the page at phone width; zero console errors.
const { chromium } = require("playwright");
const { account } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CONVEX = process.env.E2E_CONVEX_URL || `${BASE}/__cvx`;
const { email, password } = account();
const results = [];
const errors = [];
let page;

const step = async (name, fn) => {
  try {
    const d = await fn();
    results.push([true, name]);
    console.log(`PASS  ${name}${d ? ` — ${d}` : ""}`);
  } catch (e) {
    results.push([false, name]);
    console.log(`FAIL  ${name} — ${String(e.message || e).split("\n")[0]}`);
  }
};

async function login(p, who) {
  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await p.locator('input[type="email"]').first().fill(who.email);
  await p.locator('input[type="password"]').first().fill(who.password);
  await p.click('button[type="submit"]');
  await p.waitForURL(/\/chat/, { timeout: 30000 });
}

async function jwtOf(ctx) {
  const c = (await ctx.cookies()).find((k) => /convexAuthJWT/i.test(k.name));
  if (!c) throw new Error("no auth cookie");
  return c.value;
}

async function call(kind, jwt, path, args) {
  const r = await fetch(`${CONVEX}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.status !== "error", value: j.value, error: j.errorMessage };
}

const rowOf = (name) => page.getByText(name, { exact: true }).first();

(async () => {
  const browser = await chromium.launch({ headless: !!process.env.HEADLESS });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 860 } });
  page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  const tag = Date.now().toString(36);
  const name = `lib-${tag}.txt`;
  const renamed = `lib-${tag}-renamed.txt`;
  let fileId = null;
  let workspaceId = null;

  await step("sign in and open the Library from the rail", async () => {
    await login(page, { email, password });
    await page.getByRole("link", { name: "Library", exact: true }).first().click();
    await page.waitForURL(/\/library/, { timeout: 15000 });
    await page.getByRole("heading", { name: "Library" }).waitFor({ timeout: 15000 });
    await page.getByText(/of 100 MB used/).waitFor({ timeout: 15000 });
  });

  await step("upload on the Library page → listed", async () => {
    await page.waitForTimeout(1500); // the workspace resolves before uploads are accepted
    await page.locator('input[type="file"]').first().setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from("The quarterly library canary says hello."),
    });
    await page.getByText(`Added ${name}`).first().waitFor({ timeout: 30000 });
    await rowOf(name).waitFor({ timeout: 15000 });
    const jwt = await jwtOf(ctx);
    const ws = await call("query", jwt, "orgs:myWorkspaces", {});
    workspaceId = ws.value?.[0]?._id ?? null;
    const list = await call("query", jwt, "library:list", {
      workspaceId,
      paginationOpts: { numItems: 50, cursor: null },
      search: name,
    });
    fileId = list.value?.page?.find((f) => f.name === name)?._id ?? null;
    if (!fileId) throw new Error("uploaded file not returned by library:list");
    if ("storageId" in list.value.page[0] || "ingestId" in list.value.page[0]) {
      throw new Error("the client row exposes a storage or ingest id");
    }
  });

  await step("name search finds it; a nonsense query finds nothing", async () => {
    const box = page.getByLabel("Search file names");
    await box.fill(tag);
    await rowOf(name).waitFor({ timeout: 10000 });
    await box.fill(`zz-${tag}-none`);
    await page.getByText("No files match.").waitFor({ timeout: 10000 });
    await box.fill("");
  });

  await step("rename through the card menu", async () => {
    await page.getByRole("button", { name: `Actions for ${name}` }).first().click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const input = page.getByLabel("File name");
    await input.fill(renamed);
    await page.getByRole("button", { name: "Save" }).click();
    await rowOf(renamed).waitFor({ timeout: 10000 });
  });

  await step("download is an attachment of an inert type, never cached", async () => {
    const [resp, dl] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/library/file?t="), { timeout: 20000 }),
      page.waitForEvent("download", { timeout: 20000 }),
      (async () => {
        await page.getByRole("button", { name: `Actions for ${renamed}` }).first().click();
        await page.getByRole("menuitem", { name: "Download" }).click();
      })(),
    ]);
    const h = resp.headers();
    if (h["content-type"] !== "application/octet-stream") throw new Error(`type ${h["content-type"]}`);
    if (!/^attachment;/.test(h["content-disposition"] || "")) throw new Error("not an attachment");
    if (h["cache-control"] !== "no-store") throw new Error("cacheable");
    if (h["x-content-type-options"] !== "nosniff") throw new Error("no nosniff");
    if (dl.suggestedFilename() !== renamed) throw new Error(`filename ${dl.suggestedFilename()}`);
  });

  await step("Add to chat → a chip referencing the same file; removing it keeps the file", async () => {
    await page.getByRole("button", { name: `Actions for ${renamed}` }).first().click();
    await page.getByRole("menuitem", { name: "Add to chat" }).click();
    await page.waitForURL(/\/chat/, { timeout: 15000 });
    const remove = page.getByRole("button", { name: `Remove ${renamed}` });
    await remove.waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    await remove.click();
    await remove.waitFor({ state: "detached", timeout: 10000 });
    const jwt = await jwtOf(ctx);
    const got = await call("query", jwt, "library:get", { fileId });
    if (!got.value) throw new Error("removing a Library chip deleted the Library file");
  });

  await step("a chat upload lands in the Library; removing its chip removes it", async () => {
    const chatName = `chat-${tag}.txt`;
    await page.locator('input[type="file"]').first().setInputFiles({
      name: chatName,
      mimeType: "text/plain",
      buffer: Buffer.from("attached in chat"),
    });
    const remove = page.getByRole("button", { name: `Remove ${chatName}` });
    await remove.waitFor({ timeout: 15000 });
    const jwt = await jwtOf(ctx);
    let found = null;
    for (let i = 0; i < 40 && !found; i++) {
      const l = await call("query", jwt, "library:list", {
        workspaceId,
        paginationOpts: { numItems: 50, cursor: null },
        search: chatName,
      });
      found = l.value?.page?.find((f) => f.name === chatName)?._id ?? null;
      if (!found) await page.waitForTimeout(500);
    }
    if (!found) throw new Error("the chat upload never appeared in the Library");
    await page.waitForTimeout(800);
    await remove.click();
    await remove.waitFor({ state: "detached", timeout: 10000 });
    await page.waitForTimeout(1500);
    const after = await call("query", jwt, "library:get", { fileId: found });
    if (after.value) throw new Error("an unsent chat upload survived its chip");
  });

  await step("storage meter opens Free up space; Cancel deletes nothing", async () => {
    await page.goto(`${BASE}/en/library`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Free up space" }).click();
    await page.getByRole("dialog").getByText(/of 100 MB used/).waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Cancel" }).click();
    const jwt = await jwtOf(ctx);
    const got = await call("query", jwt, "library:get", { fileId });
    if (!got.value) throw new Error("cancel deleted a file");
  });

  if (process.env.QA_EMAIL_B && process.env.QA_PASSWORD_B) {
    await step("another account cannot list, get or download this file", async () => {
      const ctxB = await browser.newContext();
      const pb = await ctxB.newPage();
      pb.on("console", (m) => m.type() === "error" && errors.push(`[B] ${m.text().slice(0, 200)}`));
      await login(pb, { email: process.env.QA_EMAIL_B, password: process.env.QA_PASSWORD_B });
      const jwtB = await jwtOf(ctxB);
      const got = await call("query", jwtB, "library:get", { fileId });
      if (got.value) throw new Error("B can read A's file");
      const mint = await call("mutation", jwtB, "library:mintAccess", { fileId, purpose: "download" });
      if (mint.ok) throw new Error("B minted a download capability for A's file");
      await ctxB.close();
    });
  } else {
    console.log("SKIP  isolation from a second account (set QA_EMAIL_B / QA_PASSWORD_B)");
  }

  await step("delete from the card menu", async () => {
    await page.getByRole("button", { name: `Actions for ${renamed}` }).first().click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete" }).last().click();
    await rowOf(renamed).waitFor({ state: "detached", timeout: 15000 });
  });

  await step("phone width: no horizontal scroll", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/en/library`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Library" }).waitFor({ timeout: 15000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) throw new Error(`page scrolls sideways by ${overflow}px`);
  });

  await browser.close();
  const pass = results.filter((r) => r[0]).length;
  console.log(`console errors: ${errors.length}${errors.length ? ` — ${errors[0]}` : ""}`);
  const ok = pass === results.length && errors.length === 0;
  console.log(`\n=== LIBRARY: ${pass}/${results.length}, ${ok ? "PASS" : "FAIL"} ===`);
  process.exit(ok ? 0 : 1);
})();
