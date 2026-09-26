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
    const input = page.locator('input[type="file"]').first();
    await input.setInputFiles([
      { name: `note-${stamp}.txt`, mimeType: "text/plain", buffer: Buffer.from("remediation check") },
      {
        name: `feed-${stamp}.xml`,
        mimeType: "text/xml",
        buffer: Buffer.from('<?xml version="1.0"?><root><item>ok</item></root>'),
      },
      // An image renders with its storage URL, so the header check below sees
      // a real stored blob as the browser receives it.
      { name: `dot-${stamp}.png`, mimeType: "image/png", buffer: PNG_1PX },
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
    const hrefs = await page
      .locator('a[href*="/api/storage/"], img[src*="/api/storage/"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("href") || e.getAttribute("src")));
    if (!hrefs.length) throw new Error("no storage URL rendered for the attachments");
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

  await step("Files page: a non-knowledge upload registers (files.saveFile)", async () => {
    await page.goto(`${BASE}/en/settings/files`, { waitUntil: "domcontentloaded" });
    const name = `stored-${stamp}.bin`;
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name, mimeType: "application/octet-stream", buffer: Buffer.from([1, 2, 3]) });
    const ok = page.getByText(`Uploaded ${name}`);
    const bad = page.getByText("Upload failed");
    await Promise.race([
      ok.first().waitFor({ timeout: 30000 }),
      bad.first().waitFor({ timeout: 30000 }).then(() => {
        throw new Error("the page reported: Upload failed");
      }),
    ]);
    return `toast: Uploaded ${name}`;
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
