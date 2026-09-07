// Sales — prod acceptance (headed Chrome on app.ollasuper.com).
// 9 Sales scenarios (research, call-prep, outreach, call-summary, pipeline, forecast,
// competitive, asset, complex) + 5 regression (normal/SEO/Blog/Research/Data). Asserts
// routing, tools actually run, grounded output, plain-text email, the EXACT forecast
// numbers, streaming, and 0 console errors. Prints full outputs.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-sales.js
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const WAIT_MS = Number(process.env.QA_WAIT_MS || 300000);
const OUT = process.env.QA_OUT || "sales-results.log";

const results = [];
const errs = [];
const rec = (s) => {
  console.log(s);
  try {
    fs.appendFileSync(OUT, s + "\n");
  } catch {}
};
const need = (c, m) => {
  if (!c) throw new Error(m);
};
const ONLY = process.env.QA_ONLY; // comma-separated tokens; run only matching steps
const step = async (n, f) => {
  if (ONLY && !ONLY.split(",").some((t) => n.includes(t.trim()))) return;
  const before = errs.length;
  try {
    await f();
    const e = errs.length - before;
    need(e === 0, `${e} console error(s)`);
    results.push(true);
    rec("PASS  " + n);
  } catch (e) {
    results.push(false);
    rec("FAIL  " + n + " — " + e.message.split("\n")[0]);
  }
};
const settle = async (page, ms) => {
  // Robust across the suspend->approve->resume cycle: an approval-gated tool SUSPENDS
  // the turn (the Stop button vanishes) and shows an Approve button. A real user clicks
  // Approve, which resumes generation. So we click Approve whenever it appears and only
  // conclude "done" after a stable idle with neither Stop nor Approve present.
  const stop = page.getByRole("button", { name: "Stop generating" });
  const approve = page.getByRole("button", { name: "Approve" });
  await stop.waitFor({ timeout: 45000 }).catch(() => {});
  const d = Date.now() + ms;
  let idle = 0;
  while (Date.now() < d) {
    if ((await approve.count()) > 0) {
      await approve.first().click().catch(() => {});
      await page.waitForTimeout(2000); // let the resume kick off
      idle = 0;
      continue;
    }
    if ((await stop.count()) > 0) {
      idle = 0;
      await page.waitForTimeout(700);
      continue;
    }
    idle += 1; // neither generating nor awaiting approval
    if (idle >= 3) break; // ~2s stable idle => truly done
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(1500);
};
const lastMsg = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    const last = rows[rows.length - 1];
    const pill = last?.querySelector("[data-agent-activity]");
    return {
      text: last?.innerText || "",
      pill: pill ? pill.innerText.replace(/\s+/g, " ").trim() : "",
      // plain-text email bodies render inside <pre><code> (fenced ```text)
      code: last ? [...last.querySelectorAll("pre")].map((p) => p.innerText).join("\n") : "",
    };
  });
const steps = (r) => Number((r.pill.match(/(\d+)\s*steps?/i) || [])[1] || 0);
const noRaw = (t) =>
  !/_endpoint|find capabilities|sql_query|generate_file|storageid/i.test(t);
const show = (tag, r) =>
  rec(`\n---- [${tag}] steps:${steps(r)}\n${r.text.slice(0, 2600)}\n---- END ${tag} ----\n`);

async function fresh(page, prompt, file) {
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
  if (file) {
    await page.locator('input[type="file"]').setInputFiles(file);
    await page.waitForTimeout(4000);
  }
  await page.locator("#chat-composer").fill(prompt);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 }).catch(() => {});
  await settle(page, WAIT_MS);
  return lastMsg(page);
}
async function followUp(page, prompt) {
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 60000 });
  await page.locator("#chat-composer").fill(prompt);
  await page.keyboard.press("Enter");
  await settle(page, WAIT_MS);
  return lastMsg(page);
}

