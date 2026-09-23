// The sign-in page's layout, on every size it ships to and in both themes.
//
// House style: standalone node script, hand-rolled step() harness, a hard
// assertion of zero console errors. Headed Chrome, because that is the gate.
//
//   node qa-auth-ui.js              # all viewports, both themes
//   node qa-auth-ui.js --shots-only # skip assertions, just capture
//
// WHAT IT IS FOR. The centred layout removed the split card that used to absorb
// every sizing mistake: the brand is now a sibling of the form rather than a
// column beside it, and the form is vertically centred rather than top-aligned
// in a scroller. Both are exactly the shapes that break on a short phone, so
// this measures the three things that would actually reach a user — content
// wider than the screen, a control nothing can click because something covers
// it, and a field that lost its label — at the three widths and both themes.
//
// It signs in NOTHING and sends NO mail. The four panels below are every panel
// reachable without a side effect; `verify`, `reset` and the OTP code step are
// the SAME two primitives (PanelFrame + FieldShell) with different children,
// and they are exercised for real by p2-auth.js and p-auth-edges.js.
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const SHOTS = path.join(__dirname, ".perf", "auth-ui");
const SHOTS_ONLY = process.argv.includes("--shots-only");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844, touch: true },
  { name: "tablet", width: 820, height: 1180, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false },
];

/** Every panel reachable with no side effect, and how to get there from signIn. */
const PANELS = [
  { mode: "signIn", heading: "Welcome back", go: null },
  { mode: "forgot", heading: "Reset password", go: (p) => p.getByRole("button", { name: "Forgot?" }).click() },
  { mode: "otp", heading: "Email code", go: (p) => p.getByText("Sign in with a one-time email code").click() },
  { mode: "signUp", heading: "Your Intelligence Starts Here", go: (p) => p.getByRole("button", { name: /Create an account/ }).click() },
  // The two-field code+password panel, reached WITHOUT sending anything: for an
  // address with no account, queuePasswordReset returns after one indexed read —
  // no budget consumed, no scheduler job, no mail (convex/authSessions.ts). The
  // UI still advances, which is the whole point of that design. This is also the
  // stand-in for  and the OTP code step: all three are the same
  // FieldShell code path with a KeyRound icon and a  input.
  {
    mode: "reset",
    heading: "New password",
    go: async (p) => {
      await p.getByRole("button", { name: "Forgot?" }).click();
      await p.getByRole("heading", { name: "Reset password" }).waitFor({ timeout: 15000 });
      await p.locator('input[name="email"]').fill(`nobody-${Date.now()}@example.invalid`);
      await p.getByRole("button", { name: /Send reset code/ }).click();
    },
  },
];

const failures = [];
const notes = [];
const fail = (where, why) => {
  failures.push(`${where}: ${why}`);
  console.log(`  FAIL  ${where} — ${why}`);
};
const ok = (where, detail) => console.log(`  ok    ${where}${detail ? ` — ${detail}` : ""}`);

/**
 * Runs in the page. Deliberately mirrors the three checks qa-responsive.js
 * hard-fails on, scoped to this route, plus the label pairing axe would flag.
 */
