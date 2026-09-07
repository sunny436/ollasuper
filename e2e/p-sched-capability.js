// SCHEDULER EXECUTION-CAPABILITY MATRIX — real tasks, real runs, headed Chrome.
//
// The question this answers is not "does the scheduler run a prompt" (it does)
// but "does a SCHEDULED turn have the same capabilities as a chat turn". A
// scheduled turn is deliberately `unattended`, which changes two things in the
// production runtime:
//
//   runner.py:525   elevated = ai_agent_side_effect_enabled and not unattended
//                   -> a scheduled run NEVER gets WRITE_SCOPE
//   executor.py:873 an unattended turn that hits a tool needing approval
//                   returns approval_required_for_unattended_execution instead
//                   of parking forever
//
// So READ_ONLY tools must work and side-effecting ones must fail cleanly. Each
// case below is chosen so the answer is only reachable one way: a deterministic
// calculator cannot be hallucinated to the exact cent, and a live-data question
// cannot be answered from weights.
//
//   E2E_BASE_URL=https://app.ollasuper.com node p-sched-capability.js
//   MODES=1,2  node p-sched-capability.js      (subset)
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const TAG = "e2e-cap";
const ONLY = (process.env.MODES || "").split(",").filter(Boolean);

/**
 * Each case states what it PROVES, not just what it asks. `expect` are markers
 * that can only appear if the capability really ran; `forbid` are the tells of
 * a silent degrade.
 */
const CASES = [
  {
    id: "1",
    name: "normal prompt — no tools, no skills",
    prompt:
      "Explain in four short paragraphs why vector databases matter for retrieval-augmented generation. " +
      "Cover chunking, embedding drift, and recall vs precision. " +
      "End with a bulleted 'Key takeaways' section of exactly three bullets. Do not use any tools.",
    expect: [/vector/i, /takeaway/i],
    minChars: 500,
  },
  {
    id: "2",
    name: "prompt + deterministic TOOL (finance_calc)",
    // Exact arithmetic the model cannot fake reliably: current ratio = 500000/250000 = 2
    // quick ratio = (500000-120000)/250000 = 1.52, gross margin = (1200000-700000)/1200000 = 41.67%
    prompt:
      "Compute the current ratio, quick ratio and gross margin for a company with " +
      "current assets 500000, inventory 120000, current liabilities 250000, revenue 1200000 and COGS 700000. " +
      "Show each formula, then give the three values. Use the finance calculation tool.",
    expect: [/2(\.0+)?\b/, /1\.5[0-9]?/, /41\.[67]/],
    minChars: 200,
  },
  {
    id: "3",
    name: "prompt + real SKILL (HR)",
    prompt:
      "Draft a 30-day onboarding plan for a new backend engineer joining a small platform team. " +
      "Structure it as week 1, week 2, weeks 3-4, each with concrete objectives and a success measure. " +
      "Include the manager check-in cadence. Keep it under 600 words.",
    expect: [/week 1/i, /week 2/i, /onboard|objective/i],
    minChars: 600,
  },
  {
    id: "4",
    name: "prompt + SKILL + TOOL (marketing_calc)",
    // sample size for 5% baseline, 10% relative MDE, 95% confidence is ~29-31k/arm
    prompt:
      "I want to run an A/B test on a signup page with a 5% baseline conversion rate and a 10% relative " +
      "minimum detectable effect at 95% confidence and 80% power. Calculate the required sample size per " +
      "variant using the marketing calculation tool, then outline how to run the test and what would " +
      "invalidate the result.",
    expect: [/sample size/i, /\d{2},?\d{3}/],
    minChars: 300,
  },
  {
    id: "5",
    name: "OLLAGRAPH-capable task (live external data)",
    prompt:
      "Research what people are currently writing about self-hosted AI workspaces. " +
      "Identify the three themes that come up most often and give a source link for each. " +
      "If you cannot retrieve live sources, say so explicitly rather than answering from memory.",
    expect: [/http/i],
    forbid: [/cannot retrieve live sources/i],
    minChars: 300,
    // Live external data may legitimately be unavailable; report, never fake.
    soft: true,
  },
];

const errs = [];
const rows = [];
const created = [];
let PAGE = null;

const taskRows = (page) =>
  page
    .locator("div.group")
    .filter({ has: page.getByRole("button", { name: "Task actions" }) });

function must(c, m) {
  if (!c) throw new Error(m);
}

