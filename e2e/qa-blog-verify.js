// Prod acceptance for the Blog Assistant (headed Chrome, app.ollasuper.com).
// Representative matrix: WRITE (research→write→score loop), ANALYZE (existing URL),
// SEO regression (SEO Assistant still independent). Asserts the real UX:
// intent routing, real tool execution, pill shows real work (no raw endpoint names,
// no fake progress), Blog Quality Score (NOT a ranking), score progression, sources,
// streamed markdown, zero console errors.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-blog-verify.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const TARGET = process.env.QA_TARGET || "https://www.networkershome.com/";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 540000);

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
const pillText = (page) =>
  page.evaluate(() => {
    const els = [...document.querySelectorAll("[data-agent-activity]")];
    return els.map((e) => e.innerText).join("\n");
  });

async function ask(page, prompt) {
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
  await page.locator("#chat-composer").fill(prompt);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
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

  const noRaw = (txt) => {
    const low = txt.toLowerCase();
    return !low.includes("_endpoint") && !low.includes("find capabilities");
  };

  // ---- WRITE (flagship: research → write → score loop) --------------------
  let writeReport = "";
  await step("[WRITE] research→write→score streams to completion", async () => {
    await ask(
      page,
      "Write a concise, well-researched blog post about the benefits of server-side rendering for SEO. Research it first.",
    );
    await settle(page, WAIT_MS);
    writeReport = await answer(page);
    console.log("\n---- [WRITE] answer (first 2600) ----\n" + writeReport.slice(0, 2600) + "\n---- END ----\n");
    need(writeReport.length > 400, "write output too short");
  });
  await step("[WRITE] real tools ran + pill shows real work, no raw names", async () => {
    const pt = await pillText(page);
    console.log("    pill: " + JSON.stringify(pt.replace(/\n/g, " · ").slice(0, 200)));
    need(pt.length > 0, "no execution pill (no tools ran?)");
    need(noRaw(pt), "raw endpoint / find-capabilities leaked into the pill");
  });
  await step("[WRITE] OllaSuper Blog Quality Score present, NOT a ranking", async () => {
    const low = writeReport.toLowerCase();
    need(low.includes("blog quality score") || /\b\d{2}\/100\b/.test(writeReport), "no Blog Quality Score");
    need(low.includes("not a") && (low.includes("ranking") || low.includes("google-ranking")),
      "missing the 'not a ranking' caption");
  });
  await step("[WRITE] score progression + sources trail visible", async () => {
    const low = writeReport.toLowerCase();
    need(/\d{2}\s*(?:->|→|→)\s*\d{2}/.test(writeReport) || low.includes("progression"),
      "no score progression shown");
    need(low.includes("sources") || low.includes("http"), "no sources/evidence trail");
  });
  await step("[WRITE] streamed markdown structure (headings) + no raw names in body", async () => {
    const hasStructure = await page.evaluate(
      () => !!document.querySelector("div.my-5 h1, div.my-5 h2, div.my-5 .prose"),
    );
    need(hasStructure, "no rendered markdown structure");
    need(noRaw(writeReport), "raw endpoint name in the article body");
  });

  // ---- ANALYZE (existing URL) --------------------------------------------
  await step("[ANALYZE] existing URL → scored report", async () => {
    await ask(page, `Analyze the blog at ${TARGET} and give it a quality score with fixes.`);
    await settle(page, WAIT_MS);
    const rep = await answer(page);
    console.log("\n---- [ANALYZE] (first 1600) ----\n" + rep.slice(0, 1600) + "\n---- END ----\n");
    const low = rep.toLowerCase();
    need(rep.length > 300, "analyze output too short");
    need(low.includes("score") && (low.includes("/100") || /\b\d{2}\b/.test(rep)), "no score in analyze");
    need(noRaw(rep), "raw endpoint name in analyze output");
  });

  // ---- SEO regression (SEO Assistant still independent) -------------------
  await step("[REGRESSION] SEO Assistant still audits independently", async () => {
    await ask(page, `Audit the technical SEO of ${TARGET} — robots, redirects, headers, mixed content.`);
    await settle(page, WAIT_MS);
    const rep = await answer(page);
    const low = rep.toLowerCase();
    need(low.includes("seo health") || low.includes("crawl") || low.includes("robots"),
      "SEO audit did not produce an SEO report");
    need(noRaw(rep), "raw endpoint name in SEO output");
  });

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log("\n===== BLOG-VERIFY: " + passed + "/" + results.length +
    " | console errors: " + errs.length + " =====");
  for (const e of [...new Set(errs)].slice(0, 10)) console.log("  ! " + e.slice(0, 160));
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
