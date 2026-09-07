// Deep Research — DURABLE RESUME acceptance (headed Chrome on app.ollasuper.com).
// Turn 1: start a big research, INTERRUPT it (Stop) mid-run so the run stays
// incomplete (status=researching). Turn 2 (same thread): "continue" — the model is
// seeded from the persisted run and continues the OPEN sub-questions. Proof of the
// CODE-ENFORCED half is in the DB (one run row, continued, not duplicated); this
// script drives the two turns + prints the thread id + both answers for correlation.
//   E2E_BASE_URL=https://app.ollasuper.com node qa-research-resume.js
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const RUN1_MS = Number(process.env.QA_RUN1_MS || 80000); // let turn 1 gather some findings
const WAIT_MS = Number(process.env.QA_WAIT_MS || 420000);

const errs = [];
const answer = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.my-5")];
    return rows[rows.length - 1]?.innerText || "";
  });
const settle = async (page, ms) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ timeout: 40000 }).catch(() => {});
  const d = Date.now() + ms;
  while (Date.now() < d && (await stop.count()) > 0) await page.waitForTimeout(800);
};

(async () => {
  const b = await chromium.launch({ headless: !!process.env.CI, slowMo: 20 });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 950 } })
  ).newPage();
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3500);

  // Turn 1 — start a big research and interrupt it mid-run.
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 30000 });
  await page
    .locator("#chat-composer")
    .fill(
      "Research and compare Notion, ClickUp, Asana, Trello and Jira for a " +
        "10-person startup: current pricing, standout features, integrations, and " +
        "independent review sentiment. Cite sources and flag uncertainty.",
    );
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 25000 });
  const url = page.url();
  const threadId = url.split("/chat/")[1];
  console.log("THREAD: " + threadId);

  // Let it decompose + gather some findings, then STOP (leaves run incomplete).
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(RUN1_MS);
  if ((await stop.count()) > 0) {
    await stop.click().catch(() => {});
    console.log("INTERRUPTED turn 1 after ~" + RUN1_MS / 1000 + "s");
  } else {
    console.log("turn 1 finished before interrupt window");
  }
  await page.waitForTimeout(2500);
  console.log("\n---- TURN 1 (interrupted) ----\n" + (await answer(page)) + "\n----\n");

  // ---- PAUSE for a DB snapshot (the orchestrator reads researchRuns here) ----
  console.log("SNAPSHOT_POINT_1");
  await page.waitForTimeout(Number(process.env.QA_PAUSE_MS || 1000));

  // Turn 2 — same thread: continue. The model is seeded from the persisted run.
  await page.waitForSelector("#chat-composer:not([disabled])", { timeout: 60000 });
  await page
    .locator("#chat-composer")
    .fill("Continue the research where you left off and finish the comparison.");
  await page.keyboard.press("Enter");
  await settle(page, WAIT_MS);
  const t2 = await answer(page);
  console.log("\n---- TURN 2 (resumed) ----\n" + t2 + "\n----\n");
  console.log("SNAPSHOT_POINT_2");

  const restarted = /\b(let me start|i'?ll start|starting (the |my )?research|from scratch|begin(ning)? (the |my )?research)\b/i.test(
    t2.slice(0, 400),
  );
  console.log(
    "RESUME-QA: thread=" +
      threadId +
      " | console errors=" +
      errs.length +
      " | turn2_looks_like_restart=" +
      restarted,
  );
  await b.close();
  process.exit(errs.length === 0 && !restarted ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
