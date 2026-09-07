// Deep Research — prod acceptance (headed Chrome on app.ollasuper.com).
// Covers: SIMPLE => no research; genuine RESEARCH => cited multi-source synthesis
// (sources + conflicts/uncertainty/gaps); SEO regression; Blog regression. Prints
// FULL outputs for human reading; asserts behavior; 0 console errors gate.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-research.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const TARGET = process.env.QA_TARGET || "https://www.networkershome.com/";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 420000);

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
  while (Date.now() < d && (await stop.count()) > 0) await page.waitForTimeout(800);
};
const answer = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    return rows[rows.length - 1]?.innerText || "";
  });
const pillText = (page) =>
  page.evaluate(() => {
    const el = document.querySelector("[data-agent-activity]");
    return el ? el.innerText.replace(/\s+/g, " ").trim() : "";
  });
const noRaw = (t) =>
  !t.toLowerCase().includes("_endpoint") &&
  !t.toLowerCase().includes("find capabilities") &&
  !t.toLowerCase().includes("record_research");
async function ask(page, prompt) {
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
  await page.locator("#chat-composer").fill(prompt);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
  await settle(page, WAIT_MS);
  return { text: await answer(page), pill: await pillText(page) };
}
const show = (tag, r) =>
  console.log(
    `\n---- [${tag}] pill: ${JSON.stringify(r.pill).slice(0, 200)}\n${r.text}\n---- END ${tag} ----\n`,
  );

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 20 });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 950 } })
  ).newPage();
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon"))
      errs.push("HTTP " + r.status() + " " + r.url());
  });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);

  // 1) SIMPLE — a plain factual question must NOT trigger deep research.
  await step("[SIMPLE] no research, direct answer, no research tools", async () => {
    const r = await ask(page, "What is the capital of France?");
    show("SIMPLE", r);
    need(/paris/i.test(r.text), "did not answer the simple question");
    // No multi-source research apparatus for a trivial fact.
    const low = (r.text + " " + r.pill).toLowerCase();
    need(
      !low.includes("## sources") && !/reading \d+ sources|searching the web/i.test(r.pill),
      "deep research fired on a trivial question: " + r.pill,
    );
    need(noRaw(r.text), "raw tool identifier leaked");
  });

  // 2) RESEARCH — a genuine multi-source comparison => cited synthesis.
  await step("[RESEARCH] cited multi-source synthesis + sources + gaps", async () => {
    const r = await ask(
      page,
      "Research and compare the top 3 project management tools for a 10-person " +
        "software startup — current pricing, key features, and independent reviews. " +
        "Cite your sources and flag anything uncertain.",
    );
    show("RESEARCH", r);
    need(r.text.length > 400, "research answer too short");
    need(
      /source|reference|\[\d+\]|https?:\/\//i.test(r.text),
      "no citations / sources in the research synthesis",
    );
    need(
      /gap|uncertain|conflict|could not|limitation|caveat|note:/i.test(r.text),
      "no honest uncertainty/gaps section",
    );
    need(noRaw(r.text), "raw tool identifier leaked");
  });

  // 3) SEO regression — the SEO audit skill still works, untouched.
  await step("[SEO regression] audit still produces a report", async () => {
    const r = await ask(page, `Do a technical SEO audit of ${TARGET}`);
    show("SEO", r);
    need(
      /seo|meta|title|canonical|heading|index|robots|score/i.test(r.text),
      "SEO audit did not produce a report",
    );
    need(noRaw(r.text), "raw tool identifier leaked");
  });

  // 4) Blog regression — the Blog skill still writes a scored article.
  await step("[Blog regression] write still produces a scored article", async () => {
    const r = await ask(
      page,
      "Write a short blog post about the benefits of a CDN for website speed.",
    );
    show("BLOG", r);
    need(r.text.length > 300, "blog too short");
    need(
      /quality score|\/100|score/i.test(r.text),
      "blog was not quality-scored",
    );
    need(noRaw(r.text), "raw tool identifier leaked");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(
    "\n===== RESEARCH-QA: " +
      passed +
      "/" +
      results.length +
      " | console errors: " +
      errs.length +
      " =====",
  );
  for (const e of [...new Set(errs)].slice(0, 10)) console.log("  ! " + e.slice(0, 160));
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
