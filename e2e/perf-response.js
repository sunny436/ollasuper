// Response speed + quality benchmark, measured in the real chat UI.
//
//   QA_EMAIL=… QA_PASSWORD=… ARM=before node perf-response.js
//   ARM=after …                (same prompts, same runs, after a deploy)
//   ONLY=K2,W1 …               (a subset, by prompt id)
//
// Every turn is a FRESH chat (no carried context). TTFT = Enter -> the first
// answer text in the streaming live region (the typing indicator does not
// count); total = Enter -> the "Stop generating" button gone. Each answer is
// saved with its timings to OUT_DIR/<arm>.json for scoring and judging; every
// thread it created is deleted at the end. Sequential by design: one stream at
// a time, well under the per-user hourly generation cap.
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CONVEX = `${BASE}/__cvx`;
const ARM = process.env.ARM || "run";
const OUT = process.env.OUT_DIR || path.join(__dirname, "out", "perf-response");
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 300000);

const PROMPTS = [
  // simple — no tools expected
  { id: "S1", cat: "simple", runs: 3, text: "What is 17 × 23? Reply with the number and one line of working." },
  { id: "S2", cat: "simple", runs: 3, text: "Explain what a VPN is in 3 sentences." },
  { id: "S3", cat: "simple", runs: 3, text: "Translate 'Good morning, how are you?' into Hindi and Spanish." },
  { id: "S4", cat: "simple", runs: 3, text: "Write a haiku about the monsoon." },
  // web — current facts, search expected
  { id: "W1", cat: "web", runs: 5, text: "What is the latest stable Python release version right now?" },
  { id: "W2", cat: "web", runs: 5, text: "What are the biggest AI news stories from this week?" },
  { id: "W3", cat: "web", runs: 5, text: "What's the weather in Delhi today?" },
  { id: "W4", cat: "web", runs: 5, text: "What is the USD to INR exchange rate today?" },
  // skill — built-in skills should activate
  { id: "K1", cat: "skill", runs: 5, text: "Write a 3-email cold outreach sequence to sell SD-WAN to mid-size Indian banks." },
  { id: "K2", cat: "skill", runs: 5, text: "My SaaS has 1,200 customers paying $49/month, 3.1% monthly churn, a CAC of $310 and 78% gross margin. Compute LTV, LTV:CAC and CAC payback in months, and tell me the highest-leverage fix." },
  { id: "K3", cat: "skill", runs: 5, text: "Do a quick SEO audit of the networkershome.com homepage and give prioritized fixes." },
  { id: "K4", cat: "skill", runs: 5, text: "Write a one-page project status report for a network migration project that is 2 weeks behind schedule." },
  { id: "K5", cat: "skill", runs: 5, text: "Create an SOP with a RACI matrix for onboarding new IT support engineers." },
  // reasoning
  { id: "R1", cat: "reasoning", runs: 3, text: "Compare TCP and UDP for live video streaming in a table and recommend one." },
  { id: "R2", cat: "reasoning", runs: 3, text: "My Python script's CPU usage climbs to 100% and it gets slower over hours. List the likely causes and how to diagnose each." },
];

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const f = document.querySelector("form");
    return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber"));
  }, null, { timeout: 30000 });
  await page.locator('input[type="email"]').first().fill(process.env.QA_EMAIL);
  await page.locator('input[type="password"]').first().fill(process.env.QA_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 90000, waitUntil: "commit" });
}

