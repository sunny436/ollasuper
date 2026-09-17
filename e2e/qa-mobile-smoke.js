// qa-mobile-smoke.js — the mobile fixes, exercised end to end on the deployed app.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-mobile-smoke.js
//
// Per profile (Pixel 7 touch, desktop 1440), headed Chrome:
//   upload an image + PDF + text file from the composer; the chips fit the viewport;
//   the reply answers from the text file (a phrase only that file contains); the new
//   chat composer is wide enough to type in; message actions are visible on touch and
//   hover-revealed on desktop; no backdrop-filter on touch, glass kept on desktop;
//   Share returns focus; the offline line appears and clears; zero console errors.
const { chromium, devices } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const OUT = path.join(__dirname, "out", "mobile-smoke");
fs.mkdirSync(OUT, { recursive: true });

function fixtures() {
  const token = `amber-otter-${Date.now() % 100000}`;
  const txt = path.join(OUT, "smoke-notes-with-a-long-file-name-for-the-attachment-chip.txt");
  fs.writeFileSync(txt, `Internal note.\nThe release passphrase is ${token}.\n`);
  const png = path.join(OUT, "smoke-image.png");
  fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  const pdf = path.join(OUT, "smoke.pdf");
  fs.writeFileSync(pdf, "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  return { token, files: [png, pdf, txt] };
}

async function runProfile(browser, name, opts) {
  const results = [];
  const check = (label, ok, detail = "") => {
    results.push({ label, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(12)} ${label}${detail ? ` — ${detail}` : ""}`);
  };
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 160)));
  page.on("pageerror", (e) => errs.push(`pageerror ${e.message}`));
  await page.goto(`${BASE}/login`, { waitUntil: "load" });
  await page.waitForTimeout(4000);
  await page.locator('input[type="email"]').first().fill(process.env.QA_EMAIL);
  await page.locator('input[type="password"]').first().fill(process.env.QA_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 90000, waitUntil: "commit" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 60000 });
  await page.waitForTimeout(2000);
  const touch = !!opts.hasTouch;

  const layout = await page.evaluate(() => ({
    composerW: Math.round(document.querySelector("#chat-composer").getBoundingClientRect().width),
    vw: innerWidth,
    backdrop: [...document.querySelectorAll("*")].filter((e) => { const s = getComputedStyle(e); return (s.backdropFilter && s.backdropFilter !== "none") || (s.webkitBackdropFilter && s.webkitBackdropFilter !== "none"); }).length,
  }));
  check("new-chat composer wide enough to type in", layout.composerW >= Math.min(220, layout.vw * 0.55), `${layout.composerW}px of ${layout.vw}px`);
  check(touch ? "no backdrop-filter on touch" : "glass kept on desktop", touch ? layout.backdrop === 0 : layout.backdrop > 0, `${layout.backdrop} elements`);

  // Upload three files from the composer.
  const { token, files } = fixtures();
  await page.locator('input[type="file"]').first().setInputFiles(files);
  const chipsReady = await page.waitForFunction((names) => names.every((n) => document.body.innerText.includes(n.slice(0, 18))), files.map((f) => path.basename(f)), { timeout: 60000 }).then(() => true).catch(() => false);
  check("attachment chips appear", chipsReady);
  const chips = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const els = [...document.querySelectorAll('button[aria-label^="Remove "]')].map((b) => b.closest("div") || b);
    return { n: els.length, outside: els.filter((e) => { const r = e.getBoundingClientRect(); return r.right > vw + 1 || r.left < -1; }).length };
  });
  check("chips inside the viewport", chips.n >= 3 && chips.outside === 0, `${chips.n} chips, ${chips.outside} outside`);
  const uploaded = await page.waitForFunction(() => !document.querySelector('button[aria-label="Send message"][disabled]'), null, { timeout: 90000 }).then(() => true).catch(() => false);
  check("uploads finish (send enabled)", uploaded);
  await page.locator("#chat-composer").fill("What is the release passphrase in the attached text file? Reply with just the passphrase.");
  await page.getByRole("button", { name: "Send message" }).click();
  const stop = page.getByRole("button", { name: "Stop generating" });
  await page.waitForTimeout(3000);
  const t = Date.now();
  while (Date.now() - t < 180000) {
    await page.waitForTimeout(700);
    if ((await stop.count()) === 0) break;
  }
  await page.waitForTimeout(2000);
  const answer = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    return rows[rows.length - 1]?.querySelector("[aria-live]")?.innerText || "";
  });
  check("reply answers from the uploaded text file", answer.toLowerCase().includes(token), JSON.stringify(answer.slice(0, 80)));
  await page.screenshot({ path: path.join(OUT, `${name}-after-upload.png`) });

  // Message actions: visible on touch, hover-revealed on desktop.
  const actionOpacity = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button[aria-label="Copy response"]')].pop();
    if (!b) return null;
    let o = 1;
    for (let n = b; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    const r = b.getBoundingClientRect();
    return { o: Math.round(o * 100) / 100, w: Math.round(r.width), h: Math.round(r.height) };
  });
  check(touch ? "message actions visible and >=44px on touch" : "message actions hover-revealed on desktop",
    touch ? actionOpacity?.o === 1 && actionOpacity.w >= 44 && actionOpacity.h >= 44 : actionOpacity?.o === 0, JSON.stringify(actionOpacity));

  // Share returns focus.
  const share = page.getByRole("button", { name: "Share conversation" });
  if (await share.count()) {
    await share.focus();
    await share.click();
    await page.waitForTimeout(1200);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    check("focus returns to Share after the dialog closes", await share.evaluate((el) => el === document.activeElement));
  }

  // Offline line.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await page.waitForTimeout(2500);
  const shown = await page.getByText("You're offline", { exact: false }).isVisible().catch(() => false);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.waitForTimeout(8000);
  const cleared = !(await page.getByText("You're offline", { exact: false }).isVisible().catch(() => false)) && !(await page.getByText("Reconnecting", { exact: false }).isVisible().catch(() => false));
  check("offline line appears and clears on reconnect", shown && cleared, `shown=${shown} cleared=${cleared}`);

  const benign = errs.filter((e) => !/favicon|ERR_INTERNET_DISCONNECTED/.test(e));
  check("zero console errors", benign.length === 0, benign.slice(0, 2).join(" | "));
  await ctx.close();
  return results;
}

(async () => {
  if (!process.env.QA_EMAIL || !process.env.QA_PASSWORD) throw new Error("QA_EMAIL and QA_PASSWORD must be set");
  const browser = await chromium.launch({ headless: false });
  const all = [
    ...(await runProfile(browser, "phone", { ...devices["Pixel 7"] })),
    ...(await runProfile(browser, "desktop", { viewport: { width: 1440, height: 900 } })),
  ];
  await browser.close();
  const passed = all.filter((r) => r.ok).length;
  console.log(`\n${passed}/${all.length} checks passed`);
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(all, null, 2));
  process.exit(passed === all.length ? 0 : 1);
})().catch((e) => {
  console.error("ERR", e.stack);
  process.exit(2);
});
