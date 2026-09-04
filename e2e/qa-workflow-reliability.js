// Workflow reliability, end to end against the deployed stack.
//
//   E2E_BASE_URL=https://app.ollasuper.com node qa-workflow-reliability.js
//
// Proves the chain the ledger exists for: a complex request is decomposed and
// tracked, incomplete work cannot be reported as complete, and — the part that
// is easy to break — an ordinary chat is untouched by any of it.
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";

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
    console.log("FAIL  " + n + " — " + e.message.split("\n")[0]);
  }
};

const generating = async (page) =>
  (await page.getByRole("button", { name: "Stop generating" }).count()) > 0;

async function settle(page, ms = 300000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await generating(page))) return;
    await page.waitForTimeout(500);
  }
  throw new Error("generation never finished");
}

/** Send a prompt and return the assistant's rendered text. */
async function ask(page, text) {
  const before = await page.locator("[data-message-role='assistant']").count();
  await page.locator("#chat-composer").fill(text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await settle(page);
  await page.waitForTimeout(1200);
  const msgs = page.locator("[data-message-role='assistant']");
  const n = await msgs.count();
  if (n <= before) {
    // Fall back to the whole transcript if the role attribute is absent.
    return await page.evaluate(
      () => (document.querySelector("main") || document.body).innerText || "",
    );
  }
  return (await msgs.nth(n - 1).innerText()) || "";
}

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 30,
  });
  const page = await (
    await b.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) {
      errs.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });

  await step("login", async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
  });

  // --- the fast path must not regress -----------------------------------
  let simpleMs = 0;
  await step("a simple question stays simple and fast", async () => {
    const t0 = Date.now();
    const answer = await ask(page, "What is the capital of France?");
    simpleMs = Date.now() - t0;
    notes.push(`simple answer took ${(simpleMs / 1000).toFixed(1)}s`);
    if (!/paris/i.test(answer)) throw new Error("did not answer the question");
    // No ledger chrome on an ordinary answer.
    if (/Not covered in this answer|incomplete evidence/i.test(answer)) {
      throw new Error("ledger report appeared on a simple answer");
    }
  });

  // --- a complex, enumerated request -------------------------------------
  let complexAnswer = "";
  await step("a 10-part request is answered", async () => {
    await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });
    complexAnswer = await ask(
      page,
      "Please do all of the following, numbered:\n" +
        "1. Define zero trust in one sentence\n" +
        "2. List three CI/CD supply-chain risks\n" +
        "3. Explain ephemeral build runners\n" +
        "4. Describe OIDC federation for pipelines\n" +
        "5. Compare short-lived and standing credentials\n" +
        "6. Outline an artifact signing approach\n" +
        "7. Recommend a network policy posture\n" +
        "8. Identify two common misconfigurations\n" +
        "9. Suggest a rollout order\n" +
        "10. Summarise the whole thing in three bullets\n",
    );
    if (complexAnswer.length < 400) {
      throw new Error(`answer too short: ${complexAnswer.length} chars`);
    }
    notes.push(`complex answer: ${complexAnswer.length} chars`);
  });

  await step("the answer is either complete OR states its shortfall", async () => {
    // The point of the ledger: these are the only two acceptable outcomes.
    // A confident answer that quietly dropped requirements is the failure.
    const flagged = /Not covered in this answer|incomplete evidence|time limit|length limit/i.test(
      complexAnswer,
    );
    // Crude coverage probe on distinctive terms from the ten asks.
    const terms = [
      "zero trust", "supply", "ephemeral", "oidc", "credential",
      "sign", "network", "misconfig", "rollout", "summar",
    ];
    const covered = terms.filter((t) =>
      new RegExp(t, "i").test(complexAnswer),
    ).length;
    notes.push(`covered ${covered}/10 topic markers; shortfall flagged: ${flagged}`);
    if (covered < 10 && !flagged) {
      throw new Error(
        `answered ${covered}/10 and claimed completion with no shortfall notice`,
      );
    }
  });

  await step("zero console errors", async () => {
    if (errs.length) throw new Error(errs.slice(0, 4).join(" | "));
  });

  await b.close();
  for (const n of notes) console.log("      " + n);
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
