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

  // ── the legitimate path still works ───────────────────────────────────────
  const owner = await ollastack.codeForAddress(email, "verification", 120000);
  step(
    Boolean(owner && /^\d{8}$/.test(owner)),
    "the collision still emails the real owner a usable code",
    owner || "none",
  );

  const pass = results.filter((r) => r[0]).length;
  console.log(`\n===== AUTH ORACLE: ${pass}/${results.length} =====`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
