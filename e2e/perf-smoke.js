// Functional smoke for the Phase 1 latency changes, on the QA account, headed
// Chrome, zero console errors. Covers what p-chat.js does not: regenerate,
// edit, an attachment send, a Project chat's first message (createAndSend with
// projectId), Explore/Skills, reload, log out and log in again.
//
//   QA_EMAIL=… QA_PASSWORD=… node perf-smoke.js
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const { email: EMAIL, password: PASSWORD } = require("./creds").account();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
const step = async (name, fn) => {
  try {
    const note = await fn();
    results.push([name, true]);
    console.log(`PASS  ${name}${note ? `\n      ↳ ${note}` : ""}`);
  } catch (e) {
    results.push([name, false]);
    console.log(`FAIL  ${name}\n      ↳ ${String(e).slice(0, 300)}`);
  }
};
const ROW = '[aria-label="Conversation"] .group.my-5';

async function settle(page, timeout = 240000) {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await stop.count()) === 0) return true;
    await sleep(200);
  }
  return false;
}
async function lastAssistantText(page) {
  return page.evaluate((sel) => {
    const rows = [...document.querySelectorAll(sel)].filter((r) => !r.classList.contains("items-end"));
    return rows.length ? rows[rows.length - 1].innerText.trim() : "";
  }, ROW);
}
async function rowCount(page) {
  return page.locator(ROW).count();
}
async function login(page) {
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
}
async function sendAndSettle(page, text) {
  await page.locator("#chat-composer").fill(text);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 60000 });
  if (!(await settle(page))) throw new Error("generation did not finish");
}

(async () => {
  const b = await chromium.launch({ headless: false });
  const ctx = await b.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  const created = [];

  await step("login", () => login(page));

  await step("new chat: first message via createAndSend, reply streams", async () => {
    await page.getByRole("button", { name: "New chat" }).click();
    await page.waitForURL(/\/chat\/?$/, { timeout: 15000 }).catch(() => {});
    await sendAndSettle(page, "Reply with exactly the word: ALPHA");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 10000 });
    created.push(new URL(page.url()).pathname);
    const t = await lastAssistantText(page);
    if (!/ALPHA/i.test(t)) throw new Error(`unexpected reply: ${t.slice(0, 80)}`);
    return `thread ${created[0]}`;
  });

  await step("regenerate the reply", async () => {
    const before = await rowCount(page);
    const lastAssistant = page.locator(ROW).filter({ hasNot: page.locator(".items-end") }).last();
    await lastAssistant.hover();
    await page.getByRole("button", { name: "Regenerate" }).last().click();
    await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 60000 });
    if (!(await settle(page))) throw new Error("regenerate did not finish");
    const after = await rowCount(page);
    const t = await lastAssistantText(page);
    if (!t) throw new Error("no regenerated text");
    return `rows ${before} → ${after}, reply "${t.slice(0, 40)}"`;
  });

  await step("edit the user message (truncate + resend)", async () => {
    page.once("dialog", (d) => d.accept("Reply with exactly the word: BRAVO"));
    const userRow = page.locator(`${ROW}.items-end`).first();
    await userRow.hover();
    await page.getByRole("button", { name: "Edit message" }).first().click();
    await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 60000 });
    if (!(await settle(page))) throw new Error("edit resend did not finish");
    const t = await lastAssistantText(page);
    if (!/BRAVO/i.test(t)) throw new Error(`unexpected reply after edit: ${t.slice(0, 80)}`);
  });

  await step("send with an attachment", async () => {
    const f = path.join(os.tmpdir(), "perf-smoke-note.txt");
    fs.writeFileSync(f, "The secret code word in this file is CHARLIE.\n");
    await page.locator('input[type="file"]').first().setInputFiles(f);
    await sleep(1500);
    await sendAndSettle(page, "What is the code word in the attached file? Reply with just the word.");
    fs.unlinkSync(f);
    const t = await lastAssistantText(page);
    if (!/CHARLIE/i.test(t)) throw new Error(`attachment not read: ${t.slice(0, 80)}`);
  });

  await step("reload restores the conversation", async () => {
    const before = await rowCount(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
    await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length >= n, [ROW, before], { timeout: 30000 });
    return `${before} rows back`;
  });

  await step("Explore → Skills opens (landing screen only)", async () => {
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByRole("button", { name: "Skills" }).first().waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Skills" }).first().click();
    await sleep(1200);
    const items = await page.getByRole("menuitem").count().catch(() => 0);
    await page.keyboard.press("Escape");
    return `${items} entries`;
  });

  await step("project chat: create a project, first message via createAndSend(projectId)", async () => {
    await page.goto(BASE + "/projects", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /^New$/ }).first().waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: /^New$/ }).first().click();
    const name = `Perf smoke ${Date.now().toString(36)}`;
    await page.getByLabel("Project name").fill(name);
    await page.getByRole("button", { name: "Create project" }).click();
    const composer = page.getByPlaceholder(/^New chat in /);
    await composer.waitFor({ timeout: 20000 });
    await composer.fill("Reply with exactly the word: DELTA");
    await page.keyboard.press("Enter");
    // The Project page hands the draft to /chat?project=<id>; the chat
    // composer is prefilled and focused, and the user sends from there.
    await page.waitForURL(/\/chat\?project=/, { timeout: 30000 });
    await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });
    await page.waitForFunction(
      () => /DELTA/.test(document.querySelector("#chat-composer")?.value ?? ""),
      null,
      { timeout: 15000 },
    );
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 30000 });
    created.push(new URL(page.url()).pathname);
    await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 60000 });
    if (!(await settle(page))) throw new Error("project chat did not finish");
    const t = await lastAssistantText(page);
    if (!/DELTA/i.test(t)) throw new Error(`unexpected reply: ${t.slice(0, 80)}`);
    // the thread must be linked to the project: the pane shows the project name
    const linked = await page.getByText(name, { exact: false }).count();
    if (!linked) throw new Error("project name not shown on the thread page");
    return name;
  });

  await step("log out → /login; log in again", async () => {
    await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("button", { name: /Log out/ }).click();
    // signOut renders the login form in place: the middleware's redirect on
    // the action POST is followed for data and the URL is not committed. This
    // is the unauthenticated branch, untouched by the Phase 1 change.
    await page.locator('input[type="email"]').first().waitFor({ timeout: 30000 });
    if ((await page.locator("#chat-composer").count()) !== 0) {
      throw new Error("composer still present after log out");
    }
    // the app must not still be usable: a fresh navigation is bounced
    await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/login/, { timeout: 30000 });
    await login(page);
  });

  await step("cleanup: delete the chats this run created", async () => {
    let n = 0;
    for (const href of created) {
      const link = page.locator(`a[href="${href}"]`).first();
      if ((await link.count()) === 0) continue;
      await link.hover();
      await link.locator("xpath=..").getByRole("button", { name: "Conversation actions" }).click();
      page.once("dialog", (d) => d.accept());
      await page.getByRole("button", { name: "Delete" }).click();
      await sleep(400);
      n++;
    }
    return `${n}/${created.length} deleted`;
  });

  await b.close();
  const ok = results.filter((r) => r[1]).length;
  console.log(`\n===== PERF SMOKE: ${ok}/${results.length} | console errors: ${errors.length} =====`);
  for (const e of errors.slice(0, 10)) console.log("  console.error:", e);
  process.exit(ok === results.length && errors.length === 0 ? 0 : 1);
})();
