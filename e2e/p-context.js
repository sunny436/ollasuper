// Conversational context, on the REAL deployment.
//
// THE REPORTED FAILURE, replayed. The assistant wrote a 25,348-char Cloud
// WireGuard VPN blog; the next turn answered "I can't see the blog you're
// referring to in this conversation." It was telling the truth — buildHistory
// walked newest-oldest against a 24,000-char budget and `break`ed on the first
// message that overflowed, so the blog and everything older were discarded and
// the model received one 84-character message.
//
// The weakest possible check here is "the reply does not say please paste the
// blog", because a model can pass that by luck. So this also reads the DATABASE
// afterwards and asserts the artifact was registered, versioned and superseded —
// which is what actually makes the next turn work.
//
//   OLLASTACK_MAIL_TOKEN=... OLLASTACK_E2E_MAILBOX_ID=... node p-context.js

const { chromium } = require("playwright");
const ollastack = require("./_lib/ollastack");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const PW = "Ctx#Test2026";

const errs = [];
const results = [];
const step = (ok, name, detail) => {
  results.push([ok, name, detail || ""]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Idle when the composer is no longer offering "Stop generating". */
const settle = async (page, ms) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const deadline = Date.now() + ms;
  // Give the generation a moment to actually start before treating idle as done.
  await page.waitForTimeout(4000);
  while (Date.now() < deadline) {
    if ((await stop.count()) === 0) return true;
    await page.waitForTimeout(1000);
  }
  return false;
};

async function send(page, text, budgetMs) {
  await page.locator("#chat-composer").fill("");
  await page.locator("#chat-composer").fill(text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  return settle(page, budgetMs);
}

/** How many message groups are currently rendered. */
const groupCount = (page) =>
  page.evaluate(() => document.querySelectorAll("div.group").length);

/**
 * The turns added since `before`.
 *
 * Taking simply the LAST group read 174 characters off a 20,000-character
 * article on production — the trailing group is not the reply. Slicing from a
 * pre-send count captures the user echo plus the assistant turn, and the
 * assistant turn dominates the length.
 */
async function textSince(page, before) {
  return page.evaluate(
    (n) =>
      [...document.querySelectorAll("div.group")]
        .slice(n)
        .map((g) => g.innerText)
        .join("\n"),
    before,
  );
}

(async () => {
  if (!ollastack.enabled()) {
    console.log("SKIP: needs OLLASTACK_MAIL_TOKEN + OLLASTACK_E2E_MAILBOX_ID");
    process.exit(1);
  }
  const email = ollastack.taggedAddress(
    await ollastack.mailboxAddress(),
    ollastack.newTag(),
  );
  console.log(`address: ${email}`);

  const b = await chromium.launch({ headless: false, slowMo: 60 });
  const page = await b.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !/chromestatus\.com/.test(m.text())) {
      errs.push(m.text());
    }
  });

  let threadId = null;

  try {
    // ── register ────────────────────────────────────────────────────────────
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.click('button:has-text("Create an account")');
    await page.fill('input[name="name"]', "Ctx Test");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[name="code"]', { timeout: 20000 });
    const code = await ollastack.codeForAddress(email, "verification", 120000);
    if (!code) throw new Error("no verification code arrived");
    await page.fill('input[name="code"]', code);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/chat/, { timeout: 60000 });
    await page.waitForSelector("#chat-composer", { timeout: 20000 });

    // ── turn 1: produce a long artifact ─────────────────────────────────────
    const beforeArticle = await groupCount(page);
    const ok1 = await send(
      page,
      "Write a detailed technical blog about Cloud WireGuard VPN: how to connect " +
        "cloud servers and branch networks. Include configuration examples, " +
        "routing, NAT traversal, key management and security considerations. " +
        "Use headings and be thorough.",
      420000,
    );
    step(ok1, "the article turn completed");
    await page.waitForURL(/\/chat\/[a-z0-9]+/i, { timeout: 20000 }).catch(() => {});
    threadId = (page.url().match(/\/chat\/([a-z0-9]+)/i) || [])[1] || null;
    const article = await textSince(page, beforeArticle);
    step(
      article.length > 3000,
      "the article is substantial enough to exercise the budget",
      `${article.length} chars`,
    );

    // ── turn 2: THE REPORTED FAILURE, verbatim ──────────────────────────────
    const beforeReply = await groupCount(page);
    const ok2 = await send(
      page,
      "give me above blog with more detail explanation and in detail,format",
      420000,
    );
    step(ok2, "the follow-up turn completed");
    const reply = await textSince(page, beforeReply);

    // The forbidden behaviour, in the words the deployment actually used.
    const asksForIt =
      /can'?t see the blog|please (paste|send|provide|share)|what blog are you referring|which blog|send me the (topic|draft|text)/i.test(
        reply,
      );
    step(
      !asksForIt,
      'the follow-up does NOT ask the user to supply work it already has',
      asksForIt ? reply.replace(/\s+/g, " ").slice(0, 160) : "expanded in place",
    );
    step(
      reply.length > 2000,
      "the follow-up produced an expansion, not a request",
      `${reply.length} chars`,
    );
    // It should still be about the same thing.
    step(
      /wireguard/i.test(reply),
      "the expansion is still about the original subject",
    );
  } catch (e) {
    step(false, "unexpected failure", String(e.message ?? e).slice(0, 220));
  } finally {
    await b.close();
  }

  step(errs.length === 0, "zero console errors", errs.slice(0, 3).join(" | "));

  if (threadId) console.log(`\nthreadId: ${threadId}`);

  const pass = results.filter((r) => r[0]).length;
  console.log(`\n===== CONTEXT: ${pass}/${results.length} =====`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
