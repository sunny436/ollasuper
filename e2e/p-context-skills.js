// Conversational continuity ACROSS SKILLS, on the real deployment.
//
// The context layer is deliberately not per-skill: it enters at the single seam
// every turn passes through (build_system_prompt in runner.py), because skills
// self-declare and there is no central router. This asserts that property the
// only way that actually counts — by driving each skill through a follow-up that
// is meaningless without state, and checking it is not asked to repeat itself.
//
// Outputs are deliberately kept SHORT ("about 300 words"). The mechanism under
// test is reference resolution, not length; a 25k-char generation per scenario
// would make the suite too slow to run and prove nothing extra. p-context.js
// covers the long-artifact case that motivated all of this.
//
//   OLLASTACK_MAIL_TOKEN=... OLLASTACK_E2E_MAILBOX_ID=... node p-context-skills.js
//   MODES=revert,multi node p-context-skills.js     # run a subset

const { chromium } = require("playwright");
const ollastack = require("./_lib/ollastack");

const BASE = process.env.E2E_BASE_URL || "https://app.ollasuper.com";
const PW = "CtxSkill#2026";
const ONLY = (process.env.MODES || "").split(",").filter(Boolean);

const errs = [];
const rows = [];

/** The reply must not ask for work the conversation already contains. */
const ASKS_AGAIN =
  /can'?t see|please (paste|send|provide|share|specify)|which (blog|article|report|one|version)|what (blog|article|topic|code) (are you|do you)|could you (paste|share|provide)|i (don'?t|do not) have (the|access)/i;

const settle = async (page, ms) => {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const deadline = Date.now() + ms;
  await page.waitForTimeout(4000);
  while (Date.now() < deadline) {
    if ((await stop.count()) === 0) return true;
    await page.waitForTimeout(1000);
  }
  return false;
};

const groupCount = (page) =>
  page.evaluate(() => document.querySelectorAll("div.group").length);

const textSince = (page, n) =>
  page.evaluate(
    (from) =>
      [...document.querySelectorAll("div.group")]
        .slice(from)
        .map((g) => g.innerText)
        .join("\n"),
    n,
  );

