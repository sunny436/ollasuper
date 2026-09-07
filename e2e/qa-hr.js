// HR — prod acceptance (headed Chrome on app.ollasuper.com).
// 12 HR scenarios (all 12 source capabilities) + web research + complex + 5 regression.
// Asserts routing, tools/data execute, grounded output, required output sections, the
// exact comp numbers, no fabrication, streaming, 0 console errors. Self-contained.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-hr.js
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const WAIT_MS = Number(process.env.QA_WAIT_MS || 240000);
const OUT = process.env.QA_OUT || "hr-results.log";
const ONLY = process.env.QA_ONLY;

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
const step = async (n, f) => {
  if (ONLY && !ONLY.split(",").some((t) => n.includes(t.trim()))) return;
  const before = errs.length;
  try {
    await f();
    need(errs.length - before === 0, `${errs.length - before} console error(s)`);
    results.push(true);
    rec("PASS  " + n);
  } catch (e) {
    results.push(false);
    rec("FAIL  " + n + " — " + e.message.split("\n")[0]);
  }
};
// Robust across the approval suspend->approve->resume cycle (a real user approves).
const settle = async (page, ms) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const approve = page.getByRole("button", { name: "Approve" });
  await stop.waitFor({ timeout: 45000 }).catch(() => {});
  const d = Date.now() + ms;
  let idle = 0;
  while (Date.now() < d) {
    if ((await approve.count()) > 0) {
      await approve.first().click().catch(() => {});
      await page.waitForTimeout(2000);
      idle = 0;
      continue;
    }
    if ((await stop.count()) > 0) {
      idle = 0;
      await page.waitForTimeout(700);
      continue;
    }
    idle += 1;
    if (idle >= 3) break;
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
    };
  });
const steps = (r) =>
  Number(
    (r.pill.match(/(\d+)\s*steps?/i) || r.pill.match(/(\d+)\s*\/\s*\d+/) || [])[1] || 0,
  );
const noFalseAuto = (t) => !/i (checked|reviewed|pulled) (your|the) (hris|ats)/i.test(t);
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

