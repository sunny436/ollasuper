// qa-accent.js — the accent colour system, in a real browser.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-accent.js
//   node qa-accent.js --headless
//
// The static half (apps/app/src/lib/theme/monochrome.test.ts) reads globals.css
// and proves the palette is complete and legible. It cannot see:
//
//   1. Whether the attribute actually reaches <html> BEFORE paint.
//   2. Whether a component picked up the accent or is still on --primary.
//   3. Whether accent and light/dark are genuinely independent, or merely look
//      it until one of them is written.
//   4. What a hostile stored value does to a live page.
const { chromium } = require("playwright");
const { account } = require("./creds");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const HEADLESS = process.argv.includes("--headless");
const ACCENTS = ["blue", "green", "yellow", "pink", "orange", "purple", "neutral"];

let pass = 0;
const failures = [];
const log = (...a) => console.log(...a);
const check = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
    log(`FAIL  ${name}  (${detail})`);
  }
};

/** What the page is actually painting right now. */
function readState(page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    const paint = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, fg: s.color };
    };
    return {
      accent: document.documentElement.dataset.accent || null,
      theme: document.documentElement.dataset.theme || null,
      dark: document.documentElement.classList.contains("dark"),
      brand: v("--brand"),
      brandInk: v("--brand-ink"),
      brandFg: v("--brand-foreground"),
      // the accent-consuming surfaces, as rendered
      skipLink: paint('a[href="#workspace-main"]'),
      cached: (() => {
        try {
          return {
            accent: localStorage.getItem("accent"),
            theme: localStorage.getItem("theme"),
          };
        } catch {
          return null;
        }
      })(),
    };
  });
}

const seed = (page, accent, mode) =>
  page.evaluate(
    ([a, m, ts]) => {
      try {
        if (a !== null) {
          localStorage.setItem("accent", a);
          localStorage.setItem("accent_ts", String(ts));
        } else {
          localStorage.removeItem("accent");
          localStorage.removeItem("accent_ts");
        }
        if (m) {
          localStorage.setItem("theme", m);
          localStorage.setItem("theme_ts", String(ts));
        }
      } catch {}
    },
    [accent, mode, Date.now()],
  );

async function signIn(page, who) {
  await page.goto(`${BASE}/login`, { waitUntil: "load" });
  await page.waitForTimeout(2400);
  await page.locator('input[type="email"]').first().fill(who.email);
  await page.locator('input[type="password"]').first().fill(who.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 90000, waitUntil: "commit" });
  await page.waitForSelector("#chat-composer", { timeout: 60000 });
}

