// Account deletion, asked of the REAL deployment.
//
// Two defects, both fixed and both checked here:
//
//  - DELETION HAD NO RE-AUTHENTICATION. The only guard was useDoubleCheck in the
//    settings page — clicking the button twice — so a borrowed or stolen session
//    destroyed the account, and its memories, SEO ledger and research runs, in
//    one call. Better Auth requires a password, an emailed token, or a session
//    younger than freshAge.
//  - DELETION LEFT THE AUTH STATE BEHIND. users.deleteUserAccount removed only
//    the "google" authAccount, so the password credential, every session and
//    every refresh token survived. The deleted user kept minting access tokens
//    (refreshTokenIfValid never looks at the user), and the orphaned credential
//    made the address permanently unregisterable — the next sign-up patched a
//    deleted user id and hit the library's own "the user has been deleted but
//    their account has not".
//
//   OLLASTACK_MAIL_TOKEN=... OLLASTACK_E2E_MAILBOX_ID=... \
//   CONVEX_URL=https://app.ollasuper.com/__cvx node p-auth-deletion.js

const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");
const ollastack = require("./_lib/ollastack");

const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const PASSWORD = "Del3teMe#2026";
const SECOND_PASSWORD = "Reb0rnAgain#2026";

const results = [];
const step = (ok, name, detail) => {
  results.push([ok, name, detail || ""]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Reduce a call to what the caller can observe. */
async function outcome(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: String(e.data ?? e.message ?? e) };
  }
}

/** Register a real address and verify it, returning the issued tokens. */
async function register(c, email, password) {
  await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signUp" },
  });
  const code = await ollastack.codeForAddress(email, "verification", 120000);
  if (!code) throw new Error(`no verification code arrived for ${email}`);
  const r = await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, code, flow: "email-verification" },
  });
  return r?.tokens ?? null;
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

  const c = new ConvexHttpClient(CONVEX_URL);
  const tokens = await register(c, email, PASSWORD);
  step(Boolean(tokens?.token), "account registered and verified");
  c.setAuth(tokens.token);

  const del = (args) => c.action(anyApi.users.deleteCurrentUserAccount, args);

  // ── re-authentication is required ─────────────────────────────────────────
  const bare = await outcome(() => del({}));
  step(
    !bare.ok && /password/i.test(bare.error),
    "deletion with NO password is refused",
    bare.ok ? "DELETED — the guard is missing" : bare.error,
  );

  const wrong = await outcome(() => del({ password: "N0tMyPassw0rd!" }));
  step(
    !wrong.ok && /Incorrect password/i.test(wrong.error),
    "deletion with the WRONG password is refused",
    wrong.ok ? "DELETED — the guard is missing" : wrong.error,
  );

  // The account must still be there after two refused attempts.
  const stillThere = await outcome(() =>
    c.action(anyApi.auth.signIn, {
      provider: "password",
      params: { email, password: PASSWORD, flow: "signIn" },
    }),
  );
  step(
    stillThere.ok && Boolean(stillThere.value?.tokens),
    "a refused deletion leaves the account intact",
  );
  // That sign-in replaced the session, so re-authorise with the newest token.
  c.setAuth(stillThere.value.tokens.token);
  const liveRefresh = stillThere.value.tokens.refreshToken;

  // ── the real thing ────────────────────────────────────────────────────────
  const done = await outcome(() => del({ password: PASSWORD }));
  step(done.ok, "deletion with the CORRECT password succeeds", done.error ?? "");

  // ── the credential and the session must be gone ───────────────────────────
  const ghostLogin = await outcome(() =>
    c.action(anyApi.auth.signIn, {
      provider: "password",
      params: { email, password: PASSWORD, flow: "signIn" },
    }),
  );
  step(
    !ghostLogin.ok || !ghostLogin.value?.tokens,
    "the deleted account can no longer sign in",
    ghostLogin.ok ? JSON.stringify(ghostLogin.value) : ghostLogin.error,
  );

  // An orphaned refresh token still mints access tokens, so it must not survive.
  const anon = new ConvexHttpClient(CONVEX_URL);
  const refreshed = await outcome(() =>
    anon.action(anyApi.auth.signIn, { refreshToken: liveRefresh }),
  );
  step(
    !refreshed.ok || !refreshed.value?.tokens,
    "the deleted account's refresh token no longer mints tokens",
    refreshed.ok ? JSON.stringify(refreshed.value).slice(0, 80) : refreshed.error,
  );

  // ── and the address must be reusable ──────────────────────────────────────
  // This is the one that failed before: the orphaned password account made the
  // address permanently unregisterable.
  const reborn = await outcome(() => register(anon, email, SECOND_PASSWORD));
  step(
    reborn.ok && Boolean(reborn.value?.token),
    "the same address can be registered again after deletion",
    reborn.ok ? "re-registered" : reborn.error,
  );

  const pass = results.filter((r) => r[0]).length;
  console.log(`\n===== AUTH DELETION: ${pass}/${results.length} =====`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
