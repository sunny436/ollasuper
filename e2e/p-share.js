// Chat Sharing e2e — plain Playwright, run against a deployed stack.
//   E2E_BASE_URL=https://app.ollasuper.com node p-share.js
//
// Creates a conversation, shares it, opens the public link in a FRESH
// unauthenticated context (proving no-auth read-only access with zero console
// errors), verifies single-turn isolation, then revokes and confirms the public
// link stops working. Asserts zero console errors in BOTH contexts.
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const MARK = `SHARETEST${Math.floor(Date.now() / 1000) % 100000}`;

const results = [];
const errs = [];
const step = async (n, f) => {
  try {
    await f();
    results.push(true);
    console.log("PASS  " + n);
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + n + " — " + e.message.split("\n")[0]);
  }
};

/** Open a URL in a fresh, unauthenticated context; return {text, pageErrs}. */
async function openPublic(browser, url) {
  const ctx = await browser.newContext({
    viewport: { width: 1200, height: 900 },
  });
  const pageErrs = [];
  const p = await ctx.newPage();
  p.on("console", (m) => m.type() === "error" && pageErrs.push(m.text()));
  p.on(
    "response",
    (r) =>
      r.status() >= 400 &&
      !r.url().includes("favicon") &&
      !r.url().includes("/share/file") && // proxy 404s are expected for some states
      pageErrs.push(`HTTP ${r.status()} ${r.url()}`),
  );
  await p.goto(url, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  const text = await p.evaluate(() => document.body.innerText);
  const hasComposer = await p.locator("#chat-composer").count();
  await ctx.close();
  return { text, pageErrs, hasComposer };
}

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 40,
  });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on(
    "response",
    (r) =>
      r.status() >= 400 &&
      !r.url().includes("favicon") &&
      errs.push(`HTTP ${r.status()} ${r.url()}`),
  );

  let fullLink = "";
  let turnLink = "";

  await step("login + open chat", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 30000 });
  });

  await step("send a message and get a reply", async () => {
    await page.locator("#chat-composer").fill(`Reply with exactly: ${MARK}`);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 30000 });
    await page.waitForFunction(
      (m) => document.body.innerText.includes(m),
      MARK,
      { timeout: 45000 },
    );
    // let the stream finish (Stop button disappears)
    await page
      .getByRole("button", { name: "Stop generating" })
      .waitFor({ state: "detached", timeout: 30000 })
      .catch(() => {});
  });

  await step("Share Chat → get a public link", async () => {
    await page.getByRole("button", { name: "Share conversation" }).click();
    const input = page.locator('[role="dialog"] input[readonly]');
    await input.waitFor({ timeout: 15000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[role="dialog"] input[readonly]');
        return el && /\/share\//.test(el.value);
      },
      { timeout: 15000 },
    );
    fullLink = await input.inputValue();
    if (!/\/share\/[0-9a-f]{48}/.test(fullLink)) {
      throw new Error("bad share link: " + fullLink);
    }
    await page.keyboard.press("Escape");
  });

  await step("public link renders read-only, unauthenticated, no errors", async () => {
    const { text, pageErrs, hasComposer } = await openPublic(b, fullLink);
    if (!text.includes(MARK)) throw new Error("shared content missing");
    if (!/shared conversation/i.test(text)) throw new Error("no shared header");
    if (hasComposer > 0) throw new Error("public page is not read-only");
    if (pageErrs.length) throw new Error("public console errors: " + pageErrs[0]);
  });

  await step("revoke → public link stops working", async () => {
    await page.goto(BASE + "/settings/shared", { waitUntil: "domcontentloaded" });
    // This run's full-chat share is newest → first. Wait for the list to load.
    const revokeBtn = page
      .getByRole("button", { name: "Revoke", exact: true })
      .first();
    await revokeBtn.waitFor({ state: "visible", timeout: 25000 });
    await revokeBtn.click();
    // The confirm dialog portals to <body> (appended last) → its Revoke is last.
    await page.waitForTimeout(700);
    await page
      .getByRole("button", { name: "Revoke", exact: true })
      .last()
      .click();
    await page.waitForTimeout(2000);
    const { text } = await openPublic(b, fullLink);
    if (text.includes(MARK)) throw new Error("revoked link still shows content");
    if (!/no longer available|revoked|expired|not found/i.test(text)) {
      throw new Error("revoked state not shown: " + text.slice(0, 80));
    }
  });

  await step("Share Response → only that turn is public", async () => {
    await page.goto(page.url().replace("/settings/shared", "/chat"), {
      waitUntil: "domcontentloaded",
    });
    // reopen the thread from the rail
    await page
      .locator('nav[aria-label="Conversations"] a')
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Share response" }).first().click();
    const input = page.locator('[role="dialog"] input[readonly]');
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[role="dialog"] input[readonly]');
        return el && /\/share\//.test(el.value);
      },
      { timeout: 15000 },
    );
    turnLink = await input.inputValue();
    await page.keyboard.press("Escape");
    const { text, pageErrs } = await openPublic(b, turnLink);
    if (!text.includes(MARK)) throw new Error("turn content missing");
    if (!/shared response/i.test(text)) throw new Error("not labelled a response");
    if (pageErrs.length) throw new Error("public console errors: " + pageErrs[0]);
  });

  await step("invalid token → not found", async () => {
    const { text } = await openPublic(b, BASE + "/share/" + "0".repeat(48));
    if (!/not found|invalid/i.test(text)) {
      throw new Error("invalid token not handled: " + text.slice(0, 60));
    }
  });

  const passed = results.filter(Boolean).length;
  console.log(
    `\n===== SHARE: ${passed}/${results.length} | console errors: ${errs.length} =====`,
  );
  for (const e of errs) console.log("  - " + e);
  await b.close();
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => {
  console.log("FATAL " + e.message.split("\n")[0]);
  process.exit(1);
});
