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

  // Low disk, in the real stack: a second edge whose free-space floor this host
  // cannot meet (EDGE_MIN_FREE_BYTES=1e15) must refuse with 507 BEFORE a byte
  // is forwarded - and without spending the ticket, so the same upload goes
  // through the normal edge once there is room.
  const LOW = process.env.E2E_LOWDISK_EDGE;
  if (LOW) {
    const name2 = `lowdisk-${Date.now().toString(36)}.txt`;
    const body2 = Buffer.from(`low-disk probe ${name2}\n`);
    const b2 = await call("mutation", jwt, "library:beginUpload", {
      workspaceId, name: name2, contentType: "text/plain", size: body2.length, purpose: "library",
    });
    if (!b2.ok || !b2.value.ok) throw new Error(`begin (low disk): ${b2.error}`);
    const u = new URL(b2.value.uploadUrl);
    const refused = await fetch(`${LOW}${u.pathname.replace(/^\/__cvx/, "")}${u.search}`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: body2,
    });
    if (refused.status !== 507) throw new Error(`the low-disk edge answered ${refused.status}, not 507`);
    const again = await fetch(b2.value.uploadUrl, { method: "POST", headers: { "content-type": "text/plain" }, body: body2 });
    if (again.status !== 200) throw new Error(`after a 507 the ticket no longer worked (${again.status})`);
    const { storageId: sid2 } = await again.json();
    const f2 = await call("mutation", jwt, "library:finishUpload", {
      intentId: b2.value.intentId, storageId: sid2, name: name2, contentType: "text/plain",
    });
    if (!f2.ok || !f2.value.ok) throw new Error(`finish (after 507): ${f2.error || f2.value?.code}`);
    await call("mutation", jwt, "library:removeMany", { fileIds: [f2.value.fileId] });
    console.log("PASS  low disk: the edge refused with 507 before forwarding, and the unspent ticket then uploaded normally");
  }
})().catch((e) => {
  console.log(`FAIL  ${e.message}`);
  process.exit(1);
});
