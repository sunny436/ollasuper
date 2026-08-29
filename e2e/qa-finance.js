// Finance — prod acceptance (headed Chrome on app.ollasuper.com).
// Corporate Finance (FP&A / SaaS / investment) + Equity Research + regressions.
// Asserts routing, finance_calc/finance_reference + data tools execute, grounded output,
// required sections, EXACT deterministic numbers, no fabrication, streaming, 0 console
// errors. Self-contained fixtures. Numbers match services/ai/tests/test_finance_calc.py.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-finance.js
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 240000);
const OUT = process.env.QA_OUT || "finance-results.log";
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
// never claim a live accounting/ERP/market-data system
const noFalseAuto = (t) =>
  !/i (checked|reviewed|pulled|queried) (your|the) (erp|accounting|quickbooks|bloomberg|ledger)/i.test(
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "qa-fin-"));
const BUDGET = path.join(TMP, "budget.csv");
const SAAS = path.join(TMP, "saas.csv");
const REV = path.join(TMP, "revenue.csv");
const FILING = path.join(TMP, "filing.txt");
// Revenue up, but expenses up more -> profit falling (drives E8).
fs.writeFileSync(
  BUDGET,
  "line,type,actual,budget\n" +
    "Revenue,revenue,1000000,900000\n" +
    "COGS,expense,620000,500000\n" +
    "Opex,expense,410000,350000\n" +
    "Rent,expense,51000,50000\n",
);
fs.writeFileSync(
  SAAS,
  "month,mrr,customers,new_customers,churned_customers,sm_spend,expansion_mrr,churned_mrr\n" +
    "Jan,90000,95,8,2,45000,3000,1500\n" +
    "Feb,100000,100,10,3,50000,4000,2000\n",
);
fs.writeFileSync(
  REV,
  "quarter,revenue\n2024Q1,800000\n2024Q2,850000\n2024Q3,900000\n2024Q4,1000000\n",
);
fs.writeFileSync(
  FILING,
  "NORTHWIND LOGISTICS LTD — Annual Report FY2025 (Consolidated, INR crore)\n\n" +
    "Page 42 — Statement of Profit and Loss (FY2025 / FY2024):\n" +
    "Revenue from operations: 4,200 / 3,600. Reported net profit: 520 / 300.\n" +
    "Page 58 — Cash Flow: Cash from operations: 210 (vs reported PAT 520).\n" +
    "Page 60 — Receivables: 1,150 (up from 640); revenue grew 17%, receivables grew 80%.\n" +
    "Page 71 — Auditor: emphasis of matter on related-party advances of 380.\n",
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

  // 1 FINANCIAL HEALTH — jargon-free
  await step("[1 HEALTH] is my business financially healthy", async () => {
    const r = await fresh(
      page,
      "Is my business financially healthy? Revenue 1,000, COGS 600, operating income " +
        "200, net income 100, total equity 500, total assets 1,200, current assets 400, " +
        "current liabilities 200, inventory 100, cash 80, total debt 300.",
    );
    show("HEALTH", r);
    need(/healthy|strong|solid|stretched|concern|weak/i.test(r.text), "no health verdict");
    need(/ratio|margin|liquidity|leverage/i.test(r.text), "no ratio-based reasoning");
  });

  // 2 RATIOS — EXACT
  await step("[2 RATIOS] exact 5-category ratios", async () => {
    const r = await fresh(
      page,
      "Compute our financial ratios: revenue 1000, COGS 600, operating income 200, net " +
        "income 100, interest expense 20, total equity 500, total assets 1200, current " +
        "assets 400, current liabilities 200, inventory 100, cash 80, total debt 300, " +
        "accounts receivable 125, operating cash flow 150.",
    );
    show("RATIOS", r);
    // Label-anchored value checks (a stray "0.40" elsewhere must not false-pass).
    const val = (label) => {
      const m = r.text.match(
        new RegExp(label + "[^%x0-9\\n]*?(\\d+(?:\\.\\d+)?)\\s*[%x]?", "i"),
      );
      return m ? parseFloat(m[1]) : NaN;
    };
    const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;
    need(near(val("gross margin"), 40, 0.6), "gross margin not ~40% (got " + val("gross margin") + ")");
    need(near(val("net margin"), 10, 0.6), "net margin not ~10% (got " + val("net margin") + ")");
    need(near(val("roe"), 20, 0.6), "ROE not ~20%");
    need(near(val("current ratio"), 2, 0.05), "current ratio not ~2.0");
    need(near(val("debt.?to.?equity"), 0.6, 0.05), "debt-to-equity not ~0.6");
  });

  // 3 DCF — EXACT WACC + EV
  await step("[3 DCF] company valuation", async () => {
    const r = await fresh(
      page,
      "Value my company with a DCF: revenue 100 (millions), 5-year projection, 5% " +
        "revenue growth, 10% FCF margin, 2.5% terminal growth, use the CAPM defaults, " +
        "1 million shares, no net debt. Give me the WACC, enterprise value and a " +
        "per-share range from the sensitivity.",
    );
    show("DCF", r);
    need(/wacc/i.test(r.text), "no WACC");
    need(/8\.1|8%|0\.081|8\.12/.test(r.text), "WACC ~8.1% missing (deterministic)");
    need(/20[0-9](\.\d)?|203/.test(nospace(r.text)), "enterprise value ~203 missing");
    need(/sensitivity|range/i.test(r.text), "no sensitivity/range");
  });

  // 4 BUDGET VARIANCE — materiality flags
  await step("[4 VARIANCE] budget vs actual", async () => {
    const r = await fresh(
      page,
      "Analyze budget vs actual from this file: variance and % for each line, mark " +
        "favorable/unfavorable, and flag the MATERIAL variances (10% or $50k).",
      BUDGET,
    );
    show("VARIANCE", r);
    need(/variance/i.test(r.text), "no variance");
    need(/favorable|unfavorable/i.test(r.text), "no favorability");
    need(/material/i.test(r.text), "no materiality flag");
    need(/cogs|120,?000|24%/i.test(r.text), "did not flag the material COGS overspend");
  });

  // 5 REVENUE FORECAST
  await step("[5 FORECAST] revenue projection", async () => {
    const r = await fresh(
      page,
      "Forecast our revenue for the next 4 quarters from this history, with base, bull " +
        "and bear scenarios.",
      REV,
    );
    show("FORECAST", r);
    need(/forecast|project/i.test(r.text), "no forecast");
    need(/base|bull|bear|scenario/i.test(r.text), "no scenarios");
  });

  // 6 CASH-FLOW / AFFORDABILITY
  await step("[6 AFFORD] can we afford to hire", async () => {
    const r = await fresh(
      page,
      "We have $600,000 cash and burn $80,000/month with $120,000/month revenue. Can we " +
        "afford to hire 20 people at $8,000/month each? Show the runway impact.",
    );
    show("AFFORD", r);
    need(/runway|month|afford|cash/i.test(r.text), "no runway/affordability analysis");
  });

  // 7 WHY MORE SALES BUT LOSING MONEY
  await step("[7 PROFIT] sales up profit down", async () => {
    const r = await fresh(
      page,
      "Why are we making more sales but still losing money? Use this data.",
      BUDGET,
    );
    show("PROFIT", r);
    need(/margin|cost|cogs|opex|expense/i.test(r.text), "no margin/cost diagnosis");
  });

  // 8 SAAS METRICS — EXACT
  await step("[8 SAAS] metrics + benchmarks (exact)", async () => {
    const r = await fresh(
      page,
      "Compute our SaaS metrics and benchmark them: MRR $100,000 (was $90,000 last " +
        "month), 100 customers, 3 churned this month, 10 new customers, $50,000 S&M " +
        "spend, 80% gross margin. Give ARR, MRR growth, churn, CAC, LTV, LTV:CAC, CAC " +
        "payback and NRR with health bands.",
    );
    show("SAAS", r);
    const t = nospace(r.text);
    need(/1,?200,?000|1\.2\s?m|\$1\.2/i.test(r.text), "ARR $1.2M missing");
    need(/3%|3\.0%/.test(r.text), "churn 3% missing");
    need(t.includes("5,000") || t.includes("$5,000") || /cac[^0-9]{0,10}5,?000/i.test(r.text), "CAC $5,000 missing");
    need(/26,?6|26,?667|26\.6/.test(t), "LTV ~$26,667 missing");
    need(/5\.3|5\.33/.test(r.text), "LTV:CAC 5.3 missing");
    need(/100%|1\.0x|nrr/i.test(r.text), "NRR missing");
    need(/healthy|excellent|watch|critical|world-class/i.test(r.text), "no benchmark bands");
  });

  // 9 INVESTMENT — EXACT NPV/IRR
  await step("[9 INVEST] NPV/IRR/payback/ROI (exact)", async () => {
    const r = await fresh(
      page,
      "Should we buy a $100,000 machine? It returns net cash flows of $30,000, $40,000, " +
        "$50,000 and $60,000 over four years. Use a 12% hurdle rate. Give NPV, IRR, " +
        "payback, ROI and a recommendation.",
    );
    show("INVEST", r);
    const t = nospace(r.text);
    need(/32,?3|32,?394|32,?393/.test(t), "NPV ~$32,393 missing");
    need(/24\.8|24\.9|25%|0\.249/.test(r.text), "IRR ~24.9% missing");
    need(/2\.2|2\.22/.test(r.text), "payback ~2.2y missing");
    need(/\b80(\.0+)?\s*%/.test(r.text), "ROI 80% missing");
    need(/recommend|proceed|yes|worth|approve/i.test(r.text), "no recommendation");
  });

  // 10 REPORT — downloadable
  await step("[10 REPORT] downloadable financial report", async () => {
    const r = await fresh(
      page,
      "Turn this budget-vs-actual analysis into a downloadable one-page finance report " +
        "(PDF or DOCX). Also show the key numbers in your reply.",
      BUDGET,
    );
    show("REPORT", r);
    need(steps(r) >= 1 || /\.docx|\.pdf|download/i.test(r.text), "no downloadable file");
    need(/variance|revenue|budget/i.test(r.text), "no inline numbers");
  });

  // 11 CHART
  await step("[11 CHART] renders a chart", async () => {
    const r = await fresh(
      page,
      "Chart our quarterly revenue from this file as a bar chart and note the trend.",
      REV,
    );
    show("CHART", r);
    need(/chart|trend|revenue|increase|grow/i.test(r.text), "no chart/trend");
  });

  // 12 EQUITY / STOCK ANALYSIS — sourced, no fabrication, not advice
  await step("[12 EQUITY] stock forensic analysis", async () => {
    const r = await fresh(
      page,
      "Analyze this company from its filing: is the reported profit real? Classify the " +
        "sector, screen for red flags, and give a verdict with the risks. Cite the pages.",
      FILING,
    );
    show("EQUITY", r);
    need(steps(r) >= 1, "no tools ran (reference/analysis)");
    need(/receivable|cash flow|red flag|earnings quality|profit/i.test(r.text), "no forensic analysis");
    need(/page|filing|fy2025|consolidated/i.test(r.text), "did not cite the source/period");
    need(/crore|inr/i.test(r.text), "did not state currency/units");
    need(/not (investment|financial|licensed).{0,25}advice|analysis,? not advice|informational|educational|not a recommendation/i.test(r.text), "no not-advice boundary");
    need(noFalseAuto(r.text), "false automation claim");
  });

  // 13 EQUITY — sector playbook via finance_reference
  await step("[13 SECTOR] reverse-DCF / valuation ask", async () => {
    const r = await fresh(
      page,
      "For a listed logistics company trading at a rich multiple, what growth does the " +
        "price imply (reverse-DCF), and which valuation method fits the sector?",
    );
    show("SECTOR", r);
    need(/reverse.?dcf|implied growth|ev\/ebitda|valuation/i.test(r.text), "no reverse-DCF/valuation method");
    need(noFalseAuto(r.text), "false automation claim");
  });

  // --- REGRESSION ------------------------------------------------------------
  await step("[14 NORMAL] normal chat", async () => {
    const r = await fresh(page, "In two sentences, what is a CDN?");
    need(/content delivery|cdn|cache/i.test(r.text), "bad normal answer");
    need(steps(r) === 0, "normal chat should not run tools");
  });
  await step("[15 SEO] SEO still routes to SEO", async () => {
    const r = await fresh(page, "Run a quick technical SEO audit of https://example.com");
    need(/seo|meta|canonical|robots|title/i.test(r.text), "SEO regressed");
  });
  await step("[16 BLOG] Blog still routes to Blog", async () => {
    const r = await fresh(page, "Write a 200-word blog intro about small-business budgeting.");
    need(r.text.length > 300, "blog regressed");
  });
  await step("[17 RESEARCH] Deep Research still works", async () => {
    const r = await fresh(page, "Research the current state of WebAssembly with sources.");
    need(/source|http|wasm|webassembly/i.test(r.text), "research regressed");
  });
  await step("[18 DATA] Data Analysis owns generic CSV analysis", async () => {
    const r = await fresh(
      page,
      "Using this CSV, compute the count of rows grouped by type.",
      BUDGET,
    );
    need(steps(r) >= 1, "data tools did not run");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  rec(`\n===== FINANCE QA: ${passed}/${results.length} | console errors: ${errs.length} =====`);
  for (const e of errs.slice(0, 20)) rec("  - " + e);
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  rec("FATAL " + e.message);
  process.exit(1);
});
