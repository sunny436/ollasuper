// What a user actually sees in the seconds after signing in or signing up, on
// desktop and phone. Five scenarios, each observed every 500 ms for a fixed
// window, with the WebSocket watched for the signals behind each failure:
//
//   a  existing user, clean browser                      (control)
//   b  a different account on a browser another used     (stale workspace -> Forbidden)
//   c  a NEW sign-up on a browser another account used   (stale workspace -> Forbidden)
//   d  a tab from before a deploy: the auth library's    (false "Invalid email or password")
//      invalidateCache action answers "not found"
//   e  the same account signs in on a second device;     (evicted tab left blank/stuck)
//      the first device is watched
//
//   QA_EMAIL=… QA_PASSWORD=… OLLASTACK_MAIL_TOKEN=… OLLASTACK_E2E_MAILBOX_ID=… \
//   [DEVICE=desktop|iphone|pixel] [ONLY=a,b,…] [OUT=<dir>] [EXPECT=fixed] node qa-login-matrix.js
//
// Throwaway accounts (B, C) are made through the real UI + e2e inbox and deleted
// through Settings at the end. EXPECT=fixed turns the observations into
// assertions for the post-fix run; without it the script only reports.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { chromium, devices } = require("playwright");
const ollastack = require("./_lib/ollastack");
const { account } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const DEVICE = process.env.DEVICE || "desktop";
const ONLY = (process.env.ONLY || "a,b,c,d,e").split(",");
const OUT = process.env.OUT || "";
const FIXED = process.env.EXPECT === "fixed";
const A = account();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

const PROFILES = {
  desktop: { viewport: { width: 1360, height: 860 } },
  iphone: devices["iPhone 13"],
  pixel: devices["Pixel 7"],
};

/** Everything a scenario needs to know about one page. */
function instrument(page, label) {
  const s = { label, consoleErrors: [], ensureSent: 0, forbidden: 0, heartbeat: [] };
  page.on("console", (m) => m.type() === "error" && s.consoleErrors.push(m.text().slice(0, 160)));
  page.on("pageerror", (e) => s.consoleErrors.push(`pageerror: ${String(e).slice(0, 160)}`));
  page.on("websocket", (ws) => {
    ws.on("framesent", (f) => {
      if (String(f.payload).includes("orgs:ensureWorkspace")) s.ensureSent += 1;
    });
    ws.on("framereceived", (f) => {
      if (String(f.payload).includes("Forbidden")) s.forbidden += 1;
    });
  });
  return s;
}

async function newPage(browser, profile, label) {
  const ctx = await browser.newContext({ ...PROFILES[profile] });
  const page = await ctx.newPage();
  return { ctx, page, s: instrument(page, label) };
}

/** What is on screen right now. */
async function screen(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const composer = document.querySelector("#chat-composer");
    return {
      url: location.pathname,
      errorPage: /Something went wrong/.test(text),
      login: !!document.querySelector('input[type="password"]'),
      preparing: /Preparing your workspace/i.test(text),
      composerReady: !!composer && !composer.disabled,
      notFound: /not found|doesn.t exist|no longer available/i.test(text),
      toast: [...document.querySelectorAll("[data-sonner-toast]")].map((t) => t.innerText.slice(0, 90)),
    };
  }).catch((e) => ({ url: "?", error: String(e).slice(0, 80) }));
}

/** Observe for `ms`, keeping every distinct state seen. */
async function observe(page, s, ms, shot) {
  const seen = [];
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    const st = await screen(page);
    const key = JSON.stringify(st);
    if (key !== last) {
      seen.push({ t: Date.now() - t0, ...st });
      last = key;
    }
    await sleep(500);
  }
  if (OUT && shot) await page.screenshot({ path: path.join(OUT, `${DEVICE}-${shot}.png`) }).catch(() => {});
  return { seen, final: seen[seen.length - 1], ensureSent: s.ensureSent, forbidden: s.forbidden, consoleErrors: s.consoleErrors.slice(0, 4) };
}

async function waitForForm(page) {
  await page.waitForFunction(
    () => {
      const f = document.querySelector("form");
      return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber"));
    },
    null,
    { timeout: 30000 },
  );
}

