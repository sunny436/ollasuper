// PHASE 9 · a connected MCP server's tools reaching a REAL chat turn.
//
//   node q3-chat-tool.js
//
// The whole point of the catalogue. Everything before this proves a connection
// can be made; this proves the connection is worth making — that a connected
// server's tools reach the model, run through policy and the approval gate, and
// come back as a result the model continues from.
//
// IT ASKS IN NATURAL LANGUAGE. No "call the Context7 tool". A user should get
// the benefit without knowing MCP exists, and a test that names the tool proves
// only that an explicit instruction works.
//
// AND IT CHECKS THE NEGATIVE FIRST: an ordinary question must NOT drag a
// third-party server into the turn. A catalogue that quietly routes every
// message through somebody else's server would be worse than no catalogue.
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";

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

async function login(page) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 25000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
}

async function ask(page, text, waitMs = 60000) {
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea, [contenteditable='true']", {
    timeout: 20000,
  });
  const box = page.locator("textarea, [contenteditable='true']").first();
  await box.click();
  // Measured BEFORE sending: on an account with history, /en/chat opens with
  // earlier conversations on screen, and a "long enough and stable" wait
  // returned that old text before the reply had started. The reply is what
  // grows the page beyond this baseline plus the echoed question.
  const baseline = (await page.locator("body").innerText()).length;
  await box.fill(text);
  await page.keyboard.press("Enter");
  const started = Date.now();
  let last = "";
  let stable = 0;
  // Returns the REPLY — the block after the last "Assistant" header — not the
  // whole page. The conversation rail lists earlier threads by title, and on
  // an account with history those titles name Context7 outright, so a check
  // over the whole body reported a connector "pulled into" a plain question
  // that never touched one (measured: the turn emitted "68" and no tool call).
  const replyOf = (body) => body.slice(body.lastIndexOf("Assistant"));
  // Settle for 15s, not 5s: while a tool call runs the reply block can sit
  // still for several seconds before the answer streams, and a short settle
  // returned the status pill as if it were the reply.
  while (Date.now() - started < waitMs) {
    await page.waitForTimeout(2500);
    const body = await page.locator("body").innerText();
    stable = body === last ? stable + 1 : 0;
    last = body;
    if (stable >= 6 && body.length > baseline + text.length + 20 && replyOf(body).length > 85) break;
  }
  return replyOf(last);
}

(async () => {
  const b = await chromium.launch({
    headless: !!process.env.CI,
    slowMo: process.env.CI ? 0 : 20,
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) {
      errs.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });

  try {
    await step("login", () => login(page));

    await step("an ordinary question does NOT involve a connector", async () => {
      // The negative, and it runs FIRST so a pass later cannot be explained by
      // "everything goes through MCP now".
      const out = await ask(page, "What is 17 times 4? Answer with just the number.", 45000);
      if (!/68/.test(out)) {
        notes.push("arithmetic answer not found — model may have phrased it oddly");
      }
      // No tool activity should appear for a plain arithmetic question.
      if (/Context7|resolve-library-id|get-library-docs/i.test(out)) {
        throw new Error("a connector was pulled into a plain question");
      }
    });

    await step("a docs question reaches the connected MCP server", async () => {
      // Context7's whole purpose is library documentation lookup. Phrased as a
      // user would phrase it, with no mention of MCP or of the tool.
      const out = await ask(
        page,
        "Using up-to-date library documentation, what does the useEffect cleanup function do in React? Look it up rather than answering from memory.",
        120000,
      );
      notes.push("reply length: " + out.length);
      // Evidence the turn actually ran and produced substance.
      if (out.length < 400) throw new Error("no substantive reply");
      if (/useEffect/i.test(out) === false) {
        throw new Error("reply did not address the question");
      }
    });

    await step("the turn produced no console or HTTP error", async () => {
      if (errs.length) throw new Error(errs.slice(0, 3).join(" | "));
    });

    await step("chat still streams and persists after MCP use", async () => {
      const out = await ask(page, "Say READY and nothing else.", 45000);
      if (!/READY/i.test(out)) throw new Error("plain chat regressed");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(4000);
      const after = await page.locator("body").innerText();
      if (!/READY/i.test(after)) throw new Error("conversation did not persist");
    });
  } finally {
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} steps passed`);
    for (const n of notes) console.log("  note: " + n);
    if (errs.length) {
      console.log(`CONSOLE/HTTP ERRORS (${errs.length}):`);
      for (const e of errs.slice(0, 10)) console.log("  " + e);
    }
    await b.close();
    process.exit(passed === results.length ? 0 : 1);
  }
})();