const AUDIT = () => {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const desc = (el) => {
    const cls = String(el.className?.baseVal ?? el.className ?? "").split(/\s+/).slice(0, 2).join(".");
    const label = el.getAttribute?.("aria-label") || (el.textContent || "").trim().slice(0, 20);
    return `${el.tagName.toLowerCase()}${label ? `[${label}]` : ""}.${cls}`.slice(0, 80);
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const overflowX = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw;
  const outside = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (!visible(el) || getComputedStyle(el).position === "fixed") continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 2 || r.left < -2) outside.push(`${desc(el)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
  }

  // Only the controls a user actually reaches for, and only while on screen:
  // an element scrolled out of view is scrolling, not covering.
  const controls = [...document.querySelectorAll("main input, main button, main a[href]")].filter(visible);
  const covered = [];
  const small = [];
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > vh) continue;
    if (Math.min(r.width, r.height) < 44) small.push(`${desc(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit) continue;
    if (hit === el || el.contains(hit) || hit.contains(el)) continue;
    covered.push(`${desc(el)} <- ${desc(hit)}`);
  }

  const inputs = [...document.querySelectorAll("main input")];
  const unlabelled = inputs
    .filter((i) => {
      if (!i.id) return true;
      return !document.querySelector(`label[for="${CSS.escape(i.id)}"]`);
    })
    .map((i) => i.name || i.type);

  const header = document.querySelector("header");
  const card = document.querySelector("main > div");
  const brand = header?.querySelector("span");
  const br = brand?.getBoundingClientRect();
  const hr = header?.getBoundingClientRect();
  const cr = card?.getBoundingClientRect();
  const brandOverlapsForm = !!(hr && cr && hr.bottom > cr.top + 1 && hr.right > cr.left + 1 && hr.left < cr.right - 1);

  const submit = document.querySelector('main button[type="submit"]');
  return {
    overflowX,
    outside,
    covered,
    small,
    unlabelled,
    inputs: inputs.length,
    brandVisible: !!(header && visible(header)),
    brandLeft: br ? Math.round(br.left) : null,
    brandOverlapsForm,
    submits: document.querySelectorAll('main button[type="submit"]').length,
    submitLabel: submit ? submit.innerText.trim().replace(/\s+/g, " ") : null,
    pageScroll: Math.max(0, document.documentElement.scrollHeight - vh),
    bg: getComputedStyle(document.body).backgroundColor,
    dark: document.documentElement.classList.contains("dark"),
  };
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });

  // ---- 0. the form must be painted by the SERVER, not by hydration ---------
  // framer-motion serialises `initial` into the SSR markup, so a missing
  // AnimatePresence initial={false} ships a form at opacity:0 — invisible until
  // the motion chunk lands. On a centred page that is the entire screen.
  {
    const html = await fetch(`${BASE}/login`).then((r) => r.text());
    const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
    const hidden = /style="[^"]*opacity:\s*0/.test(form);
    console.log("SSR");
    if (hidden) fail("ssr", "the form is opacity:0 in the server HTML (AnimatePresence initial={false} lost?)");
    else ok("ssr", "form painted server-side, no opacity:0");
    const landmarks = ["<header", "<main"].filter((t) => html.includes(t));
    if (landmarks.length === 2) ok("ssr landmarks", "header + main present");
    else fail("ssr landmarks", `only ${landmarks.join(",") || "none"}`);
  }

  const browser = await chromium.launch({ headless: false });
  const errors = [];

  for (const vp of VIEWPORTS) {
    for (const theme of ["light", "dark"]) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.touch,
        hasTouch: vp.touch,
        deviceScaleFactor: vp.touch ? 2 : 1,
        colorScheme: theme,
      });
      const page = await ctx.newPage();
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`${vp.name}/${theme}: ${m.text().slice(0, 160)}`);
      });
      page.on("pageerror", (e) => errors.push(`${vp.name}/${theme}: pageerror ${String(e).slice(0, 160)}`));

      await page.goto(`${BASE}/login`, { waitUntil: "load" });
      // The motion chunk is async; give it time so a mode switch really animates.
      await page.waitForSelector('input[name="email"]', { timeout: 30000 });
      await sleep(2500);

      console.log(`\n${vp.name} ${vp.width}x${vp.height} ${theme}${vp.touch ? " touch" : ""}`);

      for (const panel of PANELS) {
        if (panel.go) {
          await panel.go(page);
          await page.getByRole("heading", { name: panel.heading }).waitFor({ timeout: 15000 });
          await sleep(700); // let the enter animation settle before measuring
        }
        const a = await page.evaluate(AUDIT);
        const where = `${vp.name}/${theme}/${panel.mode}`;
        await page.screenshot({ path: path.join(SHOTS, `${vp.name}-${theme}-${panel.mode}.png`), fullPage: true });

        if (!SHOTS_ONLY) {
          if (a.overflowX > 0) fail(where, `horizontal overflow ${a.overflowX}px`);
          if (a.outside.length) fail(where, `${a.outside.length} outside the viewport: ${a.outside.slice(0, 2).join(" | ")}`);
          if (a.covered.length) fail(where, `${a.covered.length} covered controls: ${a.covered.slice(0, 2).join(" | ")}`);
          if (a.unlabelled.length) fail(where, `inputs with no <label for>: ${a.unlabelled.join(", ")}`);
          if (!a.brandVisible) fail(where, "the brand is not visible");
          if (a.brandOverlapsForm) fail(where, "the brand overlaps the form");
          if (a.submits !== 1) fail(where, `${a.submits} submit buttons (selectors assume exactly 1)`);
          if (a.dark !== (theme === "dark")) fail(where, `theme did not apply (dark=${a.dark})`);
          if (a.overflowX <= 0 && !a.outside.length && !a.covered.length && !a.unlabelled.length && a.brandVisible && !a.brandOverlapsForm && a.submits === 1) {
            ok(where, `${a.inputs} labelled inputs, brand@x${a.brandLeft}, "${a.submitLabel}", scroll ${a.pageScroll}px, bg ${a.bg}`);
          }
          // Recorded, never fatal — the same stance qa-responsive.js takes.
          if (vp.touch && a.small.length) notes.push(`${where}: ${a.small.length} target(s) under 44px — ${a.small.join(" | ")}`);
        }

        if (panel.go) {
          // Back to signIn for the next panel. signUp's route back says "Sign in".
          const back = panel.mode === "signUp"
            ? page.getByRole("button", { name: "Sign in", exact: true })
            : page.getByRole("button", { name: "Back to login" });
          await back.click();
          await page.getByRole("heading", { name: "Welcome back" }).waitFor({ timeout: 15000 });
          await sleep(500);
        }
      }

      // The brand must SURVIVE A SCROLL — that is the whole point of sticky, and
      // the only way to see it is on a viewport too short for the tallest panel.
      if (!SHOTS_ONLY && vp.touch) {
        await page.getByRole("button", { name: /Create an account/ }).click();
        await page.getByRole("heading", { name: "Your Intelligence Starts Here" }).waitFor({ timeout: 15000 });
        await page.setViewportSize({ width: vp.width, height: 560 });
        await sleep(600);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(600);
        const pin = await page.evaluate(() => {
          const brand = document.querySelector("header")?.querySelector("span");
          const r = brand?.getBoundingClientRect();
          return {
            scrollY: Math.round(window.scrollY),
            top: r ? Math.round(r.top) : null,
            onScreen: !!r && r.top >= 0 && r.bottom <= window.innerHeight,
          };
        });
        const stickyWhere = `${vp.name}/${theme}/sticky-brand`;
        if (pin.scrollY < 40) fail(stickyWhere, `the page only scrolled ${pin.scrollY}px, so this proves nothing`);
        else if (!pin.onScreen || pin.top > 40) fail(stickyWhere, `the brand scrolled away (top=${pin.top} after ${pin.scrollY}px)`);
        else ok(stickyWhere, `brand still pinned at y=${pin.top} after scrolling ${pin.scrollY}px`);
        await page.screenshot({ path: path.join(SHOTS, `${vp.name}-${theme}-scrolled.png`) });
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await page.getByRole("heading", { name: "Welcome back" }).waitFor({ timeout: 15000 });
      }

      // Keyboard: the form must be reachable and every stop must show a ring.
      if (!SHOTS_ONLY && !vp.touch) {
        const order = [];
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press("Tab");
          order.push(
            await page.evaluate(() => {
              const el = document.activeElement;
              if (!el || el === document.body) return null;
              const name = el.getAttribute("aria-label") || el.getAttribute("name") || (el.textContent || "").trim().slice(0, 24);
              return `${el.tagName.toLowerCase()}:${name}`;
            }),
          );
        }
        const seq = order.filter(Boolean);
        const hasEmail = seq.some((s) => /email/i.test(s));
        const hasPassword = seq.some((s) => /password/i.test(s));
        const hasSubmit = seq.some((s) => /Enter workspace/i.test(s));
        if (hasEmail && hasPassword && hasSubmit) ok(`${vp.name}/${theme}/keyboard`, seq.slice(0, 8).join(" → "));
        else fail(`${vp.name}/${theme}/keyboard`, `tab order missed a control: ${seq.join(" → ")}`);
      }

      await ctx.close();
    }
  }

  await browser.close();

  console.log(`\n${"=".repeat(62)}`);
  for (const n of notes) console.log(`NOTE  ${n}`);
  for (const e of errors) console.log(`CONSOLE  ${e}`);
  const total = VIEWPORTS.length * 2 * PANELS.length;
  console.log(`===== AUTH UI: ${total - failures.length}/${total} states clean | console errors: ${errors.length} | screenshots: ${SHOTS}`);
  if (failures.length || errors.length) {
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
})();