async function uiSignIn(page, email, password) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await waitForForm(page);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.keyboard.press("Enter");
}

/** Sign up through the real UI; returns once the code is submitted. */
async function uiSignUp(page, label) {
  const tag = ollastack.newTag();
  const email = ollastack.taggedAddress(await ollastack.mailboxAddress(), tag);
  const password = `Qa${crypto.randomBytes(12).toString("base64url")}!7z`;
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await waitForForm(page);
  await page.click('button:has-text("Create an account")');
  await page.fill('input[name="name"]', `QA ${label}`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('input[name="code"]', { timeout: 30000 });
  const code = await ollastack.codeFromOllastack(tag, "email verification", 120000);
  if (!code) throw new Error(`${label}: no verification code arrived`);
  await page.fill('input[name="code"]', code);
  await page.click('button[type="submit"]');
  return { email, password, label };
}

/** Forget the session the way a sign-out does, keeping localStorage as it does. */
async function dropSession(ctx, page) {
  await ctx.clearCookies();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
}

async function deleteAccount(browser, u) {
  const { ctx, page } = await newPage(browser, "desktop", `del-${u.label}`);
  try {
    await uiSignIn(page, u.email, u.password);
    await page.waitForURL(/\/chat/, { timeout: 30000 }).catch(() => {});
    await page.goto(`${BASE}/en/settings`, { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("Your password").waitFor({ timeout: 30000 });
    await page.getByPlaceholder("Your password").fill(u.password);
    await page.getByRole("button", { name: "Delete Account" }).click();
    await page.getByRole("button", { name: "Are you sure?" }).click();
    await page.locator('input[type="password"]').first().waitFor({ timeout: 30000 });
    console.log(`cleanup: ${u.label} deleted`);
  } catch (e) {
    console.log(`cleanup: ${u.label} NOT deleted — ${String(e.message || e).split("\n")[0]}`);
  } finally {
    await ctx.close();
  }
}

function report(id, title, r, ok) {
  results.push({ id, ok });
  const f = r.final || {};
  const states = r.seen.map((x) =>
    [x.errorPage && "ERROR-PAGE", x.login && "login", x.preparing && "preparing", x.composerReady && "composer", x.notFound && "not-found", x.toast?.length && `toast:${x.toast.join("|")}`]
      .filter(Boolean)
      .join("+") || x.url,
  );
  console.log(
    `${ok === undefined ? "INFO" : ok ? "PASS" : "FAIL"}  [${id}] ${title}\n` +
      `      states: ${[...new Set(states)].join(" → ")}\n` +
      `      final: ${f.url} errorPage=${!!f.errorPage} composer=${!!f.composerReady} login=${!!f.login}` +
      ` | ensureWorkspace sent=${r.ensureSent} | Forbidden frames=${r.forbidden} | console errors=${r.consoleErrors.length}` +
      (r.consoleErrors.length ? ` (${r.consoleErrors[0]})` : ""),
  );
}

(async () => {
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: !!process.env.HEADLESS });
  const made = [];
  try {
    // The "used browser": A signs in here first, so it carries A's state.
    const used = await newPage(browser, DEVICE, "used");

    if (ONLY.includes("a") || ONLY.includes("e") || ONLY.includes("b") || ONLY.includes("c")) {
      await uiSignIn(used.page, A.email, A.password);
      const r = await observe(used.page, used.s, 12000, "a");
      const f = r.final;
      report("a", `existing user, clean browser (${DEVICE})`, r,
        FIXED ? f.composerReady && !f.errorPage && r.consoleErrors.length === 0 : undefined);
    }

    if (ONLY.includes("e")) {
      // A second device signs in as the same account; watch the first.
      const other = await newPage(browser, DEVICE === "desktop" ? "iphone" : "desktop", "second-device");
      const before = { ensure: used.s.ensureSent, forbidden: used.s.forbidden };
      await uiSignIn(other.page, A.email, A.password);
      await other.page.waitForURL(/\/chat/, { timeout: 30000 }).catch(() => {});
      const r = await observe(used.page, used.s, 25000, "e-first-device");
      r.ensureSent -= before.ensure;
      r.forbidden -= before.forbidden;
      const f = r.final;
      const blankish = !f.errorPage && !f.login && (f.preparing || !f.composerReady || f.notFound);
      report("e", "same account signs in on a second device — the FIRST device", r,
        FIXED ? f.composerReady && !f.errorPage && r.ensureSent <= 1 : undefined);
      console.log(`      first device looks blank/stuck: ${blankish}; ensureWorkspace calls in 25 s: ${r.ensureSent}`);
      const r2 = await observe(other.page, other.s, 3000, "e-second-device");
      report("e2", "…and the second device", r2, FIXED ? r2.final.composerReady : undefined);
      await other.ctx.close();
    }

    if (ONLY.includes("b")) {
      // B exists already (made in its own browser), then signs in on the used one.
      const mk = await newPage(browser, "desktop", "make-B");
      const B = await uiSignUp(mk.page, "B");
      await mk.page.waitForURL(/\/chat/, { timeout: 30000 }).catch(() => {});
      await sleep(3000);
      await mk.ctx.close();
      made.push(B);
      await dropSession(used.ctx, used.page);
      const before = { ensure: used.s.ensureSent, forbidden: used.s.forbidden, errs: used.s.consoleErrors.length };
      await uiSignIn(used.page, B.email, B.password);
      const r = await observe(used.page, used.s, 12000, "b");
      r.ensureSent -= before.ensure;
      r.forbidden -= before.forbidden;
      r.consoleErrors = used.s.consoleErrors.slice(before.errs);
      const f = r.final;
      report("b", "a different (non-member) account on a used browser", r,
        FIXED ? f.composerReady && !f.errorPage && r.consoleErrors.length === 0 : undefined);
    }

    if (ONLY.includes("c")) {
      await dropSession(used.ctx, used.page);
      const before = { ensure: used.s.ensureSent, forbidden: used.s.forbidden, errs: used.s.consoleErrors.length };
      const C = await uiSignUp(used.page, "C");
      made.push(C);
      const r = await observe(used.page, used.s, 15000, "c");
      r.ensureSent -= before.ensure;
      r.forbidden -= before.forbidden;
      r.consoleErrors = used.s.consoleErrors.slice(before.errs);
      const f = r.final;
      report("c", "a NEW sign-up on a browser another account used", r,
        FIXED ? f.composerReady && !f.errorPage && r.ensureSent <= 1 && r.consoleErrors.length === 0 : undefined);
    }
    await used.ctx.close();

    if (ONLY.includes("d")) {
      const d = await newPage(browser, DEVICE, "stale");
      // Exactly what Next answers for an action id the running build lacks.
      await d.page.route(/\/login(\?.*)?$/, (route) => {
        const req = route.request();
        if (req.method() === "POST" && req.headers()["next-action"]) {
          return route.fulfill({
            status: 404,
            headers: { "x-nextjs-action-not-found": "1", "content-type": "text/plain" },
            body: "Server action not found.",
          });
        }
        return route.continue();
      });
      await uiSignIn(d.page, A.email, A.password);
      const r = await observe(d.page, d.s, 12000, "d");
      const f = r.final;
      const falseError = r.seen.some((x) => x.toast?.some((t) => /Invalid email or password|not found on the server/i.test(t)));
      report("d", "tab from before a deploy (auth cache action unknown)", r,
        FIXED ? !falseError && /\/chat/.test(f.url) && f.composerReady : undefined);
      console.log(`      false credential error shown: ${falseError}`);
      await d.ctx.close();
    }
  } catch (e) {
    console.log(`ABORTED: ${String(e.message || e).split("\n")[0]}`);
    results.push({ id: "run", ok: false });
  } finally {
    for (const u of made) await deleteAccount(browser, u);
    await browser.close();
  }
  const judged = results.filter((r) => r.ok !== undefined);
  const pass = judged.filter((r) => r.ok).length;
  console.log(`\n=== LOGIN MATRIX (${DEVICE}${FIXED ? ", asserting" : ", observing"}): ${FIXED ? `${pass}/${judged.length}` : "report only"} ===`);
  process.exit(FIXED && pass !== judged.length ? 1 : 0);
})();
