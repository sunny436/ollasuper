// MCP security remediation — production verification, headed Chrome, LIVE.
//
//   node q7-mcp-security.js                 # approvals: trusted read unasked, write asks, reject runs nothing
//   MODE=disconnect node q7-mcp-security.js # with myos-ai STOPPED: Disconnect fails closed
//   MODE=roundtrip node q7-mcp-security.js  # plane up: a real Disconnect purges + marks in one step
//   MODE=check node q7-mcp-security.js      # after reconnecting (q5): the connector is Connected and usable
//
// OllaSuper login: QA_EMAIL / QA_PASSWORD (env). Never printed.
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const EMAIL = process.env.QA_EMAIL || "";
const PASSWORD = process.env.QA_PASSWORD || "";
const MODE = process.env.MODE || "approvals";
const CONNECTED_HINT = "OllaSuper can use this app's tools when a request needs them";

const errs = [];
const results = [];
const notes = [];
const step = async (n, f) => {
  try {
    await f();
    results.push(`PASS ${n}`);
  } catch (e) {
    results.push(`FAIL ${n}: ${String(e.message || e).slice(0, 300)}`);
  }
};
const visible = async (loc) => (await loc.count()) > 0 && (await loc.first().isVisible().catch(() => false));

async function login(page) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/login/, { timeout: 25000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
}

/** Ask, and watch for an approval card. `decide` = "approve" | "reject" | null (never expected). */
async function ask(page, text, { decide = null, waitMs = 150000 } = {}) {
  await page.goto(BASE + "/en/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea, [contenteditable='true']", { timeout: 20000 });
  const box = page.locator("textarea, [contenteditable='true']").first();
  await box.click();
  await box.fill(text);
  await page.keyboard.press("Enter");
  const started = Date.now();
  let last = "";
  let stable = 0;
  let sawApproval = false;
  const replyOf = (body) => body.slice(body.lastIndexOf("Assistant"));
  while (Date.now() - started < waitMs) {
    await page.waitForTimeout(3000);
    const approve = page.getByRole("button", { name: /^Approve$/i });
    const reject = page.getByRole("button", { name: /^Reject$/i });
    if (await visible(approve)) {
      sawApproval = true;
      if (decide === "approve") await approve.first().click();
      else if (decide === "reject") await reject.first().click();
      else break; // an unexpected gate: report it, do not act
      stable = 0;
      continue;
    }
    const body = await page.locator("body").innerText();
    stable = body === last ? stable + 1 : 0;
    last = body;
    if (stable >= 3 && replyOf(body).length > 160) break;
  }
  return { reply: replyOf(last), sawApproval };
}

