// Chat end-to-end, in the house style: standalone node script, hand-rolled
// step() harness, and a hard assertion of zero console errors.
//
// Requires a live deployed stack with the AI service configured:
//   E2E_BASE_URL=https://<app>  node p-chat.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const { email: EMAIL, password: PASSWORD } = require("./creds").account();
const { capturePrefs, restorePrefs } = require("./pref-state");

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

  // The theme step below toggles dark and then light and used to leave the
  // account on light whatever it held before. Captured here, on a context that
  // has seeded nothing, so what ThemeSync adopted IS the account value.
  const originalPrefs = await capturePrefs(page);

  await step("Chat appears in the sidebar and navigates", async () => {
    // The dashboard aside no longer renders anywhere (/files became the File
    // Library, a workspace surface beside the rail). Drive the navigation from
    // the Library through the rail's New chat — still shell -> chat.
    await page.goto(BASE + "/en/library", { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Library" }).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "New chat" }).first().click();
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
        (w) => document.documentElement.dataset.theme === w,
        want,
        { timeout: 10000, polling: "raf" },
      )
      .catch(() => {});
  };

  const themeState = () =>
    page.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      ds: document.documentElement.dataset.theme,
      bg: getComputedStyle(document.body).backgroundColor,
      cached: (() => {
        try {
          return localStorage.getItem("theme");
        } catch {
          return null;
        }
      })(),
    }));

  await step("theme toggle themes the whole app, and it survives a reload", async () => {
    // REWRITTEN for the monochrome system. This used to assert ~31 --amb-* vars
    // on <html> and a numeric dataset, because the toggle drove a continuous
    // day->night colour ramp. There is no ramp: there are two modes, the class
    // is the whole mechanism, and the tokens are literals in globals.css.
    //
    // So the contract asserted here is now the one that actually matters —
    // .dark, data-theme and the localStorage cache agree, the page really
    // repaints to pure white / pitch black, and the choice is still there after
    // a reload (the no-flash path, which is what a user notices).
    const toggle = page.locator('button[aria-label="Toggle dark and light theme"]');
    if ((await toggle.count()) === 0) throw new Error("no theme toggle");

    if ((await themeState()).dark) {
      // Start from light so the assertions below describe a real transition.
      await toggle.first().click();
      await settleTheme("light");
    }

    await toggle.first().click();
    await settleTheme("dark");
    const night = await themeState();
    if (!night.dark) throw new Error("the toggle did not turn .dark on");
    if (night.ds !== "dark")
      throw new Error(`data-theme expected dark, got ${night.ds}`);
    if (night.cached !== "dark")
      throw new Error(`localStorage.theme expected dark, got ${night.cached}`);
    if (night.bg !== "rgb(0, 0, 0)")
      throw new Error(`dark background expected pitch black, got ${night.bg}`);

    // Persistence: the pre-paint script must read the cache back, so the mode
    // survives a navigation with no flash of the other theme.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    const reloaded = await themeState();
    if (!reloaded.dark || reloaded.ds !== "dark")
      throw new Error(`dark did not survive a reload: ${JSON.stringify(reloaded)}`);

    await toggle.first().click();
    await settleTheme("light");
    const day = await themeState();
    if (day.dark) throw new Error("the toggle did not turn .dark back off");
    if (day.ds !== "light")
      throw new Error(`data-theme expected light, got ${day.ds}`);
    if (day.bg !== "rgb(255, 255, 255)")
      throw new Error(`light background expected pure white, got ${day.bg}`);
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


  await step("the composer offers no model choice and never names one", async () => {
    // REPLACES "model picker lists the Ollima catalogue and selects". The
    // picker was removed deliberately: the Master Model Router chooses per turn
    // and the model is an implementation detail, so there is no control to
    // drive and no name to assert. Asserting its ABSENCE is the invariant that
    // now matters — a reintroduced picker, or a model name leaking back into
    // the transcript, is the regression.
    //
    // The send at the end is kept from the original: it proved the choice
    // reached the data plane, and it still proves a fresh thread generates.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "New chat" }).click();
    await page.waitForTimeout(1500);

    if (await page.getByRole("button", { name: "Choose model" }).count()) {
      throw new Error("the model picker is back in the composer");
    }
    if (await page.getByLabel("Search models").count()) {
      throw new Error("the model search is back");
    }

    await page.locator("#chat-composer").fill("router-probe: name a primary colour");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);
    for (let i = 0; i < 300; i++) {
      if ((await page.getByRole("button", { name: "Stop generating" }).count()) === 0 && i > 8)
        break;
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(800);

    const body = await page.evaluate(() => document.body.innerText || "");
    if (body.length < 200) throw new Error("the fresh thread produced no answer");
    // No underlying model may be named anywhere the user can read.
    const leaked = ["qwen", "deepseek", "glm-5", "gpt-oss", "grok", "gemini"].filter(
      (m) => body.toLowerCase().includes(m),
    );
    if (leaked.length) {
      throw new Error("a model name leaked into the chat UI: " + leaked.join(", "));
    }
    if (/OllaSupers*[·|-]/.test(body)) {
      throw new Error("the assistant turn is labelled again");
    }
    const u = page.url();
    console.log("    fresh thread generated, no model exposed: " + u.slice(u.lastIndexOf("/") + 1));
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

  await step("account theme/accent restored to what the suite found", async () => {
    if (!(await restorePrefs(page, originalPrefs, BASE))) {
      throw new Error("restore did not land on the account");
    }
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
