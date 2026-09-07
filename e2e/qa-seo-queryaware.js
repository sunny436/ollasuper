// Prod acceptance gate for the QUERY-AWARE streamed SEO report.
// Drives headed Chrome against app.ollasuper.com, logs in, and runs 5 DIFFERENT
// query types in fresh threads, proving the report ADAPTS (not a fixed template):
//   technical-only / single-page on-page / diagnostic / full audit / concept.
// Prints each streamed report for senior-auditor inspection + asserts per-type
// markers, and hard-fails on any console error.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-seo-queryaware.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const TARGET = process.env.QA_TARGET || "https://www.networkershome.com/";
const WAIT_MS = Number(process.env.QA_WAIT_MS || 300000);

const errs = [];
const results = [];
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
  await stop.waitFor({ timeout: 30000 }).catch(() => {});
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await stop.count()) === 0) return true;
    await page.waitForTimeout(500);
  }
  return false;
};
const grabReport = (page) =>
  page.evaluate(() => {
    const nodes = [
      ...document.querySelectorAll(
        "[data-message-role='assistant'], .prose, article",
      ),
    ];
    let best = "";
    for (const n of nodes) {
      const t = n.innerText || "";
      if (t.length > best.length) best = t;
    }
    return best || document.body.innerText;
  });

// One query type: fresh thread -> send -> settle -> capture -> assert.
async function run(page, label, prompt, assert, { expectCard = false } = {}) {
  await step(`[${label}] send + stream to completion`, async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 15000 });
    await page.locator("#chat-composer").fill(prompt);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
    if (!(await settle(page, WAIT_MS)))
      throw new Error("generation did not finish within the wait window");
  });
  const report = await grabReport(page);
  console.log(
    `\n========== [${label}] REPORT (first 2800 chars) ==========\n` +
      report.slice(0, 2800) +
      `\n========== [${label}] END (len=${report.length}) ==========\n`,
  );
  await step(`[${label}] no report CARD renders`, async () => {
    const card = page.locator('[aria-label="SEO audit report"]');
    if ((await card.count()) > 0 !== expectCard)
      throw new Error("card presence mismatch");
  });
  await step(`[${label}] no harmony tool-call leak in the report`, async () => {
    const low = report.toLowerCase();
    for (const marker of ["to=functions.", "multi_tool_use.parallel", "code:\n{"]) {
      if (low.includes(marker.toLowerCase()))
        throw new Error(`harmony leak present: "${marker}"`);
    }
    // Orphan `to=` prefix glued onto prose (e.g. `to=# SEO Audit`).
    const orphan = report.match(/to=(?![A-Za-z0-9_.])/);
    if (orphan) throw new Error(`orphan harmony 'to=' present near: ${orphan.index}`);
  });
  await step(`[${label}] content assertions`, async () =>
    assert(report, report.toLowerCase()),
  );
  return report;
}

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 30,
  });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 950 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon"))
      errs.push(`HTTP ${r.status()} ${r.url()}`);
  });

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 15000 });
  });

  const need = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  // 1) TECHNICAL-ONLY — scoped to technical signals, health score present.
  await run(
    page,
    "technical-only",
    `Check ONLY the technical SEO of ${TARGET} — robots.txt, redirects, HTTPS/SSL, ` +
      `mixed content and response headers. Keep it to the technical side.`,
    (r, low) => {
      need(low.includes("seo health") || /\b\d{1,3}\/100\b/.test(r), "no health score");
      need(
        ["robots", "redirect", "https", "header", "mixed content"].some((k) =>
          low.includes(k),
        ),
        "no technical signals",
      );
    },
  );

  // 2) SINGLE-PAGE ON-PAGE — page-level, on-page findings.
  await run(
    page,
    "onpage-page",
    `Audit ONLY the on-page SEO of this single page ${TARGET} — title tag, meta ` +
      `description, headings (H1/H2), and structured data. Just this one URL.`,
    (r, low) => {
      need(
        ["title", "meta description", "h1", "heading", "structured data"].some((k) =>
          low.includes(k),
        ),
        "no on-page signals",
      );
      need(low.includes("finding") || low.includes("seo health"), "no findings/score");
    },
  );

  // 3) DIAGNOSTIC — honest about the rankings/GSC gap.
  await run(
    page,
    "diagnostic",
    `Why isn't my site ${TARGET} ranking well on Google? Diagnose it.`,
    (r, low) => {
      need(
        ["search console", "gsc", "first-party", "not assessed", "unsupported", "analytics"].some(
          (k) => low.includes(k),
        ),
        "diagnostic did not honestly flag the rankings/GSC data gap",
      );
    },
  );

  // 4) FULL AUDIT — comprehensive, multiple categories.
  await run(
    page,
    "full-audit",
    `Do a FULL SEO audit of ${TARGET} — crawl the key pages and cover everything.`,
    (r, low) => {
      need(low.includes("seo health") || /\b\d{1,3}\/100\b/.test(r), "no overall health");
      const cats = ["crawl", "on-page", "technical", "content"].filter((k) =>
        low.includes(k),
      );
      need(cats.length >= 3, "full audit not multi-category; cats=" + cats.join(","));
    },
  );

  // 5) CONCEPT — pure explanation, NO audit machinery.
  await run(
    page,
    "concept",
    `What is a canonical tag and when should I use one?`,
    (r, low) => {
      need(low.includes("canonical"), "concept answer missing 'canonical'");
      need(
        !low.includes("seo health:") && !/\bseo health\b[^a-z]/.test(low),
        "concept question wrongly produced a health-scored audit",
      );
    },
  );

  await b.close();
  const passed = results.filter(Boolean).length;
  console.log(
    `\n===== SEO QUERY-AWARE QA: ${passed}/${results.length} | console errors: ${errs.length} =====`,
  );
  for (const e of errs) console.log("  - " + e);
  process.exit(passed === results.length && errs.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