async function say(page, text, budgetMs = 300000) {
  const before = await groupCount(page);
  await page.locator("#chat-composer").fill("");
  await page.locator("#chat-composer").fill(text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  await settle(page, budgetMs);
  return textSince(page, before);
}

/**
 * Each scenario: a first turn that PRODUCES something, then turns that can only
 * work if the system knows what "it" / "that" / "the previous version" mean.
 * `expect` runs against the final reply.
 */
const SCENARIOS = [
  {
    id: "seo",
    turns: [
      "Write a short blog post of about 300 words on why HTTPS matters for SEO.",
      "Audit the above post for SEO and list the top 3 issues.",
      "Apply those recommendations and give me the improved post.",
    ],
    expect: (t) => /https/i.test(t),
    why: "APPLY_AUDIT must resolve both the audit and the post it audited",
  },
  {
    id: "research",
    turns: [
      "In about 250 words, research and summarise what WebAuthn passkeys are.",
      "Turn that into a short LinkedIn post.",
    ],
    expect: (t) => /passkey|webauthn/i.test(t),
    why: "TRANSFORM must carry the subject across a format change",
  },
  {
    id: "coding",
    turns: [
      "Write a small Python function that parses an ISO-8601 duration string.",
      "Add error handling to it and explain what you changed.",
    ],
    expect: (t) => /def |raise|except/i.test(t),
    why: "an EXTEND on code must edit the function, not ask for it",
  },
  {
    id: "continue",
    turns: [
      "List the 8 most important considerations when self-hosting Postgres. Give the first 3 only.",
      "Continue from where you stopped.",
    ],
    expect: (t) => t.length > 200,
    why: "CONTINUE has no subject of its own at all",
  },
  {
    id: "multi",
    turns: [
      "In about 150 words, explain what PostgreSQL is best at.",
      "Now in about 150 words, explain what Redis is best at.",
      "Go back to PostgreSQL.",
      "Compare that with Redis for session storage.",
    ],
    expect: (t) => /postgres/i.test(t) && /redis/i.test(t),
    why: "`that` must bind to the RE-ACTIVATED subject, not the one just named",
  },
  {
    id: "revert",
    turns: [
      "Write a 200-word product description for a noise-cancelling headphone.",
      "Make it much more playful and informal.",
      "Actually, go back to the previous version.",
    ],
    expect: (t) => /headphone|noise/i.test(t),
    why: "REVERT must walk the version lineage, not the transcript",
  },
  {
    id: "section",
    turns: [
      "Write a short guide (about 350 words) to securing an SSH server, with headings including one called Security.",
      "Rewrite the security section to be more detailed.",
    ],
    expect: (t) => /ssh/i.test(t),
    why: "a SECTION reference resolves within the active artifact",
  },
  {
    id: "newtask",
    turns: [
      "Write a 150-word intro about Kubernetes networking.",
      "Now write a completely separate 150-word intro about Terraform state locking.",
    ],
    // The opposite failure: a NEW task must NOT be treated as an edit of the old.
    expect: (t) => /terraform/i.test(t) && !/kubernetes/i.test(t.slice(0, 400)),
    why: "a fresh CREATE must not be hijacked into editing prior work",
  },
];

(async () => {
  if (!ollastack.enabled()) {
    console.log("SKIP: needs OLLASTACK_MAIL_TOKEN + OLLASTACK_E2E_MAILBOX_ID");
    process.exit(1);
  }
  const email = ollastack.taggedAddress(
    await ollastack.mailboxAddress(),
    ollastack.newTag(),
  );
  console.log(`address: ${email}\n`);

  const b = await chromium.launch({ headless: false, slowMo: 40 });
  const page = await b.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !/chromestatus\.com/.test(m.text())) {
      errs.push(m.text());
    }
  });

  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/login/, { timeout: 20000 });
    await page.click('button:has-text("Create an account")');
    await page.fill('input[name="name"]', "Ctx Skills");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[name="code"]', { timeout: 20000 });
    const code = await ollastack.codeForAddress(email, "verification", 120000);
    if (!code) throw new Error("no verification code arrived");
    await page.fill('input[name="code"]', code);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/chat/, { timeout: 60000 });

    for (const sc of SCENARIOS) {
      if (ONLY.length && !ONLY.includes(sc.id)) continue;
      // A FRESH thread per scenario, so one scenario's artifacts cannot
      // accidentally satisfy another's reference.
      await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#chat-composer", { timeout: 20000 });

      let last = "";
      for (const t of sc.turns) last = await say(page, t);

      const asked = ASKS_AGAIN.test(last);
      const ok = !asked && last.length > 150 && sc.expect(last);
      rows.push({ id: sc.id, ok, asked, len: last.length, why: sc.why });
      console.log(
        `${ok ? "PASS" : "FAIL"}  ${sc.id.padEnd(9)} ${sc.why}` +
          (ok
            ? `  (${last.length} chars)`
            : asked
              ? `\n        asked again: ${last.replace(/\s+/g, " ").slice(0, 150)}`
              : `\n        unexpected reply (${last.length} chars): ${last.replace(/\s+/g, " ").slice(0, 150)}`),
      );
    }
  } catch (e) {
    rows.push({ id: "harness", ok: false, why: String(e.message ?? e).slice(0, 200) });
    console.log(`FAIL  harness — ${String(e.message ?? e).slice(0, 200)}`);
  } finally {
    await b.close();
  }

  const cleanConsole = errs.length === 0;
  console.log(
    `${cleanConsole ? "PASS" : "FAIL"}  console    zero console errors` +
      (cleanConsole ? "" : `  ${errs.slice(0, 2).join(" | ")}`),
  );

  const pass = rows.filter((r) => r.ok).length + (cleanConsole ? 1 : 0);
  const total = rows.length + 1;
  console.log(`\n===== CONTEXT ACROSS SKILLS: ${pass}/${total} =====`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
