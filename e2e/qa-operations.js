// Operations — prod acceptance (headed Chrome on app.ollasuper.com).
// 9 ops domains + composition (Data/Finance/HR/Deep-Research) + OllaGraph + file + doc-gen
// + 9 regressions. Asserts routing, the source-faithful ARTIFACTS (RACI, runbook 8
// sections, risk register, vendor Proceed/Negotiate/Pass, capacity util%, status 🟢🟡🔴),
// grounding, no-false-automation, streaming, 0 console errors. Self-contained fixtures.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-operations.js
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const WAIT_MS = Number(process.env.QA_WAIT_MS || 240000);
const OUT = process.env.QA_OUT || "operations-results.log";
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
// never claim an ITSM/tracker/chat automation happened
const noFalseAuto = (t) =>
  !/i (created|updated|opened|filed|scheduled|posted|pulled) (the |your |a )?(jira|servicenow|zendesk|ticket|slack|calendar|meeting|project status)/i.test(
    t,
  );
const show = (tag, r) =>
  rec(`\n---- [${tag}] steps:${steps(r)}\n${r.text.slice(0, 2600)}\n---- END ${tag} ----\n`);
const nospace = (t) => t.replace(/\s/g, "");

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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "qa-ops-"));
const WORKLOAD = path.join(TMP, "workload.csv");
fs.writeFileSync(
  WORKLOAD,
  "person,role,capacity_hrs,allocated_hrs\n" +
    "Alice,IC,40,44\n" +
    "Bob,IC,40,30\n" +
    "Carol,Manager,40,38\n" +
    "Dave,IC,40,42\n" +
    "Eve,On-call,40,20\n",
);
const VENDOR = path.join(TMP, "vendor-proposal.txt");
fs.writeFileSync(
  VENDOR,
  "ACME CRM — Proposal for OllaSuper\n\n" +
    "Subscription: $60,000/year (100 seats). Implementation (one-time): $25,000.\n" +
    "Training: $8,000. Premium support: $12,000/year. Data export on exit: $5,000.\n" +
    "Contract: 3-year term, auto-renews, 12-month lock-in, 99.5% uptime SLA.\n",
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

  // 1 VENDOR REVIEW (from uploaded proposal) — cost table + Proceed/Negotiate/Pass
  await step("[1 VENDOR] review proposal", async () => {
    const r = await fresh(
      page,
      "Evaluate this vendor proposal — total cost of ownership over 3 years, risks, and a " +
        "recommendation. Use reasonable assumptions where needed.",
      VENDOR,
    );
    show("VENDOR", r);
    need(/total cost|tco|year 1|3.year|annual cost/i.test(r.text), "no TCO/cost analysis");
    need(/60,?000|110,?000|105,?000|implementation/i.test(nospace(r.text)) || /\$/.test(r.text), "no cost figures");
    need(/proceed|negotiate|pass/i.test(r.text), "no Proceed/Negotiate/Pass recommendation");
    need(/risk|lock-in|sla|exit/i.test(r.text), "no risk assessment");
    need(noFalseAuto(r.text), "false automation claim");
  });

  // 2 VENDOR COMPARISON
  await step("[2 VENDOR-CMP] compare two vendors", async () => {
    const r = await fresh(page, "Compare two CRM vendors: Vendor A is $50k/yr with strong integrations but weak support; Vendor B is $70k/yr with great support and a shorter contract. Which should we choose?");
    show("VENDOR-CMP", r);
    need(/vendor a/i.test(r.text) && /vendor b/i.test(r.text), "did not compare both");
    need(/recommend|choose|proceed|negotiate/i.test(r.text), "no recommendation");
  });

  // 3 PROCESS DOC / SOP — RACI with the 4 roles
  await step("[3 SOP] document offboarding as an SOP", async () => {
    const r = await fresh(page, "Turn our employee offboarding process into an SOP: IT revokes access, HR runs the exit interview, the manager reassigns work, finance settles final pay. Include a RACI.");
    show("SOP", r);
    need(/sop|standard operating|process/i.test(r.text), "not an SOP");
    need(/raci/i.test(r.text), "no RACI");
    need(/responsible/i.test(r.text) && /accountable/i.test(r.text) && /consulted/i.test(r.text) && /informed/i.test(r.text), "RACI missing the 4 roles");
  });

  // 4 PROCESS OPTIMIZATION — bottleneck + before/after
  await step("[4 OPTIMIZE] find the bottleneck", async () => {
    const r = await fresh(page, "Our invoice approval takes 10 days: submit (1d) → manager review (waits 4 days) → finance check (1d) → director sign-off (waits 3 days) → payment (1d). Find the bottlenecks and redesign it.");
    show("OPTIMIZE", r);
    need(/bottleneck|wait|delay|handoff/i.test(r.text), "no bottleneck analysis");
    need(/manager review|director|sign-off|4 day|3 day/i.test(r.text), "did not analyze the actual steps");
    need(/before|after|future|redesign|parallel|automat/i.test(r.text), "no future-state redesign");
  });

  // 5 RACI standalone
  await step("[5 RACI] standalone RACI", async () => {
    const r = await fresh(page, "Build a RACI matrix for our monthly financial close involving accounting, the controller, FP&A, and the CFO.");
    show("RACI", r);
    need(/responsible/i.test(r.text) && /accountable/i.test(r.text), "no RACI roles");
  });

  // 6 CHANGE REQUEST — impact + rollback with trigger
  await step("[6 CHANGE] migration change request", async () => {
    const r = await fresh(page, "We're moving from manual invoice approvals to an automated workflow affecting the 40-person billing team. Create the change request with impact analysis and a rollback plan.");
    show("CHANGE", r);
    need(/impact/i.test(r.text), "no impact analysis");
    need(/rollback/i.test(r.text), "no rollback plan");
    need(/trigger|revert|if|verification/i.test(r.text), "rollback lacks trigger/verification");
    need(/billing|40/i.test(r.text), "impact not specific");
    need(noFalseAuto(r.text), "false automation claim");
  });

  // 7 IMPACT ANALYSIS
  await step("[7 IMPACT] impact of a deployment change", async () => {
    const r = await fresh(page, "We're changing our deployment process from manual releases to CI/CD. What's the impact on users, systems, and processes, and what could go wrong?");
    show("IMPACT", r);
    need(/impact|users|systems|processes/i.test(r.text), "no impact analysis");
    need(/risk|go wrong|rollback|mitigat/i.test(r.text), "no risk/what-could-go-wrong");
  });

  // 8 ROLLBACK PLAN
  await step("[8 ROLLBACK] rollback plan", async () => {
    const r = await fresh(page, "Write a rollback plan for a database schema migration on our production billing system.");
    show("ROLLBACK", r);
    need(/rollback|revert|restore|undo/i.test(r.text), "no rollback steps");
    need(/trigger|verif|confirm/i.test(r.text), "no trigger/verification");
  });

  // 9 CAPACITY PLAN (+Data, exact utilization from CSV)
  await step("[9 CAPACITY] utilization from workload CSV (exact)", async () => {
    const r = await fresh(
      page,
      "Analyze this team's workload and tell me who is overallocated and whether we're " +
        "understaffed. Use the standard utilization targets.",
      WORKLOAD,
    );
    show("CAPACITY", r);
    const t = nospace(r.text);
    need(/utiliz|capacity|allocat|overallocat/i.test(r.text), "no capacity analysis");
    // Alice 44/40=110%, Dave 42/40=105% -> overallocated
    need(/110%|105%|over.?alloc|above 100/i.test(t), "did not compute overallocation");
    need(/alice|dave/i.test(r.text), "did not name the overallocated people");
    need(/hire|reprioritize|deprioritize|redistribute|recommend/i.test(r.text), "no recommendation");
  });

  // 10 RESOURCE ALLOCATION / headcount
  await step("[10 RESOURCE] how many people do we need", async () => {
    const r = await fresh(page, "Our support team of 4 handles 2,000 tickets/month, and each ticket takes ~30 minutes. Next quarter we expect 3,000 tickets/month. How many people do we need?");
    show("RESOURCE", r);
    need(/ticket|hour|capacity|headcount|fte|staff/i.test(r.text), "no capacity reasoning");
    need(/hire|need|additional|understaffed|\d/i.test(r.text), "no headcount conclusion");
  });

  // 11 STATUS REPORT — 🟢🟡🔴 + decisions
  await step("[11 STATUS] weekly ops report", async () => {
    const r = await fresh(page, "Make a weekly operations status report from these updates: migration is 80% done (on track), the vendor renewal is stalled awaiting legal (at risk), and we need a decision on the support tool budget by Friday.");
    show("STATUS", r);
    need(/on track|at risk|off track|🟢|🟡|🔴|status/i.test(r.text), "no status indicator");
    need(/decision|budget|friday/i.test(r.text), "no decisions-needed");
    need(noFalseAuto(r.text), "false automation claim");
  });

  // 12 RISK REGISTER — likelihood/impact/level + owner
  await step("[12 RISK] operational risk register", async () => {
    const r = await fresh(page, "What are our biggest operational risks running a small SaaS ops team, and give me a prioritized risk register?");
    show("RISK", r);
    need(/risk register|risk/i.test(r.text), "no risk register");
    need(/likelihood/i.test(r.text) && /impact/i.test(r.text), "no likelihood/impact");
    need(/critical|high|medium|low/i.test(r.text), "no risk level");
    need(/mitigation|owner/i.test(r.text), "no mitigation/owner");
  });

  // 13 COMPLIANCE TRACKING
  await step("[13 COMPLIANCE] compliance tracker", async () => {
    const r = await fresh(page, "Create a compliance tracking plan for SOC 2: controls, evidence, owners, and gaps.");
    show("COMPLIANCE", r);
    need(/control|evidence|gap|audit/i.test(r.text), "no compliance components");
    need(/owner|remediation|deadline|status/i.test(r.text), "no ownership/remediation");
  });

  // 14 RUNBOOK — all 8 sections
  await step("[14 RUNBOOK] monthly close runbook (8 sections)", async () => {
    const r = await fresh(page, "Create an operational runbook for our monthly financial close: lock the period, reconcile accounts, run reports, get controller sign-off. Include troubleshooting, rollback, and escalation.");
    show("RUNBOOK", r);
    const t = r.text.toLowerCase();
    need(/runbook/i.test(r.text), "not a runbook");
    need(/purpose/.test(t) && /prerequisite/.test(t) && /procedure|step/.test(t), "missing purpose/prereqs/procedure");
    need(/verif/.test(t) && /troubleshoot/.test(t) && /rollback/.test(t) && /escalat/.test(t), "missing verification/troubleshooting/rollback/escalation");
  });

  // 15 NL ops query
  await step("[15 NL] is my team overloaded", async () => {
    const r = await fresh(page, "My team feels overloaded and things keep slipping. Help me figure out what's going on and what to do.");
    show("NL", r);
    need(/capacity|utiliz|workload|overload|bottleneck|prioriti/i.test(r.text), "no ops diagnosis");
  });

  // 16 COMPLEX multi-step (change → risk → runbook)
  await step("[16 COMPLEX] change + risk + runbook", async () => {
    const r = await fresh(page, "We're rolling out a new incident-management process next month. Prepare the change request, a risk assessment, and a runbook for handling a Sev-1 incident.");
    show("COMPLEX", r);
    need(/change/i.test(r.text) && /risk/i.test(r.text) && /runbook|procedure|step/i.test(r.text), "incomplete multi-artifact");
  });

  // 17 +DATA (proven by behavior — same as capacity, reinforced)
  await step("[17 +DATA] workload CSV computed", async () => {
    const r = await fresh(page, "From this CSV, compute each person's utilization % and flag anyone over 100%.", WORKLOAD);
    show("PLUS-DATA", r);
    need(/110%|105%|over|alice|dave/i.test(nospace(r.text)) || steps(r) >= 1, "did not compute utilization");
  });

  // 18 +FINANCE (staffing affordability with a computed cost)
  await step("[18 +FINANCE] staffing affordability", async () => {
    const r = await fresh(page, "We want to hire 3 support engineers at $80,000/year each. We have a $500k annual ops budget with $380k already committed. Can we afford it, and what's the impact?");
    show("PLUS-FINANCE", r);
    need(/240,?000|240k|\$240|budget|afford|remaining|120/i.test(nospace(r.text)), "no affordability computation");
    need(/afford|can|cannot|fits|exceed|within/i.test(r.text), "no affordability conclusion");
  });

  // 19 +HR (staffing change org impact)
  await step("[19 +HR] staffing change org impact", async () => {
    const r = await fresh(page, "We're moving 5 people from the support team into a new platform-reliability team. How should we structure this and what's the impact on roles and onboarding?");
    show("PLUS-HR", r);
    need(/role|team|structure|onboard|responsibilit|report/i.test(r.text), "no org/role impact");
  });

  // 20 +DEEP-RESEARCH (INDIA compliance — cite + label uncertainty + not stale)
  await step("[20 +INDIA] indian compliance research", async () => {
    const r = await fresh(page, "Create a compliance checklist for handling customer personal data for our SaaS operating in India. What are the current requirements?");
    show("INDIA", r);
    need(/india|dpdp|data protection|personal data|privacy|regulation/i.test(r.text), "no India-specific compliance");
    need(/verify|current|as of|may change|consult|assumption|not legal advice|authoritative|source/i.test(r.text), "no uncertainty/verify-current caveat");
    need(noFalseAuto(r.text), "false automation claim");
  });

  // 21 OllaGraph vendor research
  await step("[21 RESEARCH] vendor web research", async () => {
    const r = await fresh(page, "Research the vendor Atlassian — what do they offer, their pricing model, and any operational risks to consider?");
    show("OPS-RESEARCH", r);
    need(steps(r) >= 1 || /atlassian|jira|confluence|pricing|source/i.test(r.text), "no vendor research");
    need(noFalseAuto(r.text), "false automation claim");
  });

  // 22 FILE INPUT
  await step("[22 FILE] vendor proposal file", async () => {
    const r = await fresh(page, "Extract the pricing and contract terms from this proposal and flag the concerning terms.", VENDOR);
    show("FILE", r);
    need(/60,?000|25,?000|lock-in|auto.?renew|sla|3.year/i.test(nospace(r.text)), "did not extract the terms");
  });

  // 23 GENERATED DOC (downloadable)
  await step("[23 DOC] downloadable SOP", async () => {
    const r = await fresh(page, "Create a downloadable SOP document (DOCX or PDF) for our customer refund process, and show the key steps in your reply.");
    show("DOC", r);
    need(steps(r) >= 1 || /\.docx|\.pdf|download/i.test(r.text), "no downloadable doc");
    need(/refund|step|process/i.test(r.text), "no inline steps");
  });

  // --- REGRESSION ------------------------------------------------------------
  await step("[24 NORMAL] normal chat", async () => {
    const r = await fresh(page, "In two sentences, what is a CDN?");
    need(/content delivery|cdn|cache/i.test(r.text), "bad normal answer");
    need(steps(r) === 0, "normal chat should not run tools");
  });
  await step("[25 SEO] SEO regression", async () => {
    const r = await fresh(page, "Run a quick technical SEO audit of https://example.com");
    need(/seo|meta|canonical|robots|title/i.test(r.text), "SEO regressed");
  });
  await step("[26 BLOG] Blog regression", async () => {
    const r = await fresh(page, "Write a 200-word blog intro about operational excellence.");
    need(r.text.length > 300, "blog regressed");
  });
  await step("[27 RESEARCH] Deep Research regression", async () => {
    const r = await fresh(page, "Research the current state of WebAssembly with sources.");
    need(/source|http|wasm|webassembly/i.test(r.text), "research regressed");
  });
  await step("[28 DATA] Data Analysis regression", async () => {
    const r = await fresh(page, "Using this CSV, compute the sum of allocated_hrs grouped by role.", WORKLOAD);
    need(steps(r) >= 1, "data tools did not run");
  });
  await step("[29 SALES] Sales regression", async () => {
    const r = await fresh(page, "Review my sales pipeline and forecast whether I'll hit quota this quarter.");
    need(/pipeline|forecast|deal|quota|stage/i.test(r.text), "sales regressed");
  });
  await step("[30 HR] HR regression", async () => {
    const r = await fresh(page, "Analyze our employee attrition and headcount by department.");
    need(/attrition|headcount|employee|tenure|turnover/i.test(r.text), "HR regressed");
  });
  await step("[31 FINANCE] Finance regression", async () => {
    const r = await fresh(page, "Value this company with a DCF: revenue 100M, 5% growth, 10% FCF margin.");
    need(/dcf|wacc|valuation|enterprise value|per.share/i.test(r.text), "finance regressed");
  });
  await step("[32 MARKETING] Marketing regression", async () => {
    const r = await fresh(page, "Create a go-to-market strategy for our new product.");
    need(/go-to-market|gtm|positioning|channel|audience/i.test(r.text), "marketing regressed");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  rec(`\n===== OPERATIONS QA: ${passed}/${results.length} | console errors: ${errs.length} =====`);
  for (const e of errs.slice(0, 20)) rec("  - " + e);
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  rec("FATAL " + e.message);
  process.exit(1);
});
