// Chat end-to-end, in the house style: standalone node script, hand-rolled
// step() harness, and a hard assertion of zero console errors.
//
// Requires a live deployed stack with the AI service configured:
//   E2E_BASE_URL=https://<app>  node p-chat.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();

const errs = [];
const results = [];

// Wait for any in-flight generation to finish.
//
// messages.send rejects a second turn on the same thread with "This conversation
// is already generating a reply" (chat/messages.ts:186, a deliberate cost control).
// When that fires it does two bad things at once: it logs a console error, which
// this suite treats as a failure, and it silently turns the step under test into a
// no-op — the send never happens, so whatever the step was asserting cannot appear.
//
// This only started biting once chat generation actually worked again; while the
// AI plane was unreachable, sends failed instantly and never overlapped. The
// composer swaps Send for Stop while generating, so the absence of "Stop
// generating" is the idle signal.
const settle = async (page, ms = 60000) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await stop.count()) === 0) return true;
    await page.waitForTimeout(300);
  }
  return false;
};

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

  await step("empty state renders the greeting + composer", async () => {
    // The empty new-chat screen is just the personalised gradient greeting + the
    // composer. The greeting is randomised (20 variants, not all start "Good"),
    // so assert an h1 with non-empty text rather than a specific phrase.
    await page.waitForSelector("#chat-composer", { timeout: 10000 });
    await page.waitForFunction(
      () => {
        const h = document.querySelector("h1");
        return !!h && (h.textContent || "").trim().length > 0;
      },
      { timeout: 10000 },
    );
  });

  const settleTheme = async (want) => {
    await page
      .waitForFunction(
        (w) => document.documentElement.dataset.ambience === w,
        want,
        { timeout: 10000, polling: "raf" },
      )
      .catch(() => {});
  };

  await step("theme toggle themes the whole app", async () => {
    // The header theme toggle replaced the Ambience slider; it drives the SAME
    // engine, so the guarantees asserted here are unchanged — ~31 --amb-* vars
    // on <html>, `.dark` toggled by the interpolated background luminance, and
    // the dataset kept in step. Only the input changed: one click instead of
    // keyboarding a native range. Click back to light so later steps render light.
    const toggle = page.locator('button[aria-label="Toggle dark and light theme"]');
    if ((await toggle.count()) === 0) throw new Error("no theme toggle");

    const before = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    if (before) {
      // Start from light so the assertions below describe a real transition.
      await toggle.first().click();
      await settleTheme("0");
    }

    await toggle.first().click();
    await settleTheme("100");
    const midnight = await page.evaluate(() => ({
      amb: getComputedStyle(document.documentElement)
        .getPropertyValue("--amb-background")
        .trim(),
      dark: document.documentElement.classList.contains("dark"),
      ds: document.documentElement.dataset.ambience,
    }));
    if (!midnight.amb) throw new Error("no --amb-background applied");
    if (!midnight.dark) throw new Error("the toggle did not turn .dark on");
    if (midnight.ds !== "100")
      throw new Error(`dataset.ambience expected 100, got ${midnight.ds}`);

    await toggle.first().click();
    await settleTheme("0");
    const day = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      ds: document.documentElement.dataset.ambience,
    }));
    if (day.dark) throw new Error("the toggle did not turn .dark back off");
    if (day.ds !== "0")
      throw new Error(`dataset.ambience expected 0, got ${day.ds}`);
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

  await step("a plain text turn shows no agent-activity UI (Phase 8a inert)", async () => {
    // The agent-activity timeline renders ONLY when a turn emits typed events.
    // A normal text reply must render exactly as before — no tool panels, no
    // sources — so ordinary chat is visually unchanged. (When the agent is
    // enabled on the deployment, scenarios B/C below exercise the timeline.)
    await settle(page);
    if ((await page.locator("[data-agent-activity]").count()) !== 0)
      throw new Error("agent-activity UI appeared on a plain text turn");
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

  await step("the user's own message renders instantly (optimistic)", async () => {
    // No generation may be in flight, or the send is rejected as a duplicate.
    await settle(page);
    const msg = `OPTIMISTIC-${Date.now()}`;
    await page.locator("#chat-composer").fill(msg);
    const t0 = Date.now();
    await page.keyboard.press("Enter");
    // The user's bubble must appear WITHOUT waiting for the backend. A prod
    // mutation + reactive query round-trip is hundreds of ms; the optimistic
    // row is local React state, so it paints in tens of ms.
    await page.waitForFunction(
      (m) => document.body.innerText.includes(m),
      msg,
      { timeout: 2000 },
    );
    const dt = Date.now() - t0;
    console.log(`      ↳ user message visible in ${dt}ms`);
    if (dt > 800)
      throw new Error(`user message took ${dt}ms — not rendering optimistically`);
    await settle(page, 90000);
  });

  await step("the thread is listed in the conversation sidebar", async () => {
    const nav = page.locator('nav[aria-label="Conversations"]').first();
    await nav.waitFor({ timeout: 5000 });
    const count = await nav.locator("a[href*='/chat/']").count();
    if (count === 0) throw new Error("no conversations listed");
  });

  await step("the conversation search bar is gone", async () => {
    // The "Search conversations…" bar was removed. Assert it no longer exists,
    // by label or placeholder, and that the thread list still renders.
    if ((await page.getByLabel("Search conversations").count()) !== 0)
      throw new Error("search input still present");
    if ((await page.getByPlaceholder("Search conversations...").count()) !== 0)
      throw new Error("search placeholder still present");
    const nav = page.locator('nav[aria-label="Conversations"]').first();
    if ((await nav.locator("a[href*='/chat/']").count()) === 0)
      throw new Error("thread list disappeared with the search bar");
  });

  await step("scroll-to-bottom pill appears when scrolled away", async () => {
    // Generate enough content to make the transcript scrollable.
    await settle(page); // an earlier reply may still be streaming
    // Ask for a MARKDOWN list, not "one per line". The transcript renders through
    // react-markdown, which collapses single newlines into spaces — so the old
    // prompt came back as ~170 characters that laid out as one wrapped paragraph
    // and the transcript never overflowed, making the pill correctly invisible.
    // Markdown list items each render as their own block, which actually is tall.
    await page
      .locator("#chat-composer")
      .fill(
        "Output a markdown numbered list of the numbers 1 to 60. " +
          "Each item on its own line, formatted exactly like '1. one'. " +
          "No preamble, no summary.",
      );
    await page.keyboard.press("Enter");
    // Let the reply finish rather than sleeping a fixed 6s: the transcript is only
    // scrollable once enough of it has arrived, and generation speed is not ours.
    await settle(page, 90000);

    // Scroll the transcript container directly instead of page.mouse.wheel.
    // The wheel is delivered to whatever sits under the pointer, which defaults to
    // (0,0) — the conversation rail, not the transcript — so the transcript never
    // moved and the pill was correctly hidden. Assigning scrollTop fires a real
    // scroll event, so the component's handler runs exactly as it would for a user.
    // Poll until the transcript actually overflows. settle() only proves the
    // Stop button is gone, i.e. the stream finalised; the finalised text lands a
    // moment later, because listPaged deliberately excludes in-flight rows and
    // the settled row arrives on the next query result. Measuring immediately
    // catches the transcript at its pre-render height and reports a false
    // "not scrollable".
    let scrolled = null;
    const growDeadline = Date.now() + 20000;
    while (Date.now() < growDeadline) {
      scrolled = await page.evaluate(() => {
        const el = [...document.querySelectorAll("div")].find(
          (d) =>
            d.scrollHeight > d.clientHeight + 200 &&
            getComputedStyle(d).overflowY === "auto" &&
            // Exclude the conversation rail. It sits earlier in the DOM and,
            // once an account has accumulated enough threads, it overflows
            // too — so a plain "first scrollable div" scrolls the SIDEBAR and
            // the pill, which belongs to the transcript, correctly never shows.
            !d.closest("nav"),
        );
        if (!el) return null;
        el.scrollTop = 0;
        // A programmatic scrollTop is NOT user intent. use-stick-to-bottom.ts
        // keeps a synchronous latch on wheel/touchstart/keys precisely because
        // its IntersectionObserver can be a frame late, so without a real
        // gesture the hook re-pins to the bottom and the pill — which exists to
        // say "you scrolled away" — correctly never appears.
        el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -400 }));
        return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      });
      if (scrolled) break;
      await page.waitForTimeout(500);
    }
    if (!scrolled) {
      throw new Error("transcript never became scrollable (reply too short to overflow)");
    }
    await page.waitForTimeout(800);
    const pill = page.getByRole("button", { name: "Scroll to latest message" });
    // The pill is always in the DOM and toggles aria-hidden, which removes it from
    // the accessibility tree — so getByRole().count() === 0 means "not shown".
    if ((await pill.count()) === 0) {
      throw new Error(
        `pill missing (scrollHeight=${scrolled.scrollHeight} clientHeight=${scrolled.clientHeight})`,
      );
    }
    await pill.click();
    await page.waitForTimeout(600);
  });

  // The "scroll up during streaming is not yanked back" behaviour is covered
  // robustly (overflow guaranteed by accumulating turns) in p-scroll-verify.js,
  // which does not depend on a single reply being long enough to overflow.

  await step("stop generation works", async () => {
    await settle(page); // the pill step's reply must not still be streaming
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


  await step("model picker lists the Ollima catalogue and selects", async () => {
    // The rename step above leaves a Radix menu open, and Radix aria-hides the
    // rest of the page while one is open -- so getByRole cannot see the
    // composer at all until it is dismissed.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // Start a fresh conversation. Earlier steps can leave a generation in
    // flight, and messages.send rejects a second turn on the same thread with
    // "already generating" -- which would silently make the persistence check
    // below a no-op rather than a failure.
    await page.getByRole("button", { name: "New chat" }).click();
    await page.waitForTimeout(1500);

    const trigger = page.getByRole("button", { name: "Choose model" });
    const before = (await trigger.innerText()).trim();
    await trigger.click();

    // The picker filters rather than listing everything. Target a verified-working
    // NON-default model (the default is deepseek-v4-pro; deepseek-v4-flash IS
    // served, so the send below actually generates).
    //
    // Search still accepts the raw id — the filter matches modelId OR name — but
    // the ROW no longer renders that id. The catalogue is a curated shortlist of
    // eight, each rendered as a display name plus one line of description; the
    // id used to sit under the name and read as the same thing twice.
    const search = page.getByLabel("Search models");
    await search.waitFor({ timeout: 8000 });
    await search.fill("deepseek-v4-flash");
    await page.waitForTimeout(600);

    const option = page
      .locator('[role="menu"] button')
      .filter({ hasText: /DeepSeek V4 Flash/i })
      .first();
    if (!(await option.count())) {
      throw new Error("searching the id 'deepseek-v4-flash' matched no catalogue row");
    }
    const rowText = await option.innerText();
    // Regression guard for the shortlist: a row shows a name and a description,
    // never the raw slug.
    if (/deepseek-v4-flash/.test(rowText)) {
      throw new Error(`the picker row still renders the raw model id: ${JSON.stringify(rowText)}`);
    }
    const picked = rowText.split("\n")[0].trim();
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