async function convex(jwt, kind, fn, args) {
  const r = await fetch(`${CONVEX}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ path: fn, args, format: "json" }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.status !== "error", value: j.value, error: j.errorMessage };
}

async function oneTurn(page, prompt) {
  await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
  const box = page.locator("#chat-composer");
  await box.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => {
    const t = document.querySelector("#chat-composer");
    return !!t && !t.disabled;
  }, null, { timeout: 30000 });
  await box.fill(prompt.text);
  const t0 = Date.now();
  await page.keyboard.press("Enter");
  let ttft = null;
  let lastStreamText = "";
  const stop = page.getByRole("button", { name: "Stop generating" });
  // Poll: first streamed answer text, then the stream finishing.
  let sawStop = false;
  while (Date.now() - t0 < TURN_TIMEOUT_MS) {
    const s = await page.evaluate(() => {
      const live = [...document.querySelectorAll('[aria-live="polite"][aria-busy="true"]')];
      const txt = live.map((n) => n.innerText.trim()).filter(Boolean).pop() || "";
      return { txt };
    });
    if (s.txt) {
      if (ttft === null) ttft = Date.now() - t0;
      lastStreamText = s.txt;
    }
    const stopping = (await stop.count()) > 0;
    if (stopping) sawStop = true;
    if (sawStop && !stopping) break;
    // A reply fast enough to finish between two polls never shows Stop.
    if (!sawStop && Date.now() - t0 > 15000) {
      const idle = await page.evaluate(() => !document.querySelector('[aria-busy="true"]'));
      if (idle) break;
    }
    await page.waitForTimeout(100);
  }
  const total = Date.now() - t0;
  await page.waitForTimeout(1200); // the finalised message replaces the stream
  const final = await page.evaluate(() => {
    const log = document.querySelector('[aria-label="Conversation"]');
    if (!log) return "";
    const kids = [...log.querySelectorAll(":scope > * , :scope > * > *")];
    return (log.innerText || "").trim();
  });
  const url = page.url();
  const threadId = (url.match(/\/chat\/([a-z0-9]+)/) || [])[1] || null;
  // The transcript holds the user's own prompt first; keep what follows it.
  const at = final.indexOf(prompt.text);
  const answer = at >= 0 ? final.slice(at + prompt.text.length).trim() : final;
  return {
    ttft_ms: ttft ?? (answer ? total : null),
    total_ms: total,
    timed_out: total >= TURN_TIMEOUT_MS,
    chars: answer.length,
    answer: answer || lastStreamText,
    threadId,
  };
}

(async () => {
  if (!process.env.QA_EMAIL || !process.env.QA_PASSWORD) throw new Error("QA_EMAIL and QA_PASSWORD must be set");
  fs.mkdirSync(OUT, { recursive: true });
  const only = (process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const plan = PROMPTS.filter((p) => !only.length || only.includes(p.id));
  const browser = await chromium.launch({ headless: process.env.HEADLESS === "1" });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  await login(page);
  const rows = [];
  const file = path.join(OUT, `${ARM}.json`);
  for (const p of plan) {
    for (let r = 1; r <= p.runs; r++) {
      let row;
      try {
        row = await oneTurn(page, p);
      } catch (e) {
        row = { error: String(e.message || e).slice(0, 200) };
      }
      rows.push({ arm: ARM, id: p.id, cat: p.cat, run: r, prompt: p.text, at: new Date().toISOString(), ...row });
      fs.writeFileSync(file, JSON.stringify(rows, null, 1));
      const x = rows[rows.length - 1];
      console.log(`${ARM} ${p.id}#${r} ttft=${x.ttft_ms ?? "-"} total=${x.total_ms ?? "-"} chars=${x.chars ?? "-"}${x.error ? " ERROR " + x.error : ""}`);
    }
  }
  // Clean up every thread this run created.
  const jwt = (await ctx.cookies()).find((k) => /convexAuthJWT/i.test(k.name))?.value;
  let removed = 0;
  for (const t of new Set(rows.map((x) => x.threadId).filter(Boolean))) {
    if ((await convex(jwt, "mutation", "chat/threads:remove", { threadId: t })).ok) removed++;
  }
  await browser.close();
  console.log(`\n${ARM}: ${rows.length} turns saved to ${file}; threads removed ${removed}; console errors ${errors.length}`);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
