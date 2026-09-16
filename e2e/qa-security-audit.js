// qa-security-audit.js — security audits in chat, edge to edge, on production.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-security-audit.js
//   QA_ONLY=fixture,fix-approve node qa-security-audit.js
//
// What the UI must show, per turn (the server-side evidence — routed model, the
// secaudit.report verdict, file hashes on the VM — is collected from the journal
// and over ssh alongside this run, not from here):
//   * a security AUDIT ends with the system-validated report and an honest verdict;
//   * a plain security QUESTION and a normal chat get no report;
//   * no planted fixture secret value is ever visible;
//   * an inaccessible GitHub repository is BLOCKED, never clean;
//   * a fix shows an approval card; Reject applies nothing; Approve applies,
//     retests and reports.
//
// Output: e2e/out/secaudit/<slug>.md (final visible text) + browser.json.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";
const OUT = path.join(__dirname, process.env.QA_OUT || path.join("out", "secaudit"));
const ONLY = (process.env.QA_ONLY || "").split(",").filter(Boolean);
const WAIT_MS = Number(process.env.QA_WAIT_MS || 420000);
const GH_READABLE = process.env.QA_GH_REPO || "Sk09032/telegram_summarization_bot";
const GH_BLOCKED = process.env.QA_GH_BLOCKED || "sunny436/ollasuper";

// Mirrors qa/secaudit_fixture.planted(): the values are derived, never stored.
function planted(seed = "ollasuper-secaudit") {
  const h = crypto.createHash("sha256").update(seed).digest("hex");
  return [
    "gh" + "p_" + (h + h).slice(0, 36),
    "AK" + "IA" + h.slice(0, 16).toUpperCase(),
    "Pw" + h.slice(16, 40),
    "sk" + "_live_" + h.slice(40, 64),
  ];
}

const REPORT = "Security audit report (system-validated)";
const TURNS = [
  { slug: "control-chat", text: "What is a mutex?", report: false },
  { slug: "question", text: "What is SSRF?", report: false },
  {
    slug: "fixture",
    text:
      "Run a security audit of the local fixture repository: read app.py and config.py, " +
      "run the secret scan, the dependency audit and the scanners, validate what you find " +
      "and submit the report.",
    report: true,
    verdict: /Verdict: (FINDINGS|INCOMPLETE)/,
    must: ["`local:fixture` — access **verified**", "Secrets detected"],
  },
  {
    slug: "ollasuper",
    text:
      "Security audit of the local ollasuper repository: run the secret scan and the " +
      "dependency audit, review services/ai/app/secaudit/local.py for path traversal, " +
      "then submit the report.",
    report: true,
    verdict: /Verdict: /,
    must: ["`local:ollasuper` — access **verified**"],
  },
  {
    slug: "github",
    text:
      `Security review of the GitHub repository ${GH_READABLE}: verify access, read its ` +
      "main source files, look for hardcoded secrets and injection issues, then submit " +
      "the report.",
    report: true,
    verdict: /Verdict: /,
    must: [],
  },
  {
    slug: "github-blocked",
    text: `Run a security audit of the GitHub repository ${GH_BLOCKED}.`,
    report: true,
    verdict: /Verdict: BLOCKED/,
    must: [],
  },
  {
    slug: "fix-reject",
    text:
      "Fix the SSRF in app.py of the local fixture repository with one minimal change.",
    decide: "reject",
    report: true,
    verdict: /Verdict: /,
    must: [],
  },
  {
    slug: "fix-approve",
    text:
      "Fix the SSRF in app.py of the local fixture repository with one minimal change, " +
      "then retest it and submit the report.",
    decide: "approve",
    report: true,
    verdict: /Verdict: /,
    must: ["Fix retest: **passed**"],
  },
].filter((t) => !ONLY.length || ONLY.includes(t.slug));

const errs = [];
const results = [];

async function lastAnswer(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    const row = rows[rows.length - 1];
    return row?.querySelector("[aria-live]")?.innerText || "";
  });
}

async function visible(loc) {
  return (await loc.count()) > 0 && (await loc.first().isVisible().catch(() => false));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ channel: "chrome", headless: false, slowMo: 10 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push(`pageerror ${e.message}`));
  const secrets = planted();
  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);

    for (const t of TURNS) {
      const sent = Date.now();
      await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
      await page.locator("#chat-composer").fill(t.text);
      await page.keyboard.press("Enter");
      await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 30000 });
      const thread = page.url().split("/").pop();
      const stop = page.getByRole("button", { name: "Stop generating" });
      let approvals = 0;
      let idle = 0;
      const deadline = Date.now() + WAIT_MS;
      await stop.waitFor({ timeout: 60000 }).catch(() => {});
      while (Date.now() < deadline) {
        await page.waitForTimeout(2500);
        const approve = page.getByRole("button", { name: /^Approve$/i });
        if (await visible(approve)) {
          approvals += 1;
          await page.screenshot({ path: path.join(OUT, `${t.slug}-approval.png`) });
          if (t.decide === "approve") await approve.first().click();
          else await page.getByRole("button", { name: /^Reject$/i }).first().click();
          idle = 0;
          continue;
        }
        const generating = (await stop.count()) > 0;
        idle = generating ? 0 : idle + 1;
        if (idle >= 3 && Date.now() - sent > 8000) break;
      }
      await page.waitForTimeout(2000);
      const finalText = await lastAnswer(page);
      fs.writeFileSync(path.join(OUT, `${t.slug}.md`), finalText);
      await page.screenshot({ path: path.join(OUT, `${t.slug}.png`), fullPage: false });

      const leaked = secrets.filter((s) => finalText.includes(s));
      const hasReport = finalText.includes(REPORT);
      const problems = [];
      if (leaked.length) problems.push(`LEAKED ${leaked.length} planted secret(s)`);
      if (hasReport !== t.report) problems.push(`report ${hasReport ? "present" : "missing"}`);
      if (t.verdict && !t.verdict.test(finalText)) problems.push("verdict mismatch");
      for (const m of t.must || []) if (!finalText.includes(m)) problems.push(`missing: ${m}`);
      if (t.decide && approvals === 0) problems.push("no approval card appeared");
      if (/\bthe (code|repository|repo) is secure\b/i.test(finalText)) problems.push("claims secure");
      if (/had a problem|could not complete/i.test(finalText)) problems.push("turn failed");
      const ok = problems.length === 0 && finalText.length > 20;
      const verdict = (finalText.match(/Verdict: ([A-Z ]+)/) || [])[1] || "-";
      const r = {
        slug: t.slug, ok, thread, sentUtc: new Date(sent).toISOString(),
        totalMs: Date.now() - sent, chars: finalText.length, hasReport, verdict,
        approvals, problems,
      };
      results.push(r);
      console.log(
        `${ok ? "PASS" : "FAIL"}  ${t.slug.padEnd(15)} ${(r.totalMs / 1000).toFixed(0)}s  ` +
          `verdict ${verdict.trim()}  approvals ${approvals}  thread ${thread}` +
          (problems.length ? `  ${problems.join(" | ")}` : ""),
      );
    }
  } finally {
    await b.close();
  }
  const benign = errs.filter((e) => !/favicon|third-party cookie/i.test(e));
  fs.writeFileSync(
    path.join(OUT, "browser.json"),
    JSON.stringify({ base: BASE, results, consoleErrors: benign }, null, 2),
  );
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed · console errors: ${benign.length}`);
  for (const e of benign.slice(0, 5)) console.log(`  ${e.slice(0, 160)}`);
  process.exit(results.every((r) => r.ok) && !benign.length ? 0 : 1);
})();
