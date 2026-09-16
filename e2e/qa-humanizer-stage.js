// qa-humanizer-stage.js — the enforced humanize stage, edge to edge, on production.
//
//   QA_EMAIL=… QA_PASSWORD=… node qa-humanizer-stage.js
//   QA_ONLY=email,stop node qa-humanizer-stage.js
//
// Per turn it samples the visible answer every 400ms from send to finish, so the
// run can show from the UI (not just the server log) what the user saw WHILE the
// draft was hidden, when text first appeared, and what was finally kept. For each
// writing turn it also asserts:
//   * every fact the prompt supplied (figures, dates, links, keywords) survives;
//   * the answer never mentions humanization, a voice score or "AI patterns".
// Controls: an analysis request with the Marketing skill active, and plain chat,
// must stream as they always did. A Stop pressed during the hidden draft must
// leave no draft text behind.
//
// Output: e2e/out/humanizer-stage/<slug>.md (final text) + browser.json.
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";
const OUT = path.join(__dirname, process.env.QA_OUT || path.join("out", "humanizer-stage"));
const ONLY = (process.env.QA_ONLY || "").split(",").filter(Boolean);
const WAIT_MS = Number(process.env.QA_WAIT_MS || 540000);

const SAMPLE =
  "Quick note from us. We changed a few things this month, and we'd rather tell you " +
  "straight than bury it in a PDF. Some of it you'll like. Some of it you might not, " +
  "and that's fair. If anything here gets in your way, reply to this email and a real " +
  "person on the team will read it the same day. We read every one. We keep these " +
  "short on purpose, so here's the gist and then you can get back to your day.";

const TURNS = [
  {
    slug: "email",
    kind: "writing",
    text:
      "Write a product launch email for our new analytics feature. Audience: existing " +
      "customers. About 200 words. Say it cuts report build time from 45 minutes to " +
      "5 minutes, launches on March 3, 2026, and link to https://example.com/pulse.",
    facts: ["45 minutes", "5 minutes", "March 3, 2026", "https://example.com/pulse"],
  },
  {
    slug: "blog",
    kind: "writing",
    text:
      "Write a blog post about why incident retrospectives keep producing the same " +
      "action items. Target keyword: incident retrospectives.",
    facts: ["incident retrospective"],
  },
  {
    slug: "landing",
    kind: "writing",
    text:
      "Create landing page copy for a meditation app called Stillwater: 7-day free " +
      "trial, $9.99/month after that, and 120 guided sessions.",
    facts: ["Stillwater", "7-day", "$9.99", "120"],
  },
  {
    slug: "linkedin",
    kind: "writing",
    text: "Write a LinkedIn launch post for our new analytics dashboard feature.",
    facts: [],
  },
  {
    slug: "newsletter-sample",
    kind: "writing",
    text:
      "Draft a customer newsletter about our new pricing: Starter stays $19/month and " +
      "Team moves to $49/month on April 1, 2026. Writing sample: " +
      SAMPLE,
    facts: ["$19", "$49", "April 1, 2026"],
  },
  {
    slug: "report",
    kind: "writing",
    text:
      "Write a report summarizing Q3 sales performance with recommendations. Q3 revenue " +
      "was $1.2M, up 18% from Q2; churn fell to 3.1%; the EMEA region grew 27%.",
    facts: ["$1.2M", "18%", "3.1%", "27%"],
  },
  {
    slug: "control-analysis",
    kind: "control",
    text:
      "Analyze our email campaign funnel: 12,000 sent, 3,100 opened, 420 clicked, 38 " +
      "purchases. Calculate each conversion rate.",
    facts: ["12,000"],
  },
  { slug: "control-chat", kind: "control", text: "What is a mutex?", facts: [] },
  {
    slug: "stop",
    kind: "stop",
    text:
      "Write a product launch email for our new reporting export. Say it saves 3 hours " +
      "a week and ships on May 5, 2026.",
    facts: [],
  },
].filter((t) => !ONLY.length || ONLY.includes(t.slug));

// Mentions of the stage itself. Not "human voice": meditation copy legitimately
// promised a calm human voice.
const SILENCE = /humaniz|voice score|writing[- ]quality (?:score|pass|check)|ai[- ]writing pattern|machine[- ]written/i;

const errs = [];
const results = [];

// The ANSWER only: the assistant row also carries a header (name, time) and
// the activity pill, which made the first cut report text at ~3s on every turn.
async function lastAnswer(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    const row = rows[rows.length - 1];
    return row?.querySelector("[aria-live]")?.innerText || "";
  });
}

async function newChat(page, text) {
  await page.goto(`${BASE}/en/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
  await page.locator("#chat-composer").fill(text);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 30000 });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ channel: "chrome", headless: false, slowMo: 10 });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push(`pageerror ${e.message}`));
  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);

    for (const t of TURNS) {
      const sent = Date.now();
      await newChat(page, t.text);
      const thread = page.url().split("/").pop();
      const stop = page.getByRole("button", { name: "Stop generating" });
      const timeline = [];
      let firstTextMs = null;
      let firstText = "";
      let stoppedAt = null;
      const deadline = Date.now() + WAIT_MS;
      await stop.waitFor({ timeout: 60000 }).catch(() => {});
      while (Date.now() < deadline) {
        const txt = await lastAnswer(page);
        const ms = Date.now() - sent;
        const generating = (await stop.count()) > 0;
        if (txt.trim() && firstTextMs === null) {
          firstTextMs = ms;
          firstText = txt.slice(0, 300);
        }
        if (timeline.length < 1500) timeline.push([ms, txt.length, generating ? 1 : 0]);
        if (t.kind === "stop" && stoppedAt === null && ms > 6000 && generating) {
          await stop.click().catch(() => {});
          stoppedAt = ms;
        }
        if (!generating && ms > 3000) break;
        await page.waitForTimeout(400);
      }
      await page.waitForTimeout(2500);
      const finalText = await lastAnswer(page);
      fs.writeFileSync(path.join(OUT, `${t.slug}.md`), finalText);
      await page.screenshot({ path: path.join(OUT, `${t.slug}.png`) });

      const missing = t.facts.filter((f) => !finalText.includes(f));
      const silent = !SILENCE.test(finalText);
      const failed = /had a problem|took too long|could not complete|could not reach/i.test(finalText);
      let ok;
      if (t.kind === "stop") {
        ok = stoppedAt !== null && !failed;
      } else {
        ok = finalText.length > 40 && !failed && missing.length === 0 && silent;
      }
      const r = {
        slug: t.slug,
        kind: t.kind,
        ok,
        thread,
        sentUtc: new Date(sent).toISOString(),
        totalMs: Date.now() - sent,
        firstTextMs,
        firstText,
        stoppedAtMs: stoppedAt,
        chars: finalText.length,
        missingFacts: missing,
        silent,
        timeline,
      };
      results.push(r);
      console.log(
        `${ok ? "PASS" : "FAIL"}  ${t.slug.padEnd(18)} total ${(r.totalMs / 1000).toFixed(1)}s  ` +
          `first text ${firstTextMs === null ? "-" : (firstTextMs / 1000).toFixed(1) + "s"}  ` +
          `${r.chars} chars  thread ${thread}` +
          (missing.length ? `  MISSING ${missing.join(" | ")}` : "") +
          (silent ? "" : "  MENTIONS-HUMANIZATION") +
          (stoppedAt ? `  stopped@${(stoppedAt / 1000).toFixed(1)}s` : ""),
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
