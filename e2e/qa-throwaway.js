// A disposable account for an e2e run that needs real volume — and its
// complete removal afterwards.
//
//   node qa-throwaway.js setup    <credsFile>   # sign up, verify, seed
//   node qa-throwaway.js teardown <credsFile>   # delete the account, prove it
//
// Everything the account owns is created THROUGH THE NORMAL AUTHORIZED API AS
// THAT USER — the same `chat/threads:create` and `userFiles:*` mutations the UI
// calls, over Convex's HTTP API with the user's own JWT. No admin key, no
// direct table writes, no backend code added for testing. Teardown uses the
// product's own `users:deleteCurrentUserAccount`, which re-authenticates and
// cascades.
//
// The password is generated here, written to a 0600 file, and NEVER printed.
const fs = require("node:fs");
const crypto = require("node:crypto");
const { chromium } = require("playwright");
const ollastack = require("./_lib/ollastack");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CONVEX = `${BASE}/__cvx`;
const [MODE, FILE] = process.argv.slice(2);
const THREADS = Number(process.env.SEED_THREADS || 70); // 3 rail pages of 30
const FILES = Number(process.env.SEED_FILES || 45); //     3 Files pages of 20
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!["setup", "teardown"].includes(MODE) || !FILE) {
  console.error("usage: node qa-throwaway.js setup|teardown <credsFile>");
  process.exit(2);
}

async function signIn(page, email, password) {
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
}

/** The user's own JWT: @convex-dev/auth's Next integration keeps it in an httpOnly cookie. */
async function jwtOf(ctx) {
  const c = (await ctx.cookies()).find((k) => /convexAuthJWT/i.test(k.name));
  if (!c) throw new Error(`no auth cookie (have: ${(await ctx.cookies()).map((k) => k.name).join(", ")})`);
  return c.value;
}

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

(async () => {
  if (!ollastack.enabled()) throw new Error("OLLASTACK_MAIL_TOKEN / OLLASTACK_E2E_MAILBOX_ID not set");
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  if (MODE === "setup") {
    const tag = ollastack.newTag();
    const email = ollastack.taggedAddress(await ollastack.mailboxAddress(), tag);
    // Satisfies the sign-up policy: upper, lower, digit, special, >= 8.
    const password = `Qa${crypto.randomBytes(12).toString("base64url")}!7z`;
    fs.writeFileSync(FILE, JSON.stringify({ email, password, tag }), { mode: 0o600 });
    console.log(`throwaway: ${email}`);

    await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => {
        const f = document.querySelector("form");
        return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber"));
      },
      null,
      { timeout: 30000 },
    );
    await page.click('button:has-text("Create an account")');
    await page.fill('input[name="name"]', "QA Throwaway");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[name="code"]', { timeout: 30000 });
    const code = await ollastack.codeFromOllastack(tag, "email verification", 120000);
    if (!code) throw new Error("no verification code arrived");
    await page.fill('input[name="code"]', code);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/chat/, { timeout: 30000 });
    await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
    console.log("  signed up and verified through the real inbox");

    const jwt = await jwtOf(ctx);
    const ws = await call("query", jwt, "orgs:myWorkspaces", {});
    const workspaceId = ws?.[0]?._id;
    if (!workspaceId) throw new Error("no workspace");

    for (let i = 1; i <= THREADS; i++) {
      await call("mutation", jwt, "chat/threads:create", {
        workspaceId,
        title: `seed ${String(i).padStart(3, "0")}`,
      });
    }
    console.log(`  seeded ${THREADS} conversations`);

    for (let i = 1; i <= FILES; i++) {
      // Unique content per file: saveFile dedups on the content hash per user.
      const body = `QA throwaway seed file ${i} — ${tag} — ${crypto.randomUUID()}\n`;
      const bytes = Buffer.from(body, "utf8");
      const uploadUrl = await call("mutation", jwt, "userFiles:generateUploadUrl", { workspaceId });
      const up = await fetch(uploadUrl, { method: "POST", headers: { "content-type": "text/plain" }, body: bytes });
      const { storageId } = await up.json();
      await call("mutation", jwt, "userFiles:saveFile", {
        workspaceId,
        storageId,
        name: `seed-${String(i).padStart(3, "0")}.txt`,
        size: bytes.length,
        contentType: "text/plain",
        contentHash: crypto.createHash("sha256").update(bytes).digest("hex"),
      });
    }
    console.log(`  seeded ${FILES} files`);
    console.log("SETUP OK");
  } else {
    const { email, password } = JSON.parse(fs.readFileSync(FILE, "utf8"));
    await signIn(page, email, password);
    await page.waitForURL(/\/chat/, { timeout: 30000 });
    await sleep(2000);
    const jwt = await jwtOf(ctx);
    await call("action", jwt, "users:deleteCurrentUserAccount", { password });
    console.log("  account deletion requested through the product's own flow");
    await sleep(3000);

    // Proof it is gone: the same credentials must no longer sign in.
    const fresh = await browser.newContext();
    const p2 = await fresh.newPage();
    await signIn(p2, email, password);
    await sleep(6000);
    const stillIn = /\/chat/.test(p2.url());
    console.log(stillIn ? "TEARDOWN FAILED — the account still signs in" : "TEARDOWN OK — sign-in now refused");
    if (!stillIn) fs.rmSync(FILE, { force: true });
    await fresh.close();
    if (stillIn) process.exitCode = 1;
  }
  await browser.close();
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
