// Projects — does Project context survive a crowded context window?
//
// Four things compete for one budget: Project instructions, Project memory,
// retrieved file chunks, and the conversation itself. The failure this guards
// against is not a crash — it is SILENT TRUNCATION, where everything still
// "works" but the Project instruction quietly stopped being included and the
// model answers as if the Project did not exist.
//
// So the test crowds the window deliberately:
//   * Project instructions at ~7.9k chars (the cap is 8k)
//   * two large source documents (~120KB each, hundreds of chunks)
//   * a Project memory
//   * a multi-turn conversation
//   * a final user turn of ~20k characters
//
// and then asks one question whose answer proves three things at once: the run
// COMPLETED (nothing overflowed), the INSTRUCTION still governed (a guard token
// the instruction demands), and RETRIEVAL still worked (a marker only the file
// contains).
//
// HONEST LIMIT: AI_LOG_CONTENT=0 on production and it must stay that way, so the
// assembled prompt is never inspected and no token count is read. "Bounded" here
// means the run completed and the critical Project context survived — not a
// measured token total.
//
//   E2E_BASE_URL=https://app.ollasuper.com CONVEX_URL=http://127.0.0.1:3210 \
//     node qa-projects-context-budget.js
const { chromium } = require("playwright");
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";

const RUN = Date.now().toString(36).slice(-6);
const GUARD = `STRESSGUARD${RUN.toUpperCase()}`;
const MARK = `STRESSMARKER${RUN.toUpperCase()}`;

const errs = [];
const results = [];
const notes = [];
const step = async (n, f) => {
  try {
    await f();
    results.push(true);
    console.log("PASS  " + n);
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + n + " — " + String(e.message).split("\n")[0]);
  }
};

const settle = async (page, ms = 300000) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ timeout: 30000 }).catch(() => {});
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await stop.count()) === 0) return true;
    await page.waitForTimeout(600);
  }
  return false;
};

const send = async (page, text, ms = 300000) => {
  await page.locator("#chat-composer").fill(text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1800);
  await settle(page, ms);
};

async function admin() {
  const c = new ConvexHttpClient(CONVEX_URL);
  const r = await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email: EMAIL, password: PASSWORD, flow: "signIn" },
  });
  const a = new ConvexHttpClient(CONVEX_URL);
  a.setAuth(r.tokens.token);
  return a;
}

function bigDoc(label, withMarker) {
  const tmp = path.join(os.tmpdir(), `qa-budget-${label}-${RUN}.txt`);
  const out = [];
  for (let i = 0; i < 400; i++) {
    out.push(
      `Chapter ${i} of the ${label} operations manual. Procurement cadence, vendor scoring rubric, escalation ladders, staffing ratios, quarterly review posture, and the standing exceptions register are described here in deliberately repetitive prose so the document yields many chunks.`,
    );
    if (withMarker && i === 250) out.push(`The stress verification marker is ${MARK}.`);
  }
  fs.writeFileSync(tmp, out.join("\n\n"), "utf8");
  return tmp;
}

/** ~7.9k chars: just under the 8k instruction cap. */
function hugeInstructions() {
  const head =
    `You are supporting a long-running operations programme. ` +
    `RULE ONE, WHICH OVERRIDES EVERYTHING ELSE IN THIS BLOCK: every single reply you write must end with the token ${GUARD} on its own line. ` +
    `Never omit it, no matter how long the conversation becomes or how much material you are given. `;
  const filler =
    "Additional standing guidance: prefer tables over prose for comparisons; cite the source document when you use one; " +
    "keep recommendations to three bullets; use British English; never speculate about pricing; escalate anything involving " +
    "safety to a named owner; assume the reader is a busy operations lead who wants the decision first. ";
  let s = head;
  while (s.length < 7700) s += filler;
  return `${s.slice(0, 7800)}\nRemember: end every reply with ${GUARD}.`;
}

/** ~20k chars of user turn. */
function hugeQuestion() {
  const pad =
    "Context for you to consider, which is intentionally verbose and mostly redundant: the programme has run for several quarters, " +
    "vendors rotate on a rolling basis, staffing is seasonal, and the exceptions register grows during audit windows. ";
  let s = "";
  while (s.length < 19000) s += pad;
  return (
    s +
    "\n\nNow the actual question: search the project files and quote the stress verification marker verbatim. " +
    "Then give me one short sentence of advice about vendor scoring."
  );
}

