// PROD streaming acceptance: prove skill/tool-bound answers stream INCREMENTALLY
// (many deltas over time), exactly like a normal prompt — not single-shot.
//
//   E2E_BASE_URL=https://app.ollasuper.com node qa-stream-verify.js
//
// Method: while the assistant is generating, poll the last assistant message's text
// length every 100ms. A SINGLE-SHOT answer jumps 0 -> full in one step (1 growth,
// one jump = ~100% of the content). Genuine streaming grows in MANY small steps
// spread over time. We assert: >=4 growth steps, spread >=800ms, and no single step
// delivers >=90% of the final text.
const { chromium } = require("playwright");
const fs = require("fs");

const OUT = process.env.QA_OUT || "stream-verify-results.log";
const rec = (line) => {
  console.log(line);
  try {
    fs.appendFileSync(OUT, line + "\n");
  } catch {}
};

// Heuristic duplication check: the anti-dup fix must ensure the streamed preamble is
// not re-emitted. Flag any 48-char window that appears >2 times (headings/short
// boilerplate can repeat once or twice; a duplicated preamble repeats a long run).
function dupSignal(text) {
  const t = text.replace(/\s+/g, " ");
  const W = 48;
  const seen = new Map();
  let worst = 0;
  let worstStr = "";
  for (let i = 0; i + W <= t.length; i += 8) {
    const s = t.slice(i, i + W);
    const c = (seen.get(s) || 0) + 1;
    seen.set(s, c);
    if (c > worst) {
      worst = c;
      worstStr = s;
    }
  }
  return { worst, worstStr };
}

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const TARGET = process.env.QA_TARGET || "https://www.networkershome.com/";

const errs = [];
const summary = [];

// The assistant text body is StreamingText's <div aria-live aria-atomic="false">
// (verified against the live prod DOM). Before the first token it is a
// TypingIndicator (absent), so length stays 0 during tool execution and grows once
// the answer streams — exactly the incremental signal we measure.
const SEL = "div[aria-live][aria-atomic='false']";
const lastAssistantLen = (page) =>
  page.evaluate((s) => {
    const ns = [...document.querySelectorAll(s)];
    const n = ns[ns.length - 1];
    return n ? (n.innerText || "").length : 0;
  }, SEL);

const lastAssistantText = (page) =>
  page.evaluate((s) => {
    const ns = [...document.querySelectorAll(s)];
    const n = ns[ns.length - 1];
    return n ? n.innerText || "" : "";
  }, SEL);

const generating = async (page) =>
  (await page.getByRole("button", { name: "Stop generating" }).count()) > 0;

// Poll length during generation; return the growth trace.
async function trace(page, waitMs) {
  const samples = []; // {t, len}
  const t0 = Date.now();
  // wait for generation to actually start
  const startDeadline = Date.now() + 30000;
  while (Date.now() < startDeadline && !(await generating(page))) {
    await page.waitForTimeout(100);
  }
  const deadline = Date.now() + waitMs;
  let stableEmpty = 0;
  while (Date.now() < deadline) {
    const len = await lastAssistantLen(page);
    const t = Date.now() - t0;
    if (!samples.length || samples[samples.length - 1].len !== len)
      samples.push({ t, len });
    const gen = await generating(page);
    if (!gen) {
      // one more read after completion to catch the final flush
      await page.waitForTimeout(150);
      const fin = await lastAssistantLen(page);
      if (!samples.length || samples[samples.length - 1].len !== fin)
        samples.push({ t: Date.now() - t0, len: fin });
      break;
    }
    stableEmpty = len === 0 ? stableEmpty + 1 : 0;
    await page.waitForTimeout(100);
  }
  return samples;
}

function analyze(samples) {
  const growth = [];
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].len - samples[i - 1].len;
    if (d > 0) growth.push({ t: samples[i].t, d });
  }
  const finalLen = samples.length ? samples[samples.length - 1].len : 0;
  const deltaCount = growth.length;
  const spread = growth.length
    ? growth[growth.length - 1].t - growth[0].t
    : 0;
  const maxJump = growth.reduce((m, g) => Math.max(m, g.d), 0);
  const maxJumpFrac = finalLen ? maxJump / finalLen : 1;
  return { deltaCount, spread, finalLen, maxJump, maxJumpFrac };
}

const ONLY = process.env.QA_ONLY; // run just one scenario by name when set
async function scenario(page, name, prompt, { waitMs = 240000, minLen = 120 } = {}) {
  if (ONLY && name !== ONLY) return true;
  const before = errs.length;
  // fresh thread each scenario
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 15000 });
  await page.locator("#chat-composer").fill(prompt);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 20000 }).catch(() => {});
  const samples = await trace(page, waitMs);
  const a = analyze(samples);
  const text = await lastAssistantText(page);
  const scenErrs = errs.length - before;
  const dup = dupSignal(text);
  // A streamed answer: many growth steps, spread over time, no single dominant jump.
  const streamed =
    a.deltaCount >= 4 &&
    a.spread >= 800 &&
    a.maxJumpFrac < 0.9 &&
    a.finalLen >= minLen;
  const noDup = dup.worst <= 2; // no long run repeated 3+ times
  const ok = streamed && noDup && scenErrs === 0;
  summary.push({ name, ...a, dup: dup.worst, scenErrs, ok });
  rec(
    `${ok ? "PASS" : "FAIL"}  ${name}  deltas=${a.deltaCount} spread=${a.spread}ms ` +
      `finalLen=${a.finalLen} maxJump=${a.maxJump}(${(a.maxJumpFrac * 100).toFixed(0)}%) ` +
      `dupWorst=${dup.worst} errs=${scenErrs}`,
  );
  rec("      first 200 chars: " + JSON.stringify(text.slice(0, 200)));
  if (!noDup) rec("      DUP window: " + JSON.stringify(dup.worstStr));
  return ok;
}

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 25,
  });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 950 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("console: " + m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon"))
      errs.push(`HTTP ${r.status()} ${r.url()}`);
  });

  // login
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer", { timeout: 15000 });
  console.log("logged in\n");

  // 1) NORMAL prompt — baseline (already streamed before the fix)
  await scenario(
    page,
    "normal-prompt",
    "Explain how a content delivery network works, in four short paragraphs with a heading.",
    { waitMs: 120000 },
  );

  // 2) BLOG skill — pure-text agentic skill, long answer
  await scenario(
    page,
    "blog-skill",
    "Write a 400-word blog post about the benefits of remote work, with a title and three subheadings.",
    { waitMs: 420000, minLen: 400 },
  );

  // 3) SEO skill — tool-heavy; the streamed report
  await scenario(
    page,
    "seo-skill",
    `Do a technical SEO audit of the single page ${TARGET} — title, meta, headings, ` +
      `canonical, indexability, robots, structured data — then give me the report.`,
    { waitMs: 420000, minLen: 300 },
  );

  // 4) RESEARCH skill — tool-heavy synthesis
  await scenario(
    page,
    "research-skill",
    "Research the current state of WebAssembly for server-side workloads and give me a " +
      "structured briefing with key findings and sources.",
    { waitMs: 420000, minLen: 300 },
  );

  await b.close();
  const passed = summary.filter((s) => s.ok).length;
  rec(
    `\n===== STREAM VERIFY: ${passed}/${summary.length} | total console/http errors: ${errs.length} =====`,
  );
  for (const e of errs.slice(0, 20)) rec("  - " + e);
  process.exit(passed === summary.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
