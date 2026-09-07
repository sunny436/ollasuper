// Chat archive, end to end against the deployed stack.
//
//   E2E_BASE_URL=https://app.ollasuper.com node qa-chat-archive.js
//
// Walks the whole lifecycle a user actually performs:
//   active -> archive -> gone from sidebar -> survives reload
//          -> present in Settings > Archived Chats -> opens with messages intact
//          -> restore -> back in the sidebar
//          -> archive again -> delete from Archived Chats
//
// The backend for all of this already existed; what was missing was the menu
// item, so these steps are the first time the path is exercised as a user.
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();

const errs = [];
const results = [];
const notes = [];

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

const generating = async (page) =>
  (await page.getByRole("button", { name: "Stop generating" }).count()) > 0;

async function settle(page, ms = 240000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await generating(page))) return;
    await page.waitForTimeout(500);
  }
  throw new Error("generation never finished");
}

/** The sidebar row for a conversation, by its visible title. */
const row = (page, title) =>
  page.locator("aside, nav").getByText(title, { exact: false }).first();

/** Open the ⋯ menu on the row carrying `title`. */
async function openRowMenu(page, title) {
  const link = page.getByRole("link", { name: new RegExp(title, "i") }).first();
  await link.hover();
  const container = link.locator("xpath=..");
  const trigger = container.getByRole("button", { name: "Conversation actions" });
  await trigger.click();
  await page.waitForTimeout(300);
}

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 45,
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) {
      errs.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });

  const MARKER = `archivetest${Date.now().toString().slice(-6)}`;
  const PROBE = `zeppelin${Date.now().toString().slice(-6)}`;

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
  });

  await step("create a conversation to archive", async () => {
    await page
      .locator("#chat-composer")
      .fill(`Reply with exactly: ${MARKER} ${PROBE}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    await settle(page);
    await page.waitForTimeout(2500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    await page.waitForTimeout(2000);
  });

  let title = "";
  await step("the conversation is in the active sidebar", async () => {
    // The title is auto-generated, so discover it from the sidebar rather than
    // assuming one.
    const links = page.getByRole("link");
    const n = await links.count();
    for (let i = 0; i < n; i++) {
      const href = await links.nth(i).getAttribute("href");
      if (href?.includes("/chat/")) {
        const text = (await links.nth(i).innerText()).trim();
        if (text) {
          title = text;
          break;
        }
      }
    }
    if (!title) throw new Error("no conversation row found in the sidebar");
    notes.push(`conversation title: ${JSON.stringify(title)}`);
  });

  await step("Archive appears in the conversation menu", async () => {
    await openRowMenu(page, title);
    const archive = page.getByText("Archive", { exact: true });
    if ((await archive.count()) === 0) throw new Error("no Archive menu item");
    // The existing actions must survive.
    for (const label of ["Rename", "Delete"]) {
      if ((await page.getByText(label, { exact: true }).count()) === 0) {
        throw new Error(`${label} disappeared from the menu`);
      }
    }
  });

  await step("archiving removes it from the sidebar", async () => {
    await page.getByText("Archive", { exact: true }).first().click();
    await page.waitForTimeout(2500);
    const stillThere = await page
      .getByRole("link", { name: new RegExp(title, "i") })
      .count();
    if (stillThere > 0) throw new Error("still listed in the sidebar");
  });

  await step("no confirmation dialog was required", async () => {
    // Archive is reversible; §13 says do not add friction.
    if ((await page.getByRole("dialog").count()) > 0) {
      throw new Error("an unexpected dialog appeared");
    }
  });

  await step("it stays archived across a reload", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    await page.waitForTimeout(2500);
    const back = await page
      .getByRole("link", { name: new RegExp(title, "i") })
      .count();
    if (back > 0) throw new Error("reappeared after reload — state not persisted");
  });

  await step("it appears under Settings → Archived Chats", async () => {
    await page.goto(BASE + "/en/settings/archived", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(2500);
    const body = await page.evaluate(() => document.body.innerText || "");
    if (!body.includes(title.slice(0, 20))) {
      throw new Error("not listed in Archived Chats");
    }
  });

  await step("an archived chat opens from Settings with messages intact", async () => {
    // And opening it must NOT unarchive it — the user is reading it to decide
    // whether to restore or delete, not committing to either.
    await page.getByText(title.slice(0, 20), { exact: false }).first().click();
    await page.waitForURL(/\/chat\//, { timeout: 15000 });
    await page.waitForTimeout(2500);
    const body = await page.evaluate(() => document.body.innerText || "");
    if (!body.includes(MARKER)) {
      throw new Error("the conversation's messages did not render");
    }

    // Still archived: absent from the sidebar, still listed under Settings.
    await page.goto(BASE + "/en/settings/archived", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(2500);
    const archivedBody = await page.evaluate(
      () => document.body.innerText || "",
    );
    if (!archivedBody.includes(title.slice(0, 20))) {
      throw new Error("opening it silently unarchived the conversation");
    }
  });

  await step("restoring returns it to the active sidebar", async () => {
    await page.getByText("Restore", { exact: true }).first().click();
    await page.waitForTimeout(2000);
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    await page.waitForTimeout(2500);
    const back = await page
      .getByRole("link", { name: new RegExp(title, "i") })
      .count();
    if (back === 0) throw new Error("did not return to the sidebar");
  });

  await step("an archived chat can be deleted from Archived Chats", async () => {
    await openRowMenu(page, title);
    await page.getByText("Archive", { exact: true }).first().click();
    await page.waitForTimeout(2000);
    await page.goto(BASE + "/en/settings/archived", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(2500);
    // ConfirmButton renders a trigger AND a dialog button, both "Delete" —
    // target the dialog explicitly rather than guessing by index.
    await page.getByText("Delete", { exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 8000 });
    await dialog.getByRole("button", { name: "Delete" }).click();
    await page.waitForTimeout(2500);
    const body = await page.evaluate(() => document.body.innerText || "");
    if (body.includes(title.slice(0, 20))) {
      throw new Error("still listed after delete");
    }
  });

  await step("mobile: Archive is reachable at 390px", async () => {
    // Below `md` the conversation list is a DRAWER that starts closed, so it
    // has to be opened first — the same is true of Pin/Rename/Delete, and an
    // earlier version of this step failed here by asserting against a closed
    // drawer and blaming the product for it.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    await page.waitForTimeout(2000);

    await page.getByRole("button", { name: "Open conversations" }).click();
    await page.waitForTimeout(1200);

    const link = page
      .getByRole("link")
      .filter({ hasText: /./ })
      .first();
    const trigger = page
      .getByRole("button", { name: "Conversation actions" })
      .first();
    if ((await trigger.count()) === 0) {
      throw new Error("no conversation menu inside the mobile drawer");
    }
    await trigger.click();
    await page.waitForTimeout(400);
    void link;

    const labels = ["Archive", "Rename", "Delete"];
    for (const label of labels) {
      if ((await page.getByText(label, { exact: true }).count()) === 0) {
        throw new Error(`${label} missing from the mobile menu`);
      }
    }
    notes.push("mobile drawer menu offers Archive alongside Rename/Delete");
  });

  await step("zero console errors", async () => {
    if (errs.length) throw new Error(errs.slice(0, 4).join(" | "));
  });

  await b.close();
  for (const n of notes) console.log("      " + n);
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
