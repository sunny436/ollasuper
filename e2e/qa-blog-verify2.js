// Prod acceptance batch 2 for the Blog Assistant — the faster read-then-report
// workflows + composition + file input. Headed Chrome, app.ollasuper.com.
//   OUTLINE, STRATEGY, SCHEMA, GEO, multi-intent (analyze→rewrite→GEO), FILE (.md)
//   E2E_BASE_URL=https://app.ollasuper.com node qa-blog-verify2.js
const { chromium } = require("playwright");
const path = require("node:path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const TARGET = process.env.QA_TARGET || "https://www.networkershome.com/";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 300000);
const SAMPLE = process.env.QA_FILE ||
  path.join(process.env.SCRATCH || "C:/Users/test/AppData/Local/Temp/claude/c--Users-test-Downloads-OllaSuper/93c1b126-e678-463e-bcf7-56ed5f4c04e9/scratchpad", "sample-blog.md");

const errs = [];
const results = [];
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
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && (await stop.count()) > 0)
    await page.waitForTimeout(700);
};
const answer = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    return rows[rows.length - 1]?.innerText || "";
  });
const noRaw = (t) =>
  !t.toLowerCase().includes("_endpoint") && !t.toLowerCase().includes("find capabilities");

async function newChat(page) {
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
}
async function ask(page, prompt) {
  await newChat(page);
  await page.locator("#chat-composer").fill(prompt);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
  await settle(page, WAIT_MS);
  return answer(page);
}

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 25 });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 950 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon"))
      errs.push("HTTP " + r.status() + " " + r.url());
  });

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
  });

  const show = (tag, t) =>
    console.log(`\n---- [${tag}] (first 900) ----\n${t.slice(0, 900)}\n---- END ----\n`);

  await step("[OUTLINE] SERP-informed heading structure", async () => {
    const r = await ask(page, "Create a blog outline for 'best project management tools for startups'. Research the SERP first.");
    show("OUTLINE", r);
    const low = r.toLowerCase();
    need(r.length > 200 && (r.includes("#") || low.includes("h2") || low.includes("outline")), "no outline");
    need(noRaw(r), "raw endpoint name");
  });

  await step("[STRATEGY] niche → topics/clusters", async () => {
    const r = await ask(page, "Give me a blog content strategy for a SaaS invoicing product targeting freelancers.");
    show("STRATEGY", r);
    const low = r.toLowerCase();
    need(r.length > 200 && (low.includes("cluster") || low.includes("topic") || low.includes("pillar") || low.includes("strategy")), "no strategy");
    need(noRaw(r), "raw endpoint name");
  });

  await step("[SCHEMA] generate + validate JSON-LD", async () => {
    const r = await ask(page, `Generate Article JSON-LD schema for the blog at ${TARGET} and validate it.`);
    show("SCHEMA", r);
    const low = r.toLowerCase();
    need(low.includes("json") || low.includes("@type") || low.includes("schema"), "no schema output");
    need(noRaw(r), "raw endpoint name");
  });

  await step("[GEO] AI-citation readiness of a URL", async () => {
    const r = await ask(page, `Make the page at ${TARGET} more useful for AI search — check citation readiness and answer structure.`);
    show("GEO", r);
    const low = r.toLowerCase();
    need(low.includes("citation") || low.includes("ai search") || low.includes("answer") || low.includes("geo"), "no GEO analysis");
    need(noRaw(r), "raw endpoint name");
  });

  await step("[MULTI-INTENT] analyze → why it won't rank → GEO fixes", async () => {
    const r = await ask(page, `Analyze the blog at ${TARGET}, explain why it may not rank, and give GEO-friendly fixes.`);
    show("MULTI", r);
    const low = r.toLowerCase();
    need(r.length > 300 && (low.includes("score") || low.includes("fix") || low.includes("citation")), "multi-intent thin");
    need(noRaw(r), "raw endpoint name");
  });

  await step("[FILE] upload a .md blog + analyze it", async () => {
    await newChat(page);
    await page.locator('input[type="file"]').setInputFiles(SAMPLE);
    // wait for the attachment to become ready (upload finishes → send enabled)
    await page.waitForTimeout(4000);
    await page.locator("#chat-composer").fill("Analyze this blog and give it a quality score with the top fixes.");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
    await settle(page, WAIT_MS);
    const r = await answer(page);
    show("FILE", r);
    const low = r.toLowerCase();
    // it must actually reference the uploaded content (the 5 tips / speed) — proof the file reached the model
    need(r.length > 200, "file analyze too short");
    need(low.includes("score") || low.includes("/100"), "no score for the uploaded blog");
    need(
      low.includes("image") || low.includes("cdn") || low.includes("cache") || low.includes("speed") || low.includes("website"),
      "did not reference the uploaded blog content",
    );
    need(noRaw(r), "raw endpoint name");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log("\n===== BLOG-VERIFY-2: " + passed + "/" + results.length +
    " | console errors: " + errs.length + " =====");
  for (const e of [...new Set(errs)].slice(0, 10)) console.log("  ! " + e.slice(0, 160));
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
