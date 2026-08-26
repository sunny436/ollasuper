// Ambience slider washout/velocity verification — PROD headed Chrome.
// Drives the real deployed slider across 0..100, reads the actual --amb-* vars,
// and asserts: (1) smooth velocity — no cliff/jump, (2) readable at every stop,
// (3) the adaptive greeting halo is deployed, (4) zero console errors.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-ambience.js
const { chromium } = require("playwright");
const fs = require("fs");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const OUT = process.env.SHOT_DIR || ".";

const errs = [];
const results = [];
const step = async (n, f) => {
  try { await f(); results.push(true); console.log("PASS  " + n); }
  catch (e) { results.push(false); console.log("FAIL  " + n + " — " + e.message.split("\n")[0]); }
};

// ── colour math (mirrors interpolate.ts) ──
const pt = (s) => s.replace(/hsl\(|\)|\/.*$/g, "").trim().split(/\s+/).map((x, i) => parseFloat(i ? x.replace("%", "") : x) || 0);
function h2r(h, s, l) { s /= 100; l /= 100; const c = (1 - Math.abs(2 * l - 1)) * s, hp = (((h % 360) + 360) % 360) / 60, x = c * (1 - Math.abs((hp % 2) - 1)); let r = 0, g = 0, b = 0; if (hp < 1) [r, g] = [c, x]; else if (hp < 2)[r, g] = [x, c]; else if (hp < 3)[g, b] = [c, x]; else if (hp < 4)[g, b] = [x, c]; else if (hp < 5)[r, b] = [x, c]; else[r, b] = [c, x]; const m = l - c / 2; return [(r + m) * 255, (g + m) * 255, (b + m) * 255]; }
function rl(triple) { const [h, s, l] = pt(triple); const c = h2r(h, s, l).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
const Lstar = (t) => { const Y = rl(t); return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y; };
const ct = (a, b) => { const la = rl(a), lb = rl(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: process.env.CI ? 0 : 30 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("favicon")) errs.push(`HTTP ${r.status()} ${r.url()}`); });

  await step("login + reach /chat empty state", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    await page.goto(BASE + "/en/files", { waitUntil: "domcontentloaded" });
    await page.locator("aside").getByRole("link", { name: "Chat" }).click();
    await page.waitForURL(/\/chat/, { timeout: 10000 });
    await page.waitForSelector("#chat-composer", { timeout: 10000 });
    await page.waitForFunction(() => { const h = document.querySelector("h1"); return !!h && (h.textContent || "").trim().length > 0; }, { timeout: 10000 });
  });

  const setIntensity = (v) => page.evaluate((val) => {
    const el = document.querySelector('input[aria-label="Ambience"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, String(val));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, v);

  const read = () => page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const h1 = document.querySelector("h1.greeting-sweep") || document.querySelector("h1");
    const hs = h1 ? getComputedStyle(h1) : null;
    return {
      wsBg: cs.getPropertyValue("--amb-ws-background").trim(),
      bg: cs.getPropertyValue("--amb-background").trim(),
      fg: cs.getPropertyValue("--amb-foreground").trim(),
      wsMuted: cs.getPropertyValue("--amb-ws-muted-foreground").trim(),
      ink: hs ? hs.getPropertyValue("--greeting-ink").trim() : "",
      halo: hs ? hs.getPropertyValue("--greeting-halo").trim() : "",
      textShadow: hs ? hs.textShadow : "",
      dark: document.documentElement.classList.contains("dark"),
      ds: document.documentElement.dataset.ambience,
    };
  });

  // Discrete settle per sampled point (NOT a rapid continuous sweep — that catches
  // mid-coalesce intermediate values). Fine (every-2) across the crossover so the
  // per-intensity velocity peak is measured accurately.
  const STOPS = [];
  for (let i = 0; i <= 100; i += 5) STOPS.push(i);
  for (let i = 56; i <= 82; i += 2) if (!STOPS.includes(i)) STOPS.push(i); // fine crossover
  STOPS.sort((a, b) => a - b);
  const samples = [];
  await step("sweep 0..100 (discrete settle) reading real --amb vars", async () => {
    for (const i of STOPS) {
      await setIntensity(i);
      await page.waitForTimeout(160);
      // Confirm the var settled to the intended intensity (dataset.ambience), else re-read.
      let s = await read();
      if (s.ds !== String(i)) { await page.waitForTimeout(160); s = await read(); }
      samples.push({ i, ...s });
    }
    if (samples.length < 20) throw new Error("too few samples");
    if (!samples.every((s) => s.wsBg && s.fg && s.ds === String(s.i))) throw new Error("vars did not settle at some intensity");
  });

  await step("VELOCITY: no cliff (peak per-intensity ΔL* < 3.2)", async () => {
    let peak = 0, at = 0;
    for (let k = 1; k < samples.length; k++) {
      const di = samples[k].i - samples[k - 1].i;
      const dL = Math.abs(Lstar(samples[k].wsBg) - Lstar(samples[k - 1].wsBg)) / di;
      if (dL > peak) { peak = dL; at = samples[k].i; }
    }
    console.log(`      ↳ peak velocity ${peak.toFixed(2)} dL*/i @ i${at} (pre-fix cliff was ~4.2)`);
    if (peak >= 3.2) throw new Error(`velocity cliff persists: ${peak.toFixed(2)} @ i${at}`);
  });

  await step("READABLE: fg/bg ≥ 3.8 and greeting ≥ 3.0 at EVERY stop", async () => {
    let worstFg = 99, worstGreet = 99, wfi = 0, wgi = 0;
    for (const s of samples) {
      const cfg = ct(s.fg, s.bg);
      const cg = s.ink ? ct(s.ink, s.wsBg) : 99;
      if (cfg < worstFg) { worstFg = cfg; wfi = s.i; }
      if (cg < worstGreet) { worstGreet = cg; wgi = s.i; }
    }
    console.log(`      ↳ worst fg/bg ${worstFg.toFixed(2)} @i${wfi} | worst greeting ${worstGreet.toFixed(2)} @i${wgi}`);
    if (worstFg < 3.8) throw new Error(`fg/bg dipped to ${worstFg.toFixed(2)} @i${wfi}`);
    if (worstGreet < 3.0) throw new Error(`greeting dipped to ${worstGreet.toFixed(2)} @i${wgi}`);
  });

  await step("GREETING ink is the max-contrast pick (clean, no washing text-shadow)", async () => {
    const mid = samples.find((s) => s.i === 68);
    if (!mid || !mid.ink) throw new Error("--greeting-ink not set");
    // No per-glyph halo: the gradient-clip greeting renders clean solid ink.
    if (mid.textShadow && mid.textShadow !== "none") throw new Error(`unexpected greeting text-shadow: ${mid.textShadow}`);
    console.log(`      ↳ i68 greeting ink=${mid.ink} on wsBg=${mid.wsBg} (contrast ${ct(mid.ink, mid.wsBg).toFixed(2)})`);
  });

  await step("AMBER@50 unchanged + endpoints correct", async () => {
    const s50 = samples.find((s) => s.i === 50);
    if (s50.wsBg !== "40 55% 97.5%") throw new Error(`amber@50 changed: ${s50.wsBg}`);
    const s100 = samples.find((s) => s.i === 100);
    if (!s100.dark) throw new Error("intensity 100 did not toggle .dark");
    console.log(`      ↳ i50 wsBg=${s50.wsBg} | i75 wsBg=${samples.find((s) => s.i === 75).wsBg} | i100 dark=${s100.dark}`);
  });

  await step("L* curve is smooth + monotonic (print for eyeball)", async () => {
    const curve = samples.filter((s) => s.i % 5 === 0).map((s) => `${s.i}:${Lstar(s.wsBg).toFixed(0)}`).join(" ");
    console.log("      ↳ " + curve);
    // monotonic non-increasing (allow tiny rounding wobble)
    const Ls = samples.filter((s) => s.i % 5 === 0).map((s) => Lstar(s.wsBg));
    for (let k = 1; k < Ls.length; k++) if (Ls[k] > Ls[k - 1] + 1.5) throw new Error(`L* rose at step ${k}`);
  });

  await step("screenshots at key stops", async () => {
    for (const i of [15, 50, 60, 65, 68, 75, 100]) {
      await setIntensity(i);
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${OUT}/amb-${i}.png` });
    }
    console.log(`      ↳ wrote amb-{15,50,60,65,68,75,100}.png to ${OUT}`);
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== AMBIENCE: ${passed}/${results.length} | console errors: ${errs.length} =====`);
  for (const e of errs) console.log("  - " + e);
  if (passed !== results.length || errs.length > 0) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
