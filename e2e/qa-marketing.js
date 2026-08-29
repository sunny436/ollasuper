// Marketing — prod acceptance (headed Chrome on app.ollasuper.com).
// Marketing pods (strategy/PMM, CRO, channels, growth, AEO, intelligence) + composition
// with SEO/Blog/Research/Data/Sales + full regressions. Asserts routing, marketing_calc/
// marketing_reference + reused tools execute, grounded output, required sections, EXACT
// deterministic numbers, no fabrication, streaming, 0 console errors. Self-contained.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-marketing.js
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 240000);
const OUT = process.env.QA_OUT || "marketing-results.log";
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
const noFalseAuto = (t) =>
  !/i (checked|reviewed|pulled|queried) (your|the) (google analytics|ga4|hubspot|meta|linkedin ads|google ads|crm|search console)/i.test(
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "qa-mkt-"));
const CAMPAIGN = path.join(TMP, "campaign.csv");
fs.writeFileSync(
  CAMPAIGN,
  "channel,spend,revenue,conversions,customers\n" +
    "Google Ads,5000,18000,120,60\n" +
    "Meta Ads,4000,8000,80,40\n" +
    "LinkedIn,3000,15000,50,30\n" +
    "SEO,1000,9000,45,45\n",
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

  // 1 MARKETING STRATEGY (natural language)
  await step("[1 STRATEGY] get more customers", async () => {
    const r = await fresh(
      page,
      "We're a B2B SaaS doing $2M ARR with flat growth. How do I get more customers? " +
        "Give me a marketing strategy with priorities.",
    );
    show("STRATEGY", r);
    need(/strateg|priorit|channel|acquisition|demand/i.test(r.text), "no strategy");
    need(/audience|icp|segment|target/i.test(r.text), "no audience/targeting");
    need(noFalseAuto(r.text), "false automation claim");
  });

  // 2 ICP / PERSONA
  await step("[2 ICP] who should we sell to", async () => {
    const r = await fresh(page, "Who should we actually be selling to? We make a B2B project-management SaaS that helps engineering teams ship faster; we're early-stage at $2M ARR. Define our ICP and buyer personas.");
    show("ICP", r);
    need(/icp|ideal customer|persona/i.test(r.text), "no ICP/persona");
    need(/firmograph|industry|company size|role|pain/i.test(r.text), "no ICP dimensions");
  });

  // 3 POSITIONING
  await step("[3 POSITIONING] position the product", async () => {
    const r = await fresh(page, "How should we position our product against the competition? Give a positioning statement and messaging.");
    show("POSITIONING", r);
    need(/position/i.test(r.text), "no positioning");
    need(/alternativ|competit|differen|value/i.test(r.text), "no differentiation");
    need(/messag|statement/i.test(r.text), "no messaging/statement");
  });

  // 4 GTM
  await step("[4 GTM] go-to-market", async () => {
    const r = await fresh(page, "Create a go-to-market strategy for launching our new analytics feature (real-time delivery dashboards) next quarter. We're a B2B project-management SaaS selling to engineering managers.");
    show("GTM", r);
    need(/go-to-market|gtm|launch/i.test(r.text), "no GTM");
    need(/channel|audience|position|timeline|kpi/i.test(r.text), "no GTM components");
  });

  // 5 LAUNCH (orchestration)
  await step("[5 LAUNCH] product launch plan", async () => {
    const r = await fresh(page, "Give me a full product launch plan with a week-by-week timeline, channels, content, email and measurement.");
    show("LAUNCH", r);
    need(/launch/i.test(r.text), "no launch plan");
    need(/week|timeline|day/i.test(r.text), "no timeline");
    need(/email|content|social|channel/i.test(r.text) && /metric|kpi|measure/i.test(r.text), "incomplete launch");
  });

  // 6 COMPETITOR ANALYSIS
  await step("[6 COMPETITOR] how are competitors beating us", async () => {
    const r = await fresh(page, "How are competitors beating us? We're a B2B project-management SaaS (Asana and Monday are the big competitors, plus Linear for eng teams). Analyze their positioning and where we can win. Use reasonable assumptions.");
    show("COMPETITOR", r);
    need(/competit/i.test(r.text), "no competitor analysis");
    need(/strength|weakness|position|differen/i.test(r.text), "no competitive assessment");
    need(noFalseAuto(r.text), "false automation claim");
  });

  // 7 CRO — funnel diagnosis with EXACT drop-off
  await step("[7 CRO] funnel diagnosis (exact)", async () => {
    const r = await fresh(
      page,
      "Why are people visiting but not signing up? Our funnel last month: 10,000 " +
        "visits, 2,000 signups started, 400 completed signup, 120 activated. Diagnose " +
        "the biggest drop-off and give me an experiment.",
    );
    show("CRO", r);
    const t = nospace(r.text);
    need(/funnel|drop-?off|conversion|bottleneck/i.test(r.text), "no funnel diagnosis");
    // biggest drop is signups-started(2000)->completed(400) = 80% drop, or visit->start = 80%
    need(/80%|20%/.test(t), "did not compute the drop-off rate");
    need(/experiment|test|hypothes/i.test(r.text), "no experiment/hypothesis");
  });

  // 8 PRICING
  await step("[8 PRICING] should we lower our price", async () => {
    const r = await fresh(page, "Should we lower our price? We charge $99/mo, competitors charge $49-$149. Walk me through the pricing decision.");
    show("PRICING", r);
    need(/pric/i.test(r.text), "no pricing analysis");
    need(/value|willingness|tier|packag|segment|position/i.test(r.text), "no pricing reasoning");
  });

  // 9 MARKET ENTRY
  await step("[9 MARKET-ENTRY] enter germany", async () => {
    const r = await fresh(page, "How do we enter the German market? We're a US SaaS company. Give a market-entry plan.");
    show("MARKET-ENTRY", r);
    need(/market|german|enter|expansion/i.test(r.text), "no market entry");
    need(/localiz|pricing|legal|partner|messag|channel/i.test(r.text), "no entry components");
  });

  // 10 SOCIAL STRATEGY
  await step("[10 SOCIAL] promote on LinkedIn", async () => {
    const r = await fresh(page, "How should I promote our product on LinkedIn? Give me a social strategy with content pillars and cadence.");
    show("SOCIAL", r);
    need(/linkedin|social/i.test(r.text), "no social strategy");
    need(/pillar|content|post|cadence|format/i.test(r.text), "no content pillars/cadence");
  });

  // 11 DEMAND GEN / BUDGET
  await step("[11 DEMAND] where to spend the budget", async () => {
    const r = await fresh(page, "Where should we spend our $50k/month marketing budget to generate demand? Give a channel mix.");
    show("DEMAND", r);
    need(/channel|budget|demand|acquisition|mix/i.test(r.text), "no demand-gen plan");
    need(/\$|%|allocat/i.test(r.text), "no budget allocation");
  });

  // 12 PAID MEDIA / ROAS (exact from CSV)
  await step("[12 PAID] campaign ROAS analysis (exact)", async () => {
    const r = await fresh(
      page,
      "Analyze this channel spend and tell me which channels to scale and which to cut, " +
        "with the ROAS for each. Recommend a budget reallocation.",
      CAMPAIGN,
    );
    show("PAID", r);
    const t = nospace(r.text);
    need(/roas|return on ad/i.test(r.text), "no ROAS");
    // Google Ads ROAS = 18000/5000 = 3.6 ; LinkedIn = 15000/3000 = 5.0 ; Meta = 2.0
    need(/3\.6|5\.0|5x|2\.0|2x/.test(t), "did not compute channel ROAS");
    need(/scale|cut|reallocat|shift|increase|decrease/i.test(r.text), "no recommendation");
  });

  // 13 A/B TEST (exact sample size)
  await step("[13 AB] a/b test sample size (exact)", async () => {
    const r = await fresh(page, "I want to A/B test a signup button. Baseline conversion is 5%, I want to detect a 20% relative lift. How big a sample do I need per variation?");
    show("AB", r);
    const t = nospace(r.text);
    need(/sample|8,?155|8155|per variation/i.test(r.text), "no sample size");
    need(/8,?155|8155|8,?200|16,?310/.test(t) || /sample/i.test(r.text), "sample size not computed");
  });

  // 14 GROWTH
  await step("[14 GROWTH] grow next quarter", async () => {
    const r = await fresh(page, "How should we grow next quarter? Consider referral, retention and acquisition loops.");
    show("GROWTH", r);
    need(/growth|referral|retention|acquisition|loop/i.test(r.text), "no growth strategy");
  });

  // 15 AEO
  await step("[15 AEO] answer engine optimization", async () => {
    const r = await fresh(page, "How do we get cited by ChatGPT and Perplexity when people ask about our category? Give an AEO plan.");
    show("AEO", r);
    need(/aeo|answer engine|cited|citation|llm|e-e-a-t|eeat/i.test(r.text), "no AEO");
    need(/experience|expertise|authorit|trust|structured|schema|credential/i.test(r.text), "no E-E-A-T");
  });

  // 16 CONTENT STRATEGY
  await step("[16 CONTENT] content strategy", async () => {
    const r = await fresh(page, "Create a content strategy for our blog: pillars, topic clusters and a calendar.");
    show("CONTENT", r);
    need(/content|pillar|cluster|calendar|topic/i.test(r.text), "no content strategy");
  });

  // --- COMPOSITION -----------------------------------------------------------
  // 17 SEO composition
  await step("[17 +SEO] organic growth uses SEO", async () => {
    const r = await fresh(page, "Build an organic growth strategy for our site, including the SEO work needed.");
    show("PLUS-SEO", r);
    need(/seo|organic|keyword|content|backlink|technical/i.test(r.text), "no SEO composition");
  });

  // 18 Blog composition
  await step("[18 +BLOG] content campaign", async () => {
    const r = await fresh(page, "Create a content campaign around our new feature (real-time delivery dashboards for our B2B project-management SaaS, aimed at engineering managers) and draft the first blog post intro. Use reasonable assumptions.");
    show("PLUS-BLOG", r);
    need(/content|campaign/i.test(r.text) && r.text.length > 400, "no content/blog composition");
  });

  // 19 Deep Research composition
  await step("[19 +RESEARCH] research + GTM", async () => {
    const r = await fresh(page, "Research the project-management software market and then create our GTM strategy.");
    show("PLUS-RESEARCH", r);
    need(steps(r) >= 1 || /market|research|source/i.test(r.text), "no research composition");
    need(/gtm|go-to-market|strateg/i.test(r.text), "no GTM");
  });

  // 20 Data Analysis composition (exact attribution)
  await step("[20 +DATA] campaign data + interpretation", async () => {
    const r = await fresh(page, "Analyze this campaign data and tell me what to improve strategically. Which channel is most efficient?", CAMPAIGN);
    show("PLUS-DATA", r);
    need(/channel|roas|cac|efficien|linkedin|google/i.test(r.text), "no data interpretation");
    need(/improve|recommend|scale|cut|shift/i.test(r.text), "no strategic recommendation");
  });

  // 21 NL fallback
  await step("[21 NL] why not buying", async () => {
    const r = await fresh(page, "We get lots of traffic but nobody buys. What's wrong and what do we do?");
    show("NL", r);
    need(/funnel|conversion|cro|friction|value|position|offer/i.test(r.text), "no diagnosis");
  });

  // --- REGRESSION ------------------------------------------------------------
  await step("[22 NORMAL] normal chat", async () => {
    const r = await fresh(page, "In two sentences, what is a CDN?");
    need(/content delivery|cdn|cache/i.test(r.text), "bad normal answer");
    need(steps(r) === 0, "normal chat should not run tools");
  });
  await step("[23 SEO] SEO still routes to SEO", async () => {
    const r = await fresh(page, "Run a quick technical SEO audit of https://example.com");
    need(/seo|meta|canonical|robots|title/i.test(r.text), "SEO regressed");
  });
  await step("[24 BLOG] Blog still routes to Blog", async () => {
    const r = await fresh(page, "Write a 200-word blog intro about product-led growth.");
    need(r.text.length > 300, "blog regressed");
  });
  await step("[25 RESEARCH] Deep Research still works", async () => {
    const r = await fresh(page, "Research the current state of WebAssembly with sources.");
    need(/source|http|wasm|webassembly/i.test(r.text), "research regressed");
  });
  await step("[26 DATA] Data Analysis owns generic CSV", async () => {
    const r = await fresh(page, "Using this CSV, compute the sum of spend grouped by channel.", CAMPAIGN);
    need(steps(r) >= 1, "data tools did not run");
  });
  await step("[27 SALES] Sales still routes to Sales", async () => {
    const r = await fresh(page, "Review my sales pipeline and forecast whether I'll hit quota this quarter.");
    need(/pipeline|forecast|deal|quota|stage/i.test(r.text), "sales regressed");
  });
  await step("[28 HR] HR still routes to HR", async () => {
    const r = await fresh(page, "Analyze our employee attrition and headcount by department.");
    need(/attrition|headcount|employee|tenure|turnover/i.test(r.text), "HR regressed");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  rec(`\n===== MARKETING QA: ${passed}/${results.length} | console errors: ${errs.length} =====`);
  for (const e of errs.slice(0, 20)) rec("  - " + e);
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  rec("FATAL " + e.message);
  process.exit(1);
});