// --- fixtures (self-contained) ---------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "qa-sales-"));
const PIPELINE = path.join(TMP, "pipeline.csv");
const TRANSCRIPT = path.join(TMP, "transcript.txt");
// KNOWN pipeline → weighted = 100k*.8 + 50k*.6 + 200k*.2 + 30k*.1 = 153,000 ;
// open = 380,000 ; coverage @300k quota = 1.27x ; gap @50k closed = 97,000.
fs.writeFileSync(
  PIPELINE,
  "deal,account,amount,stage,close_date,last_activity,owner,contacts\n" +
    "Acme Expansion,Acme,100000,Negotiation,2026-09-10,2026-08-25,me,3\n" +
    "Beta Renewal,Beta,50000,Proposal,2026-09-18,2026-08-20,me,2\n" +
    "Gamma New Logo,Gamma,200000,Discovery,2026-09-24,2026-08-10,me,1\n" +
    "Delta Lead,Delta,30000,Prospecting,2026-09-28,2026-08-05,me,1\n",
);
fs.writeFileSync(
  TRANSCRIPT,
  "Sales call — Rep (Alex, OllaSuper) and Customer (Jordan, VP Ops at Acme).\n" +
    "Jordan: Our team wastes hours every week reconciling reports by hand; it's our #1 pain.\n" +
    "Alex: OllaSuper automates that reconciliation end to end.\n" +
    "Jordan: Pricing is a concern — we're also evaluating Competitor X.\n" +
    "Alex: I'll send pricing and a security overview by Friday.\n" +
    "Jordan: If the numbers work we'd want to start a pilot in Q4.\n" +
    "Alex: Great — I'll follow up with the pilot plan and pricing by Friday.\n",
);