(async () => {
  const b = await chromium.launch({ channel: "chrome", headless: false, slowMo: 20 });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) errs.push(`HTTP ${r.status()} ${r.url()}`);
  });

  try {
    await step("login", () => login(page));

    if (MODE === "approvals") {
      await step("H-05: a trusted server's declared READ runs with no approval (Gmail labels)", async () => {
        const { reply, sawApproval } = await ask(page, "Look at my Gmail and tell me the names of my Gmail labels.");
        if (sawApproval) throw new Error("an approval card appeared for a trusted read");
        if (!/inbox|label|sent|draft|starred|important/i.test(reply)) throw new Error("no label-shaped answer: " + reply.slice(0, 200));
        notes.push("gmail read reply: " + reply.replace(/\s+/g, " ").slice(0, 140));
      });

      await step("H-05: a trusted server's WRITE asks, and Reject runs nothing (Gmail draft)", async () => {
        const { reply, sawApproval } = await ask(
          page,
          "Create a Gmail draft addressed to myself with the subject 'OllaSuper security check' and body 'hello'. Do not send it.",
          { decide: "reject" },
        );
        if (!sawApproval) throw new Error("no approval card for a write");
        if (/created|saved|done|drafted/i.test(reply) && !/not approved|rejected|declin|didn.t|did not|cancel/i.test(reply)) {
          throw new Error("the reply claims the write happened after a rejection: " + reply.slice(0, 200));
        }
        notes.push("gmail write after reject: " + reply.replace(/\s+/g, " ").slice(0, 140));
      });

      await step("H-05: an UNTRUSTED server's read asks (Context7 docs lookup)", async () => {
        const { sawApproval } = await ask(
          page,
          "Use the Context7 connector to look up the documentation for the React useEffect hook and summarize it in two lines.",
          { decide: "reject" },
        );
        if (!sawApproval) throw new Error("no approval card for an untrusted server's read");
      });
    }

    if (MODE === "disconnect") {
      await step("H-04: with the AI plane down, Disconnect fails closed (Gmail stays connected)", async () => {
        await page.goto(BASE + "/en/settings/connectors/gmail", { waitUntil: "domcontentloaded" });
        // With the plane down the status probe cannot answer, so the page will
        // not show the "can use this app's tools" line; the Disconnect button is
        // what a credentialed connector always offers.
        const btn = page.getByRole("button").filter({ hasText: /^Disconnect$/ }).first();
        await btn.waitFor({ timeout: 40000 });
        await btn.click();
        const confirm = page.getByRole("dialog").getByRole("button").filter({ hasText: /Disconnect/ }).last();
        await confirm.waitFor({ timeout: 10000 });
        await confirm.click();
        await page.waitForTimeout(8000);
        const text = await page.locator("body").innerText();
        if (!/couldn.t disconnect|could not be reached|try again|not be disconnected/i.test(text)) {
          throw new Error("no error toast after a failed disconnect: " + text.replace(/\s+/g, " ").slice(0, 300));
        }
        if (/^Disconnected$|Not connected/im.test(text)) throw new Error("the connector reads disconnected");
        if (!(await visible(page.getByRole("button").filter({ hasText: /^Disconnect$/ })))) {
          throw new Error("the Disconnect button is gone — the row changed");
        }
        notes.push("disconnect refused with a toast; row unchanged");
      });
    }

    if (MODE === "roundtrip") {
      // The plane is UP: a real disconnect must purge the credential and mark
      // the row in one step, and the page must then offer Connect again.
      await step("H-04/H-17: a confirmed disconnect purges and marks, in one step", async () => {
        await page.goto(BASE + "/en/settings/connectors/gmail", { waitUntil: "domcontentloaded" });
        await page.waitForFunction((h) => document.body.innerText.includes(h), CONNECTED_HINT, { timeout: 40000 });
        const btn = page.getByRole("button").filter({ hasText: /^Disconnect$/ }).first();
        await btn.waitFor({ timeout: 20000 });
        await btn.click();
        // The confirmation dialog.
        const confirm = page.getByRole("dialog").getByRole("button").filter({ hasText: /Disconnect/ }).last();
        await confirm.waitFor({ timeout: 10000 });
        await confirm.click();
        await page.waitForFunction(() => document.body.innerText.includes("Disconnected"), null, { timeout: 30000 });
        await page.waitForTimeout(3000);
        const text = await page.locator("body").innerText();
        if (text.includes(CONNECTED_HINT)) throw new Error("still reads Connected after disconnect");
        const connect = page.getByRole("button").filter({ hasText: /^(Connect|Reconnect)$/ });
        if (!(await visible(connect))) throw new Error("no Connect button after disconnect");
        notes.push("gmail disconnected; Connect offered again");
      });
    }

    if (MODE === "check") {
      await step("H-04: after the plane is back, Gmail is still Connected and usable", async () => {
        await page.goto(BASE + "/en/settings/connectors/gmail", { waitUntil: "domcontentloaded" });
        await page.waitForFunction((h) => document.body.innerText.includes(h), CONNECTED_HINT, { timeout: 40000 });
        const { reply, sawApproval } = await ask(page, "Look at my Gmail and tell me the names of my Gmail labels.");
        if (sawApproval) throw new Error("an approval card appeared for a trusted read");
        if (!/inbox|label|sent|draft/i.test(reply)) throw new Error("no label-shaped answer: " + reply.slice(0, 200));
      });
    }
  } finally {
    await b.close();
  }

  const benign = errs.filter((e) => !/favicon|third-party cookie|HTTP 4\d\d .*google|HTTP 5\d\d .*google/i.test(e));
  console.log(results.join("\n"));
  for (const n of notes) console.log("note: " + n);
  console.log(`console/network errors: ${benign.length}`);
  for (const e of benign.slice(0, 8)) console.log("  " + e.slice(0, 200));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  process.exit(failed || benign.length ? 1 : 0);
})();
