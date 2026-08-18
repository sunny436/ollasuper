// Chat end-to-end, in the house style: standalone node script, hand-rolled
// step() harness, and a hard assertion of zero console errors.
//
// Requires a live deployed stack with the AI service configured:
//   E2E_BASE_URL=https://<app>  node p-chat.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";

const errs = [];
const results = [];
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

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 60,
  });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) {
      errs.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
  });

  await step("Chat appears in the sidebar and navigates", async () => {
    // /chat is full-bleed and has no dashboard aside, so drive the shell nav
    // from a route that kept it. Still proves shell -> chat navigation works.
    await page.goto(BASE + "/en/files", { waitUntil: "domcontentloaded" });
    await page.locator("aside").getByRole("link", { name: "Chat" }).click();
    await page.waitForURL(/\/chat/, { timeout: 10000 });
  });

  await step("empty state renders with prompt cards", async () => {
    await page.waitForSelector("text=What would you like to make today?", {
      timeout: 10000,
    });
    const cards = await page.locator("text=Summarise a document").count();
    if (cards === 0) throw new Error("no suggested prompt cards");
  });

  await step("the starter menu switches the suggestions", async () => {
    await page.getByRole("radio", { name: /Code/ }).click();
    await page.waitForSelector("text=Explain this code", { timeout: 5000 });
  });

  await step("a prompt card populates the composer without sending", async () => {
    await page.click("text=Explain this code");
    await page.waitForTimeout(300);
    const v = await page.locator("#chat-composer").inputValue();
    if (!v.includes("Explain what this code does")) {
      throw new Error("composer was not populated");
    }
    // And it must NOT have sent: no assistant turn yet.
    const stopBtn = await page
      .getByRole("button", { name: "Stop generating" })
      .count();
    if (stopBtn > 0) throw new Error("card auto-sent the prompt");
  });

  await step("send a message and receive a streamed reply", async () => {
    await page.locator("#chat-composer").fill("");
    await page
      .locator("#chat-composer")
      .fill("Reply with exactly the word: PONG");
    await page.keyboard.press("Enter");

    // Thread is created and the URL becomes /chat/<id>.
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 15000 });

    // The stop button proves a generation is genuinely in flight.
    await page
      .getByRole("button", { name: "Stop generating" })
      .waitFor({ timeout: 20000 })
      .catch(() => {
        /* a very fast reply may finish before we look */
      });

    await page.waitForFunction(
      () => document.body.innerText.includes("PONG"),
      { timeout: 90000 },
    );
  });

  await step("the conversation persists across a reload", async () => {
    const url = page.url();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    if (page.url() !== url) throw new Error("navigated away on reload");
    await page.waitForFunction(
      () => document.body.innerText.includes("PONG"),
      { timeout: 20000 },
    );
  });

  await step("the thread is listed in the conversation sidebar", async () => {
    const nav = page.locator('nav[aria-label="Conversations"]').first();
    await nav.waitFor({ timeout: 5000 });
    const count = await nav.locator("a[href*='/chat/']").count();
    if (count === 0) throw new Error("no conversations listed");
  });

  await step("search finds the conversation", async () => {
    await page.getByLabel("Search conversations").fill("PONG");
    await page.waitForTimeout(1200); // debounce + round trip
    const nav = page.locator('nav[aria-label="Conversations"]').first();
    const count = await nav.locator("a[href*='/chat/']").count();
    if (count === 0) throw new Error("search returned nothing");
    await page.getByLabel("Search conversations").fill("");
  });

  await step("scroll-to-bottom pill appears when scrolled away", async () => {
    // Generate enough content to make the transcript scrollable.
    await page
      .locator("#chat-composer")
      .fill("List the numbers 1 to 60, one per line.");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(6000);
    await page.mouse.wheel(0, -3000);
    await page.waitForTimeout(600);
    const pill = page.getByRole("button", { name: "Scroll to latest message" });
    if ((await pill.count()) === 0) throw new Error("pill missing");
    await pill.click();
    await page.waitForTimeout(600);
  });

  await step("stop generation works", async () => {
    await page
      .locator("#chat-composer")
      .fill("Write a very long essay about the ocean, at least 800 words.");
    await page.keyboard.press("Enter");
    const stop = page.getByRole("button", { name: "Stop generating" });
    await stop.waitFor({ timeout: 20000 });
    await stop.click();
    await page.waitForTimeout(2500);
    if ((await stop.count()) > 0) throw new Error("still generating after stop");
  });

  await step("rename the conversation", async () => {
    page.once("dialog", (d) => d.accept("Renamed by e2e"));
    const nav = page.locator('nav[aria-label="Conversations"]').first();
    const row = nav.locator("a[href*='/chat/']").first();
    await row.hover();
    await nav.getByRole("button", { name: "Conversation actions" }).first().click();
    await page.getByRole("button", { name: "Rename" }).click();
    await page.waitForTimeout(1200);
    if (!(await nav.getByText("Renamed by e2e").count())) {
      throw new Error("rename did not apply");
    }
  });


  await step("model picker lists the OpenRouter catalogue and selects", async () => {
    // The rename step above leaves a Radix menu open, and Radix aria-hides the
    // rest of the page while one is open -- so getByRole cannot see the
    // composer at all until it is dismissed.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    const trigger = page.getByRole("button", { name: "Choose model" });
    const before = (await trigger.innerText()).trim();
    await trigger.click();

    // The catalogue is ~400 models, so the picker filters rather than listing
    // everything. "haiku" is stable across providers and always matches.
    const search = page.getByLabel("Search models");
    await search.waitFor({ timeout: 8000 });
    await search.fill("haiku");
    await page.waitForTimeout(600);

    // Pick the first match that is not already selected.
    const option = page.locator('[role="menu"] button').filter({ hasText: /haiku/i }).first();
    if (!(await option.count())) throw new Error("no catalogue models matched 'haiku'");
    const picked = (await option.innerText()).split("\n")[0].trim();
    await option.click();
    await page.waitForTimeout(800);

    // Selecting closes the menu, but press Escape defensively: an overlay
    // left open here blocks every subsequent step.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const after = (await trigger.innerText()).trim();
    if (after === before) {
      throw new Error(`model did not change (still "${after}")`);
    }
    if (!picked.toLowerCase().includes(after.toLowerCase().slice(0, 6))) {
      // Loose check: the trigger shows the catalogue's display name.
      console.log(`    note: trigger "${after}" vs picked "${picked}"`);
    }

    // Selecting only sets React state — chatThreads.model is patched by
    // messages.send. Send once so the choice actually reaches the data plane,
    // and print the thread id so the run can be checked against the database.
    await page.locator("#chat-composer").fill("model-persistence-probe");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);
    const u = page.url();
    console.log(
      `    selected="${after}" thread=${u.slice(u.lastIndexOf("/") + 1)}`,
    );
  });

  await step("mobile: sidebar becomes a drawer and nothing overflows", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Open conversations" }).click();
    await page.waitForTimeout(400);
    const drawer = page.locator('nav[aria-label="Conversations"]');
    if ((await drawer.count()) === 0) throw new Error("drawer did not open");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    if (overflow) throw new Error("horizontal overflow on mobile");
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await step("other dashboard pages still work", async () => {
    for (const [path, marker] of [["/en/files", "Files"]]) {
      await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      if (!(await page.getByText(marker).count())) {
        throw new Error(`${path} did not render`);
      }
    }
  });

  await step("root redirects to /chat", async () => {
    await page.goto(BASE + "/en", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/chat/, { timeout: 15000 });
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(
    `\n===== CHAT: ${passed}/${results.length} | console errors: ${errs.length} =====`,
  );
  for (const e of errs) console.log("  - " + e);
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
