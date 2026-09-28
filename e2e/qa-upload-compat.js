// The deploy window: NEW Convex (mints ticketed upload URLs) behind the OLD
// edge (forwards every upload untouched). Proves uploads keep working in that
// window, so the edge can follow Convex rather than land in the same second.
//
//   E2E_BASE_URL=http://localhost:3400 QA_EMAIL=… QA_PASSWORD=… \
//   E2E_DIRECT_CVX=http://localhost:3310 node qa-upload-compat.js
//
// The "old edge" is simulated exactly: the minted URL's path and query are
// POSTed straight to the Convex API port, as a plain proxy would forward them.
// Staging only.
const { chromium } = require("playwright");
const { account } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3400";
const CONVEX = `${BASE}/__cvx`;
const DIRECT = process.env.E2E_DIRECT_CVX || "http://localhost:3310";
if (!/localhost|127\.0\.0\.1/.test(BASE + DIRECT)) throw new Error("staging only");

async function call(kind, jwt, path, args) {
  const r = await fetch(`${CONVEX}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.status !== "error", value: j.value, error: j.errorMessage };
}

(async () => {
  const { email, password } = account();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  // Hydrated first: filled before React attaches, the form submits empty.
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
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 60000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 60000 });
  const jwt = (await ctx.cookies()).find((k) => /convexAuthJWT/i.test(k.name))?.value;
  await browser.close();
  if (!jwt) throw new Error("no auth cookie");

  const workspaceId = (await call("query", jwt, "orgs:myWorkspaces", {})).value?.[0]?._id;
  const name = `compat-${Date.now().toString(36)}.txt`;
  const body = Buffer.from(`old-edge compatibility probe ${name}\n`);
  const begin = await call("mutation", jwt, "library:beginUpload", {
    workspaceId, name, contentType: "text/plain", size: body.length, purpose: "library",
  });
  if (!begin.ok || !begin.value.ok) throw new Error(`begin: ${begin.error}`);
  const minted = new URL(begin.value.uploadUrl);
  if (!minted.searchParams.get("lt")) throw new Error("the minted URL carries no ticket");
  // What an old edge does: strip its /__cvx prefix and forward path + query.
  const direct = `${DIRECT}${minted.pathname.replace(/^\/__cvx/, "")}${minted.search}`;
  const up = await fetch(direct, { method: "POST", headers: { "content-type": "text/plain" }, body });
  if (up.status !== 200) throw new Error(`Convex refused a ticketed URL forwarded untouched: ${up.status}`);
  const { storageId } = await up.json();
  const fin = await call("mutation", jwt, "library:finishUpload", {
    intentId: begin.value.intentId, storageId, name, contentType: "text/plain",
  });
  if (!fin.ok || !fin.value.ok) throw new Error(`finish: ${fin.error || fin.value?.code}`);
  const del = await call("mutation", jwt, "library:removeMany", { fileIds: [fin.value.fileId] });
  if (!del.ok) throw new Error(`cleanup: ${del.error}`);
  console.log("PASS  new Convex + old edge: a ticketed URL forwarded untouched uploads, finishes, and was cleaned up");
})().catch((e) => {
  console.log(`FAIL  ${e.message}`);
  process.exit(1);
});