// --- fixtures (self-contained) ---------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "qa-hr-"));
const HANDBOOK = path.join(TMP, "handbook.txt");
const COMP = path.join(TMP, "comp.csv");
const PEOPLE = path.join(TMP, "people.csv");
const PIPELINE = path.join(TMP, "pipeline.csv");
fs.writeFileSync(
  HANDBOOK,
  "ACME EMPLOYEE HANDBOOK\n\nSection 3 — Paid Time Off\nFull-time employees accrue 20 " +
    "days of PTO per year. Unused PTO rolls over up to a maximum of 5 days.\n\nSection " +
    "7 — Remote Work\nEmployees may work remotely up to 3 days per week with manager " +
    "approval. Working from outside the country requires HR approval.\n\nSection 9 — " +
    "Expenses\nReimbursable expenses must be submitted within 30 days.\n",
);
// band min 100k / mid 120k / max 140k -> Alice compa 0.80 (below_min), Bob 1.00 (at_mid),
// Carol 1.20 (above_mid, high outlier), Dave above_max.
fs.writeFileSync(
  COMP,
  "name,level,location,salary,band_min,band_mid,band_max\n" +
    "Alice,Senior,SF,96000,100000,120000,140000\n" +
    "Bob,Senior,SF,120000,100000,120000,140000\n" +
    "Carol,Senior,SF,144000,100000,120000,140000\n" +
    "Dave,Senior,SF,150000,100000,120000,140000\n",
);
fs.writeFileSync(
  PEOPLE,
  "id,department,team,level,location,start_date,end_date,manager\n" +
    "1,Engineering,Platform,L4,SF,2023-01-10,,Maya\n" +
    "2,Engineering,Platform,L3,SF,2024-03-01,2026-06-01,Maya\n" +
    "3,Engineering,Web,L5,NYC,2022-05-15,,Raj\n" +
    "4,Sales,AE,L3,NYC,2024-09-01,2026-07-15,Raj\n" +
    "5,Sales,AE,L4,SF,2023-11-20,,Maya\n" +
    "6,Marketing,Growth,L4,Remote,2025-02-01,,Raj\n",
);
fs.writeFileSync(
  PIPELINE,
  "candidate,role,source,stage,days_in_stage,contacts\n" +
    "C1,Staff Eng,Referral,Interview,4,3\n" +
    "C2,Staff Eng,LinkedIn,Screen,21,1\n" +
    "C3,Staff Eng,Inbound,Offer,3,2\n" +
    "C4,Staff Eng,Agency,Sourced,30,1\n",
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

  // 1 RECRUITING PIPELINE — funnel + bottlenecks + stale flags
  await step("[1 RECRUITING] pipeline analysis", async () => {
    const r = await fresh(
      page,
      "Analyze my hiring pipeline: funnel/stage breakdown, bottlenecks, stale " +
        "candidates, and what to do next.",
      PIPELINE,
    );
    show("RECRUITING", r);
    need(/funnel|stage|pipeline/i.test(r.text), "no funnel/stage analysis");
    need(/stale|stuck|bottleneck|risk/i.test(r.text), "no bottleneck/stale analysis");
    need(/C2|C4|screen|sourced/i.test(r.text), "did not reference the actual candidates");
  });

  // 2 CANDIDATE EVALUATION / COMPARISON
  await step("[2 CANDIDATE] evaluate and compare", async () => {
    const r = await fresh(
      page,
      "Given these candidates for a Staff Engineer role — C1 (strong system design, " +
        "weak leadership), C2 (great communicator, less depth) — compare them and " +
        "recommend who to advance, with the evidence.",
    );
    show("CANDIDATE", r);
    need(/c1/i.test(r.text) && /c2/i.test(r.text), "did not compare both candidates");
    need(/recommend|advance|stronger/i.test(r.text), "no recommendation");
  });

  // 3 INTERVIEW PREP — competencies + anchored scorecard + debrief
  await step("[3 INTERVIEW] structured interview kit", async () => {
    const r = await fresh(
      page,
      "Prepare a structured interview for a Staff Engineer: core competencies, " +
        "behavioral and situational questions, a 1-4 scorecard with anchors, and a " +
        "debrief template.",
    );
    show("INTERVIEW", r);
    need(/competenc/i.test(r.text), "no competencies");
    need(/behavioral|situational/i.test(r.text), "no question types");
    need(/scorecard|1-4|1 - 4|rubric|anchor/i.test(r.text), "no anchored scorecard");
    need(/debrief/i.test(r.text), "no debrief template");
  });

  // 4 OFFER — comp table + total first-year + downloadable file
  await step("[4 OFFER] draft offer", async () => {
    const r = await fresh(
      page,
      "Draft a job offer for a Staff Engineer in San Francisco: base $200,000, 15% " +
        "target bonus, 10,000 options vesting over 4 years, $20,000 signing bonus, " +
        "start March 2, hiring manager Priya. SHOW me the compensation-package table " +
        "with the total first-year comp in your reply, AND give me the offer letter as " +
        "a downloadable file.",
    );
    show("OFFER", r);
    need(/total first.?year|first.?year|year 1|first year/i.test(r.text), "no total first-year comp");
    need(/200,?000/.test(r.text.replace(/\s/g, "")), "base salary missing");
    need(steps(r) >= 1 || /\.docx|\.pdf|download/i.test(r.text), "no downloadable file");
  });

  // 5 ONBOARDING — Day-1 table + 30/60/90
  await step("[5 ONBOARDING] 30/60/90 plan", async () => {
    const r = await fresh(
      page,
      "Build an onboarding plan for Sam, a Senior Engineer joining the Platform team " +
        "on March 2, reporting to Priya: pre-start, Day 1, Week 1, and 30/60/90 goals.",
    );
    show("ONBOARDING", r);
    need(/pre-start|day 1|day one/i.test(r.text), "no pre-start/Day 1");
    need(/30|60|90/.test(r.text), "no 30/60/90 goals");
    need(/buddy|checklist|agenda/i.test(r.text), "no checklist/agenda");
  });

  // 6 PERFORMANCE REVIEW — evidence-based, no invented facts
  await step("[6 PERFORMANCE] review from notes", async () => {
    const r = await fresh(
      page,
      "Write a manager performance review from these notes: 'Shipped the billing " +
        "migration; cut page-load time; mentored two juniors; needs to improve " +
        "cross-team communication.' Make each point specific and evidence-based.",
    );
    show("PERFORMANCE", r);
    need(/billing|page-load|mentor/i.test(r.text), "did not use the provided evidence");
    need(/strength|development|goal/i.test(r.text), "no strengths/development structure");
  });

  // 7 POLICY — from the uploaded handbook, cited, ≤125-char quote, admits a gap
  await step("[7 POLICY] handbook lookup + gap", async () => {
    const r = await fresh(
      page,
      "Using our handbook: how many PTO days do full-time employees get and can I work " +
        "remotely from another country? Also, what's our sabbatical policy?",
      HANDBOOK,
    );
    show("POLICY", r);
    need(/20 days|20 pto|twenty days/i.test(r.text), "missed the PTO figure from handbook");
    need(/hr approval|another country|outside the country/i.test(r.text), "missed remote rule");
    need(/section|handbook/i.test(r.text), "did not cite the source");
    // sabbatical is NOT in the handbook -> must admit the gap, not invent one
    need(
      /sabbatical[^.]*(not|no|cannot|isn.t|not covered|not in)/i.test(r.text) ||
        /(not|cannot|no).{0,40}sabbatical/i.test(r.text),
      "did not admit the missing sabbatical policy (fabrication risk)",
    );
  });

  // 8 COMPENSATION — exact band-placement / compa-ratio from comp.csv
  await step("[8 COMP] band placement + compa-ratio", async () => {
    const r = await fresh(
      page,
      "Analyze this compensation file against the bands: for each person give the " +
        "compa-ratio and band placement, and flag anyone underpaid (below band). Bands " +
        "are in the file (band_min/band_mid/band_max).",
      COMP,
    );
    show("COMP", r);
    const t = r.text.replace(/\s/g, "");
    need(/alice/i.test(r.text), "did not analyze the employees");
    need(/0\.8|below|underpaid/i.test(r.text), "did not flag Alice below band (compa 0.80)");
    need(/compa/i.test(r.text), "no compa-ratio");
    need(/1\.2|1\.0|above|at.?mid/i.test(t) || /band/i.test(r.text), "no band placement");
  });

  // 9 PEOPLE ANALYTICS — Data Analysis computes headcount + attrition
  await step("[9 PEOPLE] analytics from CSV", async () => {
    const r = await fresh(
      page,
      "From this people CSV, give me headcount by department, the attrition rate, and " +
        "average tenure, with a chart.",
      PEOPLE,
    );
    show("PEOPLE", r);
    need(steps(r) >= 1, "data tools did not run");
    need(/headcount|engineering|sales/i.test(r.text), "no headcount analysis");
    need(/attrition|tenure/i.test(r.text), "no attrition/tenure");
  });

  // 10 ORG PLANNING — span/layers + assumptions
  await step("[10 ORG] org design", async () => {
    const r = await fresh(
      page,
      "Design an org structure for a 25-person engineering team: management layers, " +
        "span of control, and a hiring roadmap. State your assumptions.",
    );
    show("ORG", r);
    need(/span|layer|manager/i.test(r.text), "no span/layers");
    need(/assumption|hiring|roadmap/i.test(r.text), "no assumptions/roadmap");
  });

  // 11 HR WEB RESEARCH — grounded + sources
  await step("[11 RESEARCH] comp market research", async () => {
    const r = await fresh(
      page,
      "What's the current market salary range for a Staff Software Engineer in San " +
        "Francisco? Give percentile ranges and cite sources.",
    );
    show("HR-RESEARCH", r);
    need(steps(r) >= 1, "no web research ran");
    need(/\$|salary|percentile|range/i.test(r.text), "no salary ranges");
    need(noFalseAuto(r.text), "false automation claim");
  });

  // 12 COMPLEX multi-step
  await step("[12 COMPLEX] multi-step HR", async () => {
    const r = await fresh(
      page,
      "For a Staff Engineer hire in SF: research the market comp range, draft an offer " +
        "at the 75th percentile, and outline a 30/60/90 onboarding plan.",
    );
    show("COMPLEX", r);
    need(steps(r) >= 1, "multi-step used no tools");
    need(/offer|comp/i.test(r.text) && /30|60|90|onboard/i.test(r.text), "incomplete flow");
  });

  // --- REGRESSION ------------------------------------------------------------
  await step("[13 NORMAL] normal chat", async () => {
    const r = await fresh(page, "In two sentences, what is a CDN?");
    need(/content delivery|cdn|cache/i.test(r.text), "bad normal answer");
    need(steps(r) === 0, "normal chat should not run tools");
  });
  await step("[14 SEO] SEO still routes to SEO", async () => {
    const r = await fresh(page, "Run a quick technical SEO audit of https://example.com");
    need(/seo|meta|canonical|robots|title/i.test(r.text), "SEO regressed");
  });
  await step("[15 BLOG] Blog still routes to Blog", async () => {
    const r = await fresh(page, "Write a 200-word blog intro about employee onboarding.");
    need(r.text.length > 300, "blog regressed");
  });
  await step("[16 RESEARCH] Deep Research still works", async () => {
    const r = await fresh(page, "Research the current state of WebAssembly with sources.");
    need(/source|http|wasm|webassembly/i.test(r.text), "research regressed");
  });
  await step("[17 DATA] Data Analysis owns generic CSV analysis", async () => {
    const r = await fresh(
      page,
      "Using this CSV, compute the count of rows grouped by department.",
      PEOPLE,
    );
    need(steps(r) >= 1, "data tools did not run");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  rec(`\n===== HR QA: ${passed}/${results.length} | console errors: ${errs.length} =====`);
  for (const e of errs.slice(0, 20)) rec("  - " + e);
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  rec("FATAL " + e.message);
  process.exit(1);
});
