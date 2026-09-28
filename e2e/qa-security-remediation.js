// Production acceptance for the SECURITY-AUDIT-FINAL remediation — ONE headed
// session, as a real user, covering every user-facing change in one pass.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-security-remediation.js
//   (or: node run-as.js <creds.json> qa-security-remediation.js)
//
// Checks, in order: password sign-in (F-05 live-session helpers), a chat send
// with a .txt and an .xml attachment (F-01 upload intents + claim, F-02 the
// neutralised type, F-03 the runner still streams), the storage response
// headers the browser actually receives (F-02 edge), a Files-page upload
// (F-01 files.saveFile), owner-bound caches (F-09), an unsolicited ?code= link
// (F-14), an anonymous reset request for this account (F-06), and sign-out
// clearing the caches. Zero console errors is asserted throughout.
const { chromium } = require("playwright");
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");
const { account } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CVX = process.env.E2E_CONVEX_URL || `${BASE}/__cvx`;
const { email: EMAIL, password: PASSWORD } = account();
const results = [];
/**
 * A valid 1x1 PNG whose colour depends on `seed`. Sent chat attachments now
 * stay in the File Library, so identical bytes would (correctly) ask "You
 * already have this file" on every later run — each run needs its own bytes.
 */
function uniquePng(seed) {
  const zlib = require("node:zlib");
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const h = [...String(seed)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const pixel = Buffer.from([0, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(pixel)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const consoleErrors = [];

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: String(e.message || e) });
    console.log(`FAIL  ${name} — ${String(e.message || e).slice(0, 300)}`);
  }
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });
  const stamp = Date.now().toString(36);

  await step("password sign-in lands in the app", async () => {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/chat/, { timeout: 30000 });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    return page.url();
  });

  await step("chat: .txt + .xml attachments upload, register, and the reply streams", async () => {
    // Attached the instant the composer renders, before the workspace has
    // resolved — the case that used to drop files silently (no chip, no upload
    // mutation). They must now queue and upload once it resolves.
    const input = page.locator('input[type="file"]').first();
    await input.setInputFiles([
      { name: `note-${stamp}.txt`, mimeType: "text/plain", buffer: Buffer.from(`remediation check ${stamp}`) },
      {
        name: `feed-${stamp}.xml`,
        mimeType: "text/xml",
        buffer: Buffer.from(`<?xml version="1.0"?><root><item>ok ${stamp}</item></root>`),
      },
      // An image renders with its storage URL, so the header check below sees
      // a real stored blob as the browser receives it.
      { name: `dot-${stamp}.png`, mimeType: "image/png", buffer: uniquePng(stamp) },
    ]);
    // Both chips must reach "ready": no "Couldn't upload" toast.
    await page.waitForTimeout(6000);
    const failed = await page.getByText(/Couldn't upload/i).count();
    if (failed) throw new Error("an attachment failed to upload");
    await page.locator("#chat-composer").fill("Reply with exactly the word: PONG");
    await page.keyboard.press("Enter");
    const stop = page.getByRole("button", { name: "Stop generating" });
    await stop.waitFor({ state: "detached", timeout: 120000 }).catch(() => {});
    await page.waitForFunction(() => /PONG/.test(document.body.innerText), null, {
      timeout: 120000,
    });
    return "PONG received";
  });

  await step("stored blobs reach the browser inert (edge headers on /api/storage)", async () => {
    // The bubble does not render raw storage links, so take this thread's
    // attachment URLs from the API as the user (their own JWT cookie).
    const jwt = (await ctx.cookies()).find((c) => /convexAuthJWT/i.test(c.name))?.value;
    if (!jwt) throw new Error("no session to read attachments with");
    const q = (path, args) =>
      fetch(`${CVX}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ path, args, format: "json" }),
      }).then((r) => r.json());
    // The URL can commit /chat/<id> after the segment swaps; the newest thread
    // is the one just sent either way.
    let threadId = /\/chat\/([a-z0-9]+)/.exec(page.url())?.[1];
    if (!threadId) {
      const ws = (await q("orgs:myWorkspaces", {})).value[0]._id;
      threadId = (
        await q("chat/threads:list", { workspaceId: ws, paginationOpts: { numItems: 1, cursor: null } })
      ).value.page[0]._id;
    }
    const res = await q("chat/attachments:listForThread", { threadId });
    const hrefs = (res.value || []).map((a) => a.url).filter(Boolean);
    if (hrefs.length < 3) throw new Error(`expected 3 bound attachments, got ${hrefs.length}`);
    const out = [];
    for (const u of hrefs.slice(0, 3)) {
      const r = await page.request.get(new URL(u, BASE).toString());
      const h = r.headers();
      if (h["x-content-type-options"] !== "nosniff") throw new Error(`no nosniff on ${u}`);
      const ct = (h["content-type"] || "").split(";")[0];
      if (/xml|html|svg/.test(ct)) throw new Error(`stored as executable type ${ct}`);
      out.push(`${ct} ${h["content-disposition"] || "inline"} ${h["content-security-policy"] || "-"}`);
    }
    return out.join(" | ");
  });

  // Settings → Files is now the File Library; a non-processable upload goes
  // through library.beginUpload / finishUpload and is kept as-is.
  await step("Library: a non-processable upload is kept (library.finishUpload)", async () => {
    await page.goto(`${BASE}/en/library`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000); // same workspace resolution as the composer
    const name = `stored-${stamp}.bin`;
    await page
      .locator('input[type="file"]')
      .first()
      // Unique bytes: identical bytes ask "You already have this file" first.
      .setInputFiles({ name, mimeType: "application/octet-stream", buffer: Buffer.from(`stored ${name}`) });
    const ok = page.getByText(`Added ${name}`);
    const bad = page.getByText("Upload failed");
    await Promise.race([
      ok.first().waitFor({ timeout: 30000 }),
      bad.first().waitFor({ timeout: 30000 }).then(() => {
        throw new Error("the page reported: Upload failed");
      }),
    ]);
    return `toast: Added ${name}`;
  });

  await step("display caches are owner-bound envelopes", async () => {
    await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    await page.waitForTimeout(3000);
    const raw = await page.evaluate(() => localStorage.getItem("user"));
    if (!raw) throw new Error("no user cache written");
    const env = JSON.parse(raw);
    if (!env.owner || typeof env.at !== "number" || !("v" in env)) {
      throw new Error(`cache is not an owner envelope: ${raw.slice(0, 80)}`);
    }
    return `owner=${env.owner.slice(0, 8)}…`;
  });

  await step("an unsolicited ?code= link does not sign the user out (F-14)", async () => {
    await page.goto(`${BASE}/en/chat?code=unsolicited-${stamp}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    if (/login/.test(page.url())) throw new Error(`bounced to ${page.url()}`);
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    return page.url();
  });

  await step("an anonymous reset request for this account does not end the session (F-06)", async () => {
    const anon = new ConvexHttpClient(CVX);
    await anon.action(anyApi.authSessions.requestPasswordReset, { email: EMAIL });
    await page.waitForTimeout(4000); // the reset send runs off the request path
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    if (/login/.test(page.url())) throw new Error("signed out by someone else's reset request");
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    return "still signed in";
  });

  await step("log out clears the display caches", async () => {
    await page.getByRole("button", { name: "Account menu" }).first().click();
    await page.getByRole("button", { name: "Log out" }).click();
    // Log-out swaps in the sign-in form without committing a /login URL (the
    // App Router follows the middleware redirect for data only).
    await page.locator('input[type="password"]').first().waitFor({ timeout: 20000 });
    const left = await page.evaluate(() =>
      ["user", "chat:threads", "chat:transcript"].filter((k) => localStorage.getItem(k)),
    );
    if (left.length) throw new Error(`still cached: ${left.join(", ")}`);
    return "caches empty";
  });

  await step("zero console errors across the whole session", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 5).join(" || "));
    return "0";
  });

  await browser.close();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== SECURITY REMEDIATION PROD: ${pass}/${results.length} ===`);
  process.exit(pass === results.length ? 0 : 1);
})();