async function main() {
  const who = account();
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 150)));
  page.on("pageerror", (e) => errs.push(`pageerror ${e.message.slice(0, 150)}`));

  // ------------------------------------------------- default for a fresh visitor
  //
  // Checked LOGGED OUT, on purpose. Signed in there is an account preference, and
  // it correctly outranks an empty local cache — so asserting "no cache means
  // blue" against a signed-in page tests the wrong rung of the precedence chain,
  // and fails the moment a previous run has stored something.
  await page.goto(`${BASE}/login`, { waitUntil: "load" });
  await seed(page, null, "light");
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(1800);
  let s = await readState(page);
  check("a first-time visitor resolves to Blue", s.accent === "blue", `data-accent=${s.accent}`);
  const BLUE_LIGHT = s.brand;
  check("Blue is a real hue, not ink", /^\d/.test(BLUE_LIGHT) && BLUE_LIGHT !== "0 0% 0%", BLUE_LIGHT);

  await signIn(page, who);

  // The next rung of the chain: with no local cache, the ACCOUNT preference is
  // restored. That is what carries the accent to a new device, and it is what the
  // check above was accidentally measuring before it was moved to /login.
  await seed(page, "pink", null);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2800); // let the settings write land
  await seed(page, null, null); // drop the local cache only
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2800);
  s = await readState(page);
  check(
    "with no local cache, the account preference is restored",
    s.accent === "pink",
    `data-accent=${s.accent}`,
  );

  // ---------------------------------------------- every accent, both appearances
  const seen = {};
  for (const accent of ACCENTS) {
    for (const mode of ["light", "dark"]) {
      await seed(page, accent, mode);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1700);
      s = await readState(page);
      const key = `${accent}/${mode}`;
      seen[key] = s.brand;
      const ok =
        s.accent === accent &&
        s.dark === (mode === "dark") &&
        s.brand.length > 0 &&
        s.brandInk.length > 0 &&
        s.brandFg.length > 0;
      check(`${key}: attribute + all three tokens resolve`, ok, `brand=${s.brand}`);
    }
  }

  // Each accent must actually differ — a typo'd selector would silently give
  // every accent the :root default and every check above would still pass.
  const lights = ACCENTS.map((a) => seen[`${a}/light`]);
  check(
    "the seven accents are seven distinct palettes",
    new Set(lights).size === ACCENTS.length,
    `${new Set(lights).size} distinct of ${ACCENTS.length}`,
  );

  // Neutral must be exactly the monochrome values.
  check(
    "neutral restores pure ink",
    seen["neutral/light"] === "0 0% 0%" && seen["neutral/dark"] === "0 0% 100%",
    `light=${seen["neutral/light"]} dark=${seen["neutral/dark"]}`,
  );

  // ------------------------------------------------------------- independence
  await seed(page, "purple", "light");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  const toggle = page.locator('button[aria-label="Toggle dark and light theme"]');
  await toggle.first().click();
  await page.waitForTimeout(900);
  s = await readState(page);
  check(
    "light -> dark keeps the accent",
    s.accent === "purple" && s.dark === true,
    `accent=${s.accent} dark=${s.dark}`,
  );

  await page.goto(`${BASE}/settings/appearance`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  const before = (await readState(page)).dark;
  await page.locator('input[name="accent"][value="green"]').check({ force: true });
  await page.waitForTimeout(900);
  s = await readState(page);
  check(
    "accent A -> B keeps the appearance",
    s.accent === "green" && s.dark === before,
    `accent=${s.accent} dark=${s.dark} (was ${before})`,
  );
  check("the picker writes the cache", s.cached?.accent === "green", s.cached?.accent);

  // --------------------------------------------------------------- persistence
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  s = await readState(page);
  check("accent survives a reload", s.accent === "green", s.accent);

  const tab = await ctx.newPage();
  await tab.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
  await tab.waitForTimeout(2400);
  const t = await readState(tab);
  check("a new tab opens on the same accent", t.accent === "green", t.accent);
  await tab.close();

  // ----------------------------------------------------- a hostile stored value
  await page.evaluate(() => {
    try {
      localStorage.setItem("accent", "red; background:url(//evil)");
      localStorage.setItem("accent_ts", String(Date.now()));
    } catch {}
  });
  const errsBefore = errs.length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  s = await readState(page);
  const injected = await page.evaluate(() =>
    document.documentElement.getAttribute("style"),
  );
  check(
    "an invalid stored accent falls back to Blue",
    s.accent === "blue",
    `data-accent=${s.accent}`,
  );
  check("...and injects no style", !injected, `style=${injected}`);
  check("...and logs nothing", errs.length === errsBefore, errs.slice(errsBefore, errsBefore + 2).join(" | "));

  // -------------------------------------- the shared Button moved off --primary
  await seed(page, "orange", "light");
  await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 30000 });
  await page.waitForTimeout(1200);
  // The send button only takes bg-brand once there is something to send, and an
  // idle /chat renders no other filled brand surface — so without this the sweep
  // below finds nothing and the assertion passes on an empty set.
  await page.locator("#chat-composer").fill("accent probe");
  await page.waitForTimeout(700);
  // This must not be able to pass vacuously. An earlier version only checked that
  // no visible button was pure black - which is also true on a page that renders
  // no primary button at all, so it proved nothing about the shared <Button>.
  // Instead: find the elements that actually carry the shared class and compare
  // their PAINTED colour against the accent the page resolved.
  const buttons = await page.evaluate(() => {
    const hsl = getComputedStyle(document.documentElement)
      .getPropertyValue("--brand")
      .trim();
    // Paint the token into a probe so the comparison is rgb-vs-rgb rather than
    // re-implementing hsl->rgb in the assertion.
    const probe = document.createElement("div");
    probe.style.cssText = `position:absolute;visibility:hidden;background:hsl(${hsl})`;
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    // Visibility by geometry, not offsetParent: the send button sits inside a
    // framer-motion layout container, and offsetParent can be null under a
    // transformed ancestor - which would make a visibly painted button
    // "invisible" to this filter.
    const all = [...document.querySelectorAll("button, a")].filter((b) =>
      /(^|\s)bg-brand(\s|$)/.test(String(b.className || "")),
    );
    const filled = all.filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return {
      hsl,
      expected,
      total: all.length,
      found: filled.length,
      sample: filled.slice(0, 3).map((b) => b.getAttribute("aria-label") || b.tagName),
      mismatched: filled
        .map((b) => getComputedStyle(b).backgroundColor)
        .filter((c) => c !== expected),
    };
  });
  check(
    "the shared bg-brand surface paints the resolved accent",
    buttons.found > 0 && buttons.mismatched.length === 0,
    `found=${buttons.found} of ${buttons.total} [${buttons.sample.join(", ")}] expected=${buttons.expected} mismatched=${buttons.mismatched.join(", ") || "none"}`,
  );

  // ------------------------------------ the settings <Button> specifically
  //
  // The one component edit in this feature. The 404 page renders "Go home" as a
  // bare <Button> - the shadcn default variant that used to sit on --primary -
  // and it is always enabled, unlike the Save buttons that sit disabled until a
  // form is dirty. It must paint the same accent the chat send button does.
  // Probing a 404 page makes the browser log the 404 for the document itself.
  // That is the route doing its job, not the app failing, so exactly that one
  // resource error is dropped from the gate - and nothing else.
  const errsBefore404 = errs.length;
  await page.goto(`${BASE}/this-route-does-not-exist`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  const upload = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /go home/i.test(b.textContent || ""),
    );
    if (!btn) return null;
    const hsl = getComputedStyle(document.documentElement).getPropertyValue("--brand").trim();
    const probe = document.createElement("div");
    probe.style.cssText = `position:absolute;visibility:hidden;background:hsl(${hsl})`;
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      onBrand: /(^|\s)bg-brand(\s|$)/.test(btn.className),
      onPrimary: /(^|\s)bg-primary(\s|$)/.test(btn.className),
      bg: getComputedStyle(btn).backgroundColor,
      expected,
    };
  });
  check(
    "the shared <Button> default variant moved off --primary",
    !!upload && upload.onBrand && !upload.onPrimary && upload.bg === upload.expected,
    upload ? `bg=${upload.bg} expected=${upload.expected} brand=${upload.onBrand} primary=${upload.onPrimary}` : "Go home button not found",
  );
  for (let i = errs.length - 1; i >= errsBefore404; i--) {
    if (/Failed to load resource: the server responded with a status of 404/.test(errs[i])) {
      errs.splice(i, 1);
    }
  }

  // ------------------------------------------- logout -> login, no local cache
  //
  // The local cache is wiped between the two so the ONLY way the accent comes
  // back is from the account row. That is the account-scoped guarantee.
  await page.goto(`${BASE}/settings/appearance`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.locator('input[name="accent"][value="yellow"]').check({ force: true });
  await page.waitForTimeout(2600); // let the upsert land
  await ctx.clearCookies();
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {}
  });
  await signIn(page, who);
  await page.waitForTimeout(2800);
  s = await readState(page);
  check("logout -> login restores the account accent with no cache", s.accent === "yellow", `data-accent=${s.accent}`);

  // ---------------------------------------------- the backend is unreachable
  //
  // A device that cannot reach Convex sees settings stay undefined forever.
  // Treating that as "no preference" would repaint the app blue on every flaky
  // connection. The local accent must be KEPT.
  {
    const offline = await browser.newContext({
      viewport: { width: 1280, height: 820 },
      storageState: await ctx.storageState(),
    });
    await offline.addInitScript(() => {
      try {
        localStorage.setItem("accent", "purple");
        localStorage.setItem("accent_ts", String(Date.now()));
      } catch {}
    });
    const off = await offline.newPage();
    await off.routeWebSocket(/.*/, (ws) => ws.close());
    await off.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await off.waitForTimeout(6000);
    const o = await readState(off);
    check("backend unreachable: the local accent is kept, not flipped", o.accent === "purple", `data-accent=${o.accent}`);
    await offline.close();
  }

  check("zero console errors", errs.length === 0, errs.slice(0, 3).join(" | "));

  await ctx.close();
  await browser.close();
  log(`\n${"=".repeat(64)}`);
  if (failures.length) {
    log(`FAILURES (${failures.length}):`);
    for (const f of failures) log(`  ${f}`);
  }
  log(`\naccent: ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