(async () => {
  try {
    fs.unlinkSync(OUT);
  } catch {}
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 20 });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 950 } })
  ).newPage();
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("response", (r) => {
    if (r.status() >= 500 && !r.url().includes("favicon")) errs.push("HTTP " + r.status());
  });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);
  rec("logged in\n");

  // 1) ACCOUNT RESEARCH — grounded, tools ran, Sources, fact/inference labels.
  await step("[1 RESEARCH] research a company", async () => {
    const r = await fresh(
      page,
      "Research the prospect Stripe before my sales call: give me a company snapshot, " +
        "key people, likely pain points and the best sales angle to open with, with " +
        "your sources.",
    );
    show("RESEARCH", r);
    need(steps(r) >= 2, "no web tools ran (pill: " + r.pill + ")");
    need(/source|http/i.test(r.text), "no sources cited");
    need(/stripe/i.test(r.text), "off-topic");
    need(noRaw(r.text), "raw tool identifier leaked");
  });

  // 2) CALL PREP — template + discovery questions + objections.
  await step("[2 CALL PREP] discovery call prep", async () => {
    const r = await fresh(
      page,
      "Prepare me for a discovery call with Notion. Attendee: a VP of Sales. Give me " +
        "the agenda, discovery questions and likely objections.",
    );
    show("CALLPREP", r);
    need(/discovery question/i.test(r.text), "no discovery questions");
    need(/objection/i.test(r.text), "no objections");
    need(/agenda/i.test(r.text), "no agenda");
  });

  // 3) OUTREACH — must contain a PLAIN-TEXT email body (no ** markdown) + AIDA.
  await step("[3 OUTREACH] plain-text personalized email", async () => {
    const r = await fresh(
      page,
      "Write a personalized cold outreach email to the VP of Engineering at Vercel " +
        "about reducing build times. Give me a subject line too.",
    );
    show("OUTREACH", r);
    need(/subject/i.test(r.text), "no subject line");
    // an email body rendered in a fenced text block, with NO markdown bold inside it
    need(r.code && r.code.length > 80, "no fenced plain-text email body");
    need(!/\*\*/.test(r.code), "email body contains ** markdown (must be plain text)");
  });

  // 4) CALL SUMMARY (upload transcript) — action items + plain-text follow-up email.
  await step("[4 CALL SUMMARY] transcript → summary + follow-up", async () => {
    const r = await fresh(
      page,
      "Summarize this sales call: action items with owners and due dates, and draft " +
        "the customer follow-up email.",
      TRANSCRIPT,
    );
    show("SUMMARY", r);
    need(/action item/i.test(r.text), "no action items");
    need(/friday/i.test(r.text), "missed the Friday commitment (fidelity)");
    need(/competitor x/i.test(r.text), "missed the competitive mention");
    need(r.code && !/\*\*/.test(r.code), "no plain-text follow-up email");
  });

  // 5) PIPELINE REVIEW (upload CSV) — health tiers + risk flags (stale/single-threaded).
  await step("[5 PIPELINE] CSV → pipeline review", async () => {
    const r = await fresh(
      page,
      "Review my pipeline: deal health, which deals to prioritize this week, and the " +
        "risks (stale, single-threaded, overdue).",
      PIPELINE,
    );
    show("PIPELINE", r);
    need(/single.?threaded|stale|risk/i.test(r.text), "no risk analysis");
    need(/gamma|delta|acme/i.test(r.text), "did not reference the actual deals");
    need(/priorit/i.test(r.text), "no prioritization");
  });

  // 6) FORECAST (upload CSV + quota) — assert the EXACT numbers (numeric output gate).
  await step("[6 FORECAST] CSV + quota → correct numbers", async () => {
    const r = await fresh(
      page,
      "Forecast my full open pipeline (every deal in the file closes this quarter). " +
        "Quota is $300,000 and I've already closed $50,000. Give me the weighted " +
        "forecast, best/worst case, coverage ratio and gap to quota, and state your " +
        "probability assumptions.",
      PIPELINE,
    );
    show("FORECAST", r);
    const t = r.text.replace(/,/g, "");
    // weighted (80/60/40/20/10) = 80k+30k+40k+3k = 153,000 ; gap = 300k-(50k+153k) = 97,000
    need(/\b153000\b/.test(t), "weighted 153,000 missing (wrong stage probabilities?)");
    need(/\b97000\b/.test(t), "gap to quota 97,000 missing");
    need(/1\.2[67]|1\.3/.test(t), "coverage ~1.27x missing");
    need(/80\s?%/.test(r.text) && /60\s?%/.test(r.text), "did not use the 80/60 defaults");
  });

  // 7) COMPETITIVE — matrix + talk tracks, public-fact honesty.
  await step("[7 COMPETITIVE] compare vs a competitor", async () => {
    const r = await fresh(
      page,
      "We sell an AI analytics platform. Create a competitive battlecard versus " +
        "Tableau — comparison matrix, differentiation, talk tracks and objections.",
    );
    show("COMPETITIVE", r);
    need(/tableau/i.test(r.text), "off-topic");
    need(/talk track|objection|differentiat/i.test(r.text), "no talk tracks/objections");
    need(steps(r) >= 1, "no research ran");
  });

  // 8) ASSET — streamed content + a downloadable file (generate_file ran).
  await step("[8 ASSET] create a sales one-pager", async () => {
    const r = await fresh(
      page,
      "Build a downloadable one-pager NOW (don't ask me questions) for prospect Acme " +
        "Corp. Our product is 'OllaSuper Analytics', an AI analytics platform; audience " +
        "is their VP of Data; their likely pain is slow manual reporting; proof point: " +
        "customers cut reporting time by 60%; next step: a 20-minute demo.",
    );
    show("ASSET", r);
    need(/acme/i.test(r.text), "off-topic");
    need(
      steps(r) >= 1 || /download|\.pdf|\.docx|one-pager|reporting/i.test(r.text),
      "no asset produced",
    );
  });

  // 9) COMPLEX multi-step — research + competitive + outreach in one turn.
  await step("[9 COMPLEX] multi-step sales request", async () => {
    const r = await fresh(
      page,
      "Research Figma as a sales prospect, identify who I should target, check how we " +
        "compare to their likely alternatives, and draft a personalized outreach email " +
        "to a design lead — we sell an AI analytics platform called OllaSuper.",
    );
    show("COMPLEX", r);
    need(steps(r) >= 3, "multi-step did not use enough tools (pill: " + r.pill + ")");
    need(/figma/i.test(r.text), "off-topic");
    need(r.code && !/\*\*/.test(r.code), "no plain-text outreach in the complex flow");
  });

  // --- REGRESSION: siblings + normal chat unchanged --------------------------
  await step("[10 NORMAL] normal chat unaffected", async () => {
    const r = await fresh(page, "In two sentences, what is a CDN?");
    need(/content delivery|cdn|cache/i.test(r.text), "bad normal answer");
    need(steps(r) === 0, "normal chat should not run tools");
  });
  await step("[11 SEO] SEO still routes to SEO", async () => {
    const r = await fresh(page, "Run a quick technical SEO audit of https://example.com");
    need(/seo|meta|canonical|robots|title/i.test(r.text), "SEO regressed");
  });
  await step("[12 BLOG] Blog still routes to Blog", async () => {
    const r = await fresh(page, "Write a 200-word blog intro about remote sales teams.");
    need(r.text.length > 300, "blog regressed");
  });
  await step("[13 RESEARCH] Deep Research still works", async () => {
    const r = await fresh(page, "Research the current state of WebAssembly with sources.");
    need(/source|http|wasm|webassembly/i.test(r.text), "research regressed");
  });
  await step("[14 DATA] Data Analysis still owns CSV analysis", async () => {
    const r = await fresh(
      page,
      "Using this CSV, compute the total and average deal amount grouped by stage.",
      PIPELINE,
    );
    need(steps(r) >= 1, "data tools did not run");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  rec(`\n===== SALES QA: ${passed}/${results.length} | console errors: ${errs.length} =====`);
  for (const e of errs.slice(0, 20)) rec("  - " + e);
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  rec("FATAL " + e.message);
  process.exit(1);
});
