// Prod coverage for the 8 previously-untested blog workflows. Prints FULL outputs
// for human reading; behavioral assertions tied to each workflow's expected result.
//   PERSONA, BRAND, CLUSTER, REPURPOSE, FACTCHECK, CANNIBALIZATION, FRESHNESS, TRANSLATE
//   E2E_BASE_URL=https://app.ollasuper.com node qa-blog-8.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const TARGET = process.env.QA_TARGET || "https://www.networkershome.com/";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 300000);

const results = [];
const errs = [];
const need = (c, m) => {
  if (!c) throw new Error(m);
};
const step = async (n, f) => {
  try {
    await f();
    results.push(true);
    console.log("PASS  " + n);
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + n + " — " + e.message.split("\n")[0]);
  }
};
const settle = async (page, ms) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ timeout: 40000 }).catch(() => {});
  const d = Date.now() + ms;
  while (Date.now() < d && (await stop.count()) > 0) await page.waitForTimeout(700);
};
const answer = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    return rows[rows.length - 1]?.innerText || "";
  });
const noRaw = (t) =>
  !t.toLowerCase().includes("_endpoint") && !t.toLowerCase().includes("find capabilities");
async function ask(page, prompt) {
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
  await page.locator("#chat-composer").fill(prompt);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
  await settle(page, WAIT_MS);
  return answer(page);
}
const show = (tag, t) =>
  console.log(`\n---- [${tag}] FULL ----\n${t}\n---- END ${tag} ----\n`);

const SAMPLE_BLOG =
  "5 Tips for Faster Websites. 1) Compress images. 2) Use a CDN. 3) Minify CSS/JS. 4) Cache aggressively. 5) Lazy-load below the fold. Speed matters for SEO and conversions.";

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 20 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) errs.push("HTTP " + r.status() + " " + r.url());
  });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);

  await step("[PERSONA] rewrite in a first-person founder voice", async () => {
    const r = await ask(page, `Rewrite this in a warm, first-person founder voice: "${SAMPLE_BLOG}"`);
    show("PERSONA", r);
    need(/\b(I|I'm|I've|my|we|we're|our)\b/.test(r), "no first-person voice applied");
    need(/image|cdn|cache|website|speed/i.test(r), "did not preserve the source content");
    need(noRaw(r), "raw endpoint name");
  });

  await step("[BRAND] apply a brand voice/constraints", async () => {
    const r = await ask(page, `Write a short blog intro about website speed in our brand voice: professional, concise, British English, no hype words, no jargon. Topic: making an online store faster.`);
    show("BRAND", r);
    need(r.length > 120, "brand intro too short");
    need(noRaw(r), "raw endpoint name");
  });

  await step("[CLUSTER] hub + spoke topic map", async () => {
    const r = await ask(page, "Build a content cluster (a hub page + spoke articles) for the topic 'email marketing for small businesses'. Research it.");
    show("CLUSTER", r);
    const bullets = (r.match(/^\s*(?:[-*\d]|#{2,})/gm) || []).length;
    need(bullets >= 4, "no cluster structure (hub + multiple spokes)");
    need(/hub|pillar|cluster|spoke/i.test(r), "not framed as a cluster/hub-spoke");
    need(noRaw(r), "raw endpoint name");
  });

  await step("[REPURPOSE] blog → LinkedIn + thread", async () => {
    const r = await ask(page, `Repurpose this blog into a LinkedIn post and an X/Twitter thread: "${SAMPLE_BLOG}"`);
    show("REPURPOSE", r);
    need(/linkedin/i.test(r) && /(thread|tweet|x post|1\/)/i.test(r), "missing LinkedIn and/or thread");
    need(noRaw(r), "raw endpoint name");
  });

  await step("[FACTCHECK] verify claims against sources", async () => {
    const r = await ask(page, "Fact-check these claims and cite sources or flag unsupported: (1) 53% of mobile users abandon a site that takes over 3 seconds to load. (2) The average web page is 4 MB.");
    show("FACTCHECK", r);
    need(/source|according to|http|unsupported|could not|unverified|verify/i.test(r), "no verification/sourcing shown");
    need(noRaw(r), "raw endpoint name");
  });

  await step("[CANNIBALIZATION] overlap analysis", async () => {
    const r = await ask(page, "Do these two blog topics cannibalize each other for search: 'best running shoes for beginners' and 'top running shoes for new runners'? Explain and advise.");
    show("CANNIBALIZATION", r);
    need(/cannibal|overlap|same intent|consolidat|merge|differentiat/i.test(r), "no cannibalization analysis");
    need(noRaw(r), "raw endpoint name");
  });

  await step("[FRESHNESS] staleness assessment of a URL", async () => {
    const r = await ask(page, `Is the content at ${TARGET} stale, and what specifically should be refreshed to keep it current?`);
    show("FRESHNESS", r);
    need(/fresh|stale|update|outdated|recent|refresh/i.test(r), "no freshness assessment");
    need(noRaw(r), "raw endpoint name");
  });

  await step("[TRANSLATE] translate + hreflang", async () => {
    const r = await ask(page, `Translate this blog intro to Spanish and note the correct hreflang: "Faster websites keep visitors and rank better. Here is how to speed yours up."`);
    show("TRANSLATE", r);
    need(/hreflang/i.test(r), "no hreflang note");
    need(/[áéíóúñ¿¡]/i.test(r) || /(sitios|web|más|rápid|visitantes|mejor)/i.test(r), "no Spanish translation produced");
    need(noRaw(r), "raw endpoint name");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log("\n===== BLOG-8: " + passed + "/" + results.length + " | console errors: " + errs.length + " =====");
  for (const e of [...new Set(errs)].slice(0, 10)) console.log("  ! " + e.slice(0, 160));
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