(async () => {
  const C = await admin();
  const ws = (await C.query(anyApi.orgs.myWorkspaces, {}))[0]._id;

  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 35,
  });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.on("dialog", (d) => d.accept().catch(() => {}));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });

  let pid = null;
  let finalAnswer = "";

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 25000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
  });

  await step("a Project with ~7.9k characters of instructions", async () => {
    pid = await C.mutation(anyApi.projects.create, {
      workspaceId: ws,
      name: `QA Budget ${RUN}`,
    });
    const instr = hugeInstructions();
    await C.mutation(anyApi.projects.setInstructions, {
      projectId: pid,
      instructions: instr,
    });
    const back = await C.query(anyApi.projects.get, { projectId: pid });
    if (!back?.instructions || back.instructions.length < 7000)
      throw new Error(`instructions did not persist (${back?.instructions?.length} chars)`);
    console.log(`      instructions stored: ${back.instructions.length} chars`);
  });

  await step("two large source documents ingest into the Project", async () => {
    for (const [label, withMarker] of [["ALPHA", true], ["BETA", false]]) {
      const f = bigDoc(label, withMarker);
      await page.goto(BASE + `/en/projects/${pid}?tab=sources`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(1000);
      await page.locator('input[type="file"]').setInputFiles(f);
      await page
        .getByText(path.basename(f), { exact: false })
        .first()
        .waitFor({ timeout: 90000 });
      const deadline = Date.now() + 300000;
      let done = false;
      while (Date.now() < deadline && !done) {
        await page.waitForTimeout(4000);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1500);
        const body = await page.locator("body").innerText();
        if (body.includes("Couldn't be processed"))
          throw new Error(`${label} ingestion failed`);
        done = !body.includes("Processing") && !body.includes("Extracting");
      }
      if (!done) throw new Error(`${label} never finished ingesting`);
      console.log(`      ${label} ingested (${Math.round(fs.statSync(f).size / 1024)} KB)`);
    }
  });

  await step("build a multi-turn conversation inside the Project", async () => {
    await page.goto(BASE + `/en/projects/${pid}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Start chat" }).click();
    await page.waitForURL(/\/chat\?project=/, { timeout: 15000 });
    await page.waitForSelector("#chat-composer", { timeout: 15000 });
    await send(page, "Briefly, what is this project about? One sentence.");
    await send(page, "Remember for this project: the escalation owner is Priya. Save it to memory.");
    await send(page, "Name one risk in seasonal staffing. One sentence.");
    const body = await page.locator("body").innerText();
    if (!body.includes(GUARD))
      notes.push("the guard token was already missing during warm-up turns");
  });

  await step("THE STRESS TURN: ~20k-char question on top of all of it", async () => {
    await send(page, hugeQuestion(), 420000);
    finalAnswer = await page.locator("body").innerText();
  });

  await step("the run COMPLETED — nothing overflowed", async () => {
    // A context overflow surfaces as a failed generation, not a short answer.
    if (/generation failed|something went wrong|context length|too long/i.test(finalAnswer))
      throw new Error("the stressed turn reported a failure in the transcript");
    if (errs.length)
      throw new Error(`console/network errors during the stressed turn: ${errs.length}`);
  });

  await step("PROJECT INSTRUCTIONS SURVIVED the crowding (guard token present)", async () => {
    if (!finalAnswer.includes(GUARD))
      throw new Error(
        "the Project instruction was crowded out — the guard token is absent from the reply",
      );
  });

  await step("RETRIEVAL SURVIVED the crowding (file marker returned)", async () => {
    if (!finalAnswer.includes(MARK)) {
      notes.push(
        "the file marker was not quoted; retrieval may have been crowded out or the model declined",
      );
      throw new Error("the stress marker was not returned from the Project files");
    }
  });

  await step("cleanup", async () => {
    await C.mutation(anyApi.projects.remove, { projectId: pid }).catch(() => {});
  });

  const pass = results.filter(Boolean).length;
  console.log(
    `\n===== CONTEXT BUDGET STRESS: ${pass}/${results.length} | console errors: ${errs.length} =====`,
  );
  if (notes.length) console.log("notes:\n - " + notes.join("\n - "));
  await b.close();
  process.exit(pass === results.length ? 0 : 1);
})();