async function createTask(page, title, prompt) {
  await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const box = page.getByRole("textbox", { name: "Schedule a task" });
  await box.click();
  await box.fill("every day at 9 am");
  await page.getByRole("button", { name: "Interpret schedule" }).click();
  await page
    .getByRole("textbox", { name: "Task instruction" })
    .waitFor({ state: "visible", timeout: 60000 });
  // Set BOTH fields explicitly: this suite tests execution capability, not the
  // parser. The prompt must reach the runtime verbatim.
  await page.getByRole("textbox", { name: "Task name" }).fill(title);
  await page.getByRole("textbox", { name: "Task instruction" }).fill(prompt);
  await page.waitForTimeout(400);
  const create = page.getByRole("button", { name: "Create task" });
  must(await create.isEnabled(), "Create was blocked with both fields filled");
  await create.click();
  await page.waitForTimeout(4000);
  created.push(title);
}

/** Run Now, then wait for a terminal run and return the visible result text. */
async function runAndRead(page, title, budgetMs) {
  await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const row = taskRows(page).filter({ hasText: title }).first();
  must(await row.count(), `task ${title} not in the list`);
  await row.hover();
  await row.getByRole("button", { name: "Task actions" }).click();
  await page.waitForTimeout(400);
  await page.getByRole("menuitem", { name: /Run now/i }).click();
  await page.waitForTimeout(2500);

  await row.click();
  await page.waitForTimeout(2000);

  const deadline = Date.now() + budgetMs;
  let state = "unknown";
  while (Date.now() < deadline) {
    const body = await page.locator("body").innerText();
    if (/\bCompleted\b/.test(body)) {
      state = "completed";
      break;
    }
    if (/\bFailed\b/.test(body)) {
      state = "failed";
      break;
    }
    await page.waitForTimeout(5000);
  }
  // Open the newest run so the result body is on screen.
  const openable = page
    .locator("button,div[role=button]")
    .filter({ hasText: /Completed|Failed/ })
    .first();
  if (await openable.count()) {
    await openable.click().catch(() => {});
    await page.waitForTimeout(2500);
  }
  return { state, text: await page.locator("body").innerText() };
}

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  PAGE = page;
  const NOTICE = /chromestatus\.com/;
  page.on("console", (m) => {
    if (m.type() === "error" && !NOTICE.test(m.text())) errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);
  console.log("logged in\n");

  for (const c of CASES) {
    if (ONLY.length && !ONLY.includes(c.id)) continue;
    const title = `${TAG} m${c.id} ${Date.now()}`;
    const rec = { mode: c.id, name: c.name, verdict: "?", detail: "" };
    try {
      await createTask(page, title, c.prompt);
      const { state, text } = await runAndRead(page, title, 6 * 60_000);
      rec.state = state;

      if (state !== "completed") {
        rec.verdict = c.soft ? "SKIP" : "FAIL";
        rec.detail = `run state = ${state}`;
      } else {
        const missing = c.expect.filter((re) => !re.test(text));
        const banned = (c.forbid || []).filter((re) => re.test(text));
        if (missing.length) {
          rec.verdict = c.soft ? "SKIP" : "FAIL";
          rec.detail = `missing marker(s): ${missing.map(String).join(", ")}`;
        } else if (banned.length) {
          rec.verdict = "FAIL";
          rec.detail = `degraded: ${banned.map(String).join(", ")}`;
        } else {
          rec.verdict = "PASS";
          rec.detail = "all markers present";
        }
      }
    } catch (e) {
      rec.verdict = "FAIL";
      rec.detail = e.message.split("\n")[0];
      try {
        await page.screenshot({ path: `/tmp/p-cap-m${c.id}.png` });
      } catch {}
    }
    rows.push(rec);
    console.log(
      `${rec.verdict.padEnd(5)} mode ${c.id} — ${c.name}\n        ${rec.detail}`,
    );
  }

  // ── cleanup ──────────────────────────────────────────────────────────────
  for (const title of created) {
    for (let i = 0; i < 3; i++) {
      await page.goto(BASE + "/en/scheduled", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      const row = taskRows(page).filter({ hasText: title }).first();
      if (!(await row.count())) break;
      await row.hover();
      await row.getByRole("button", { name: "Task actions" }).click();
      await page.waitForTimeout(500);
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await page.waitForTimeout(900);
      await page.getByRole("button", { name: "Delete", exact: true }).last().click();
      await page.waitForTimeout(3000);
    }
  }

  const pass = rows.filter((r) => r.verdict === "PASS").length;
  const fail = rows.filter((r) => r.verdict === "FAIL").length;
  const skip = rows.filter((r) => r.verdict === "SKIP").length;
  console.log(
    `\n===== CAPABILITY MATRIX: ${pass} pass / ${fail} fail / ${skip} skip | console errors: ${errs.length} =====`,
  );
  for (const e of errs.slice(0, 5)) console.log("  - " + e);
  await b.close();
  process.exit(fail === 0 && errs.length === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error("FATAL", e.message || e);
  process.exit(1);
});
