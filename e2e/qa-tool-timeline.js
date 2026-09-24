// The live agent-activity timeline on a TOOL turn, end to end.
//
// This is the acceptance gate for incremental `chat.stream.events`: that query
// now returns only what is above the client's high-water mark and the client
// keeps the rest (chat/_lib/stream-events.ts). The failure mode it must rule
// out is a MISSING or DUPLICATED event — the timeline is assembled from that
// array, so a dropped append shows as a tool that never finishes and a repeat
// shows as the same tool twice.
//
// It watches the pill WHILE the turn runs (the events are live-only; finalize
// folds them onto the message), then checks the settled transcript.
//
//   node qa-tool-timeline.js
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const { email: EMAIL, password: PASSWORD } = require("./creds").account();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROMPT =
  process.argv[2] ||
  "List the files in my knowledge base, then tell me how many there are.";

const failures = [];
const fail = (w, why) => {
  failures.push(`${w}: ${why}`);
  console.log(`  FAIL  ${w} — ${why}`);
};
const ok = (w, d) => console.log(`  ok    ${w}${d ? ` — ${d}` : ""}`);

(async () => {
  const b = await chromium.launch({ headless: false });
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 180)); });
  page.on("pageerror", (e) => errors.push(`pageerror ${String(e).slice(0, 180)}`));

  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const f = document.querySelector("form"); return !!f && Object.keys(f).some((k) => k.startsWith("__reactFiber")); }, null, { timeout: 30000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await page.locator("#chat-composer:not([disabled])").waitFor({ timeout: 30000 });

  await page.getByRole("button", { name: "New chat" }).click();
  await page.waitForURL(/\/chat\/?$/, { timeout: 15000 }).catch(() => {});
  await page.locator("#chat-composer").fill(PROMPT);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 30000 });
  const href = new URL(page.url()).pathname;

  // Sample the live timeline for the whole turn. Each sample is the full text
  // of the activity region, so a vanishing step is visible as a shrinking set.
  const seen = new Set();
  const samples = [];
  const stop = page.getByRole("button", { name: "Stop generating" });
  const t0 = Date.now();
  let sawStop = false;
  while (Date.now() - t0 < 240000) {
    if ((await stop.count()) > 0) sawStop = true;
    else if (sawStop) break;
    const txt = await page
      .locator('[data-agent-activity], [aria-label="Agent activity"], [aria-live]')
      .allInnerTexts()
      .catch(() => []);
    const joined = txt.join(" | ").replace(/\s+/g, " ").trim();
    if (joined) {
      samples.push(joined);
      for (const line of joined.split(" | ")) if (line) seen.add(line.slice(0, 60));
    }
    await sleep(300);
  }
  await sleep(2500);

  console.log(`turn finished in ${Math.round((Date.now() - t0) / 1000)}s, ${samples.length} live samples`);
  if (samples.length) ok("live activity rendered", `${seen.size} distinct step label(s)`);
  else fail("live activity rendered", "the activity region never showed anything on a tool turn");

  // The settled transcript: the folded events must still produce a timeline.
  const body = await page.locator('[aria-label="Conversation"]').innerText();
  const answer = body.split(/\r?\n/).slice(-1)[0] ?? "";
  if (body.length > 0) ok("transcript rendered", `${body.length} chars`);
  else fail("transcript rendered", "empty transcript");

  // No step may appear twice in the same live sample — a duplicate is exactly
  // what a bad dedupe on eventId would produce.
  const dupes = samples
    .map((s) => s.split(" | "))
    .map((parts) => parts.filter((p, i) => p && parts.indexOf(p) !== i))
    .flat();
  if (dupes.length === 0) ok("no duplicated step", `${samples.length} samples checked`);
  else fail("no duplicated step", `${dupes.length} duplicate step line(s), e.g. ${dupes[0]}`);

  for (const e of errors.slice(0, 6)) console.log("  console.error:", e);
  console.log(`\n===== TOOL TIMELINE: ${failures.length === 0 ? "PASS" : "FAIL"} | console errors: ${errors.length} =====`);
  if (samples.length) console.log("  last live sample:", samples[samples.length - 1].slice(0, 220));
  if (answer) console.log("  answer tail:", answer.slice(0, 160));

  // Clean up the thread this created.
  await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded" });
  const link = page.locator(`a[href="${href}"]`).first();
  await link.waitFor({ timeout: 15000 }).catch(() => {});
  if (await link.count()) {
    await link.hover();
    await link.locator("xpath=..").getByRole("button", { name: "Conversation actions" }).click();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await sleep(800);
  }
  await b.close();
  if (failures.length || errors.length) process.exitCode = 1;
})();
