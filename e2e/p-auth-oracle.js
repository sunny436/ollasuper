// Is sign-up still a password oracle? Asked of the REAL deployment.
//
// This is deliberately browserless and talks straight to `auth:signIn`. The
// defect was never reachable through the UI — the frontend masks the error
// text — so a browser test cannot prove it is closed. An attacker calls the
// action directly, so that is what this does.
//
// What it used to do, against an existing verified account:
//   wrong password  -> threw `Account <email> already exists`
//   correct password -> RETURNED A SESSION, signing the caller in
// Either answer identifies a registered address, and the pair turns sign-up
// into a password checker that the 5/hour sign-in limiter never saw.
//
//   OLLASTACK_MAIL_TOKEN=... OLLASTACK_E2E_MAILBOX_ID=... node p-auth-oracle.js

const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");
const ollastack = require("./_lib/ollastack");

const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const PASSWORD = "0racleTest#2026";
const WRONG = "C0mpletelyD1fferent#2026";

const results = [];
const step = (ok, name, detail) => {
  results.push([ok, name, detail || ""]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Every call's outcome reduced to what an attacker can actually observe. */
async function attempt(client, params) {
  try {
    const r = await client.action(anyApi.auth.signIn, {
      provider: "password",
      params,
    });
    return {
      threw: false,
      // A session is the jackpot; `started` means "a code was sent".
      signedIn: Boolean(r?.tokens),
      started: Boolean(r?.started),
    };
  } catch (e) {
    return { threw: true, message: String(e.message ?? e).slice(0, 120) };
  }
}

(async () => {
  if (!ollastack.enabled()) {
    console.log("SKIP: needs OLLASTACK_MAIL_TOKEN + OLLASTACK_E2E_MAILBOX_ID");
    process.exit(1);
  }
  const tag = ollastack.newTag();
  const email = ollastack.taggedAddress(await ollastack.mailboxAddress(), tag);
  console.log(`address: ${email}`);

  const c = new ConvexHttpClient(CONVEX_URL);

  // Register and verify, so the target is a real, live account.
  await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, password: PASSWORD, flow: "signUp" },
  });
  const code = await ollastack.codeForAddress(email, "verification", 120000);
  if (!code) throw new Error("no verification code arrived");
  const verified = await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, code, flow: "email-verification" },
  });
  step(Boolean(verified?.tokens), "target account is registered and verified");

  // Baseline the mailbox: the collision assertions below are about what does
  // NOT arrive, and codeForAddress returns the newest code whether or not a
  // new one was sent, so counting messages is the only honest measure.
  const tagMail = () => ollastack.messagesForTag(tag);
  const before = (await tagMail()).length;

  // ── the oracle ─────────────────────────────────────────────────────────────
  const right = await attempt(c, { email, password: PASSWORD, flow: "signUp" });
  const wrong = await attempt(c, { email, password: WRONG, flow: "signUp" });

  step(
    !right.signedIn,
    "a CORRECT password on sign-up does not return a session",
    right.signedIn ? "SIGNED IN — the bypass is live" : "no tokens",
  );
  step(
    !right.threw && !wrong.threw,
    "neither outcome throws",
    right.threw || wrong.threw
      ? `right:${right.message ?? "ok"} wrong:${wrong.message ?? "ok"}`
      : "both resolved",
  );
  step(
    JSON.stringify(right) === JSON.stringify(wrong),
    "correct and wrong passwords are indistinguishable",
    `${JSON.stringify(right)} vs ${JSON.stringify(wrong)}`,
  );

  // An unknown address must look the same as a known one.
  const unknown = ollastack.taggedAddress(
    await ollastack.mailboxAddress(),
    ollastack.newTag(),
  );
  const fresh = await attempt(c, {
    email: unknown,
    password: PASSWORD,
    flow: "signUp",
  });
  step(
    JSON.stringify(fresh) === JSON.stringify(wrong),
    "a REGISTERED address is indistinguishable from a fresh one",
    `${JSON.stringify(fresh)} vs ${JSON.stringify(wrong)}`,
  );

  // ── the enumeration helper ────────────────────────────────────────────────
  let exposed = false;
  try {
    await c.query(anyApi.authSessions.accountExists, { email });
    exposed = true;
  } catch {
    exposed = false;
  }
  step(!exposed, "accountExists is not callable from the public API");

  // ── a collision must send NOTHING ─────────────────────────────────────────
  //
  // This asserted the opposite until the Better Auth comparison: a collision
  // used to email a verification code for the EXISTING account, and completing
  // that code marks the account verified. An unverified account belongs to
  // whoever squatted the address, so the real owner following those
  // instructions would ACTIVATE the squatter's password on their own account.
  // The assertion below is the inverse, and the recovery path it replaces is
  // covered by the reset check further down.
  await new Promise((r) => setTimeout(r, 8000));
  const after = (await tagMail()).length;
  step(
    after === before,
    "a sign-up collision emails NOTHING",
    `${before} -> ${after}`,
  );

  // ── login must not distinguish unknown-address from wrong-password ────────
  //
  // Measured on production before the fix: retrieveAccount threw
  // "InvalidAccountId" vs "InvalidSecret", with a stack trace, straight to the
  // client. Only the browser collapsed them.
  const loginOutcome = async (addr, password) => {
    try {
      await c.action(anyApi.auth.signIn, {
        provider: "password",
        params: { email: addr, password, flow: "signIn" },
      });
      return "resolved";
    } catch (e) {
      return String(e.data ?? e.message ?? e);
    }
  };
  const unknownLogin = await loginOutcome(
    ollastack.taggedAddress(await ollastack.mailboxAddress(), ollastack.newTag()),
    "Wr0ngGuess#2026",
  );
  const wrongPwLogin = await loginOutcome(email, "Wr0ngGuess#2026");
  step(
    unknownLogin === wrongPwLogin,
    "login: unknown address and wrong password are indistinguishable",
    `${unknownLogin} vs ${wrongPwLogin}`,
  );
  step(
    !/InvalidAccountId|InvalidSecret|passwordProvider\.ts/.test(wrongPwLogin),
    "login errors leak neither the library error code nor a stack trace",
    wrongPwLogin,
  );

  // ── the reset flow must not be an oracle either ───────────────────────────
  //
  // This one was never rate-limited: the library's brute-force limiter only
  // engages when a secret is supplied, so it could be swept at full speed.
  const resetOutcome = async (addr) => {
    try {
      const r = await c.action(anyApi.auth.signIn, {
        provider: "password",
        params: { email: addr, flow: "reset" },
      });
      return `resolved:${JSON.stringify(r)}`;
    } catch (e) {
      return String(e.data ?? e.message ?? e);
    }
  };
  const unknownReset = await resetOutcome(
    ollastack.taggedAddress(await ollastack.mailboxAddress(), ollastack.newTag()),
  );
  const knownReset = await resetOutcome(email);
  step(
    unknownReset === knownReset,
    "reset: known and unknown addresses are indistinguishable",
    `${unknownReset} vs ${knownReset}`,
  );

  // ── recovery: reset is the route back into a colliding address ────────────
  const resetCode = await ollastack.codeForAddress(email, "reset", 120000);
  step(
    Boolean(resetCode && /^\d{8}$/.test(resetCode)),
    "the reset above emailed the real owner a usable code",
    resetCode || "none",
  );
  if (resetCode) {
    const NEW_PASSWORD = "Rec0veredPass#2026";
    const recovered = await c.action(anyApi.auth.signIn, {
      provider: "password",
      params: {
        email,
        code: resetCode,
        newPassword: NEW_PASSWORD,
        flow: "reset-verification",
      },
    });
    step(
      Boolean(recovered?.tokens),
      "the owner recovers the address with the reset code",
    );
    // And the password that was there before must be dead.
    const oldPw = await loginOutcome(email, PASSWORD);
    step(
      oldPw !== "resolved",
      "the previous password stops working after the reset",
      oldPw,
    );
  }

  const pass = results.filter((r) => r[0]).length;
  console.log(`\n===== AUTH ORACLE: ${pass}/${results.length} =====`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
