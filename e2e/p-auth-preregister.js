// PRODUCTION reproduction of the pre-registration / signup-hijack surface.
//
// The invariant under test (passwordProvider.ts): A CREDENTIAL MAY BECOME LIVE
// ON AN ACCOUNT ONLY WHEN THE ACTOR WHO SUPPLIED IT ALSO PROVED INBOX OWNERSHIP
// IN THE SAME FLOW.
//
// So: squat an address, then try every way to make that squatted credential
// authenticate. Every one must fail, and a colliding sign-up must be
// indistinguishable from a fresh one (no account-existence oracle).
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");
const CONVEX = "https://app.ollasuper.com/__cvx";

const RUN = Date.now().toString(36).slice(-7);
const VICTIM = `ollasuper.sec.${RUN}@gmail.com`;
const PW_ATTACKER = `Atk${RUN}#Zx9q`;
const PW_SECOND = `Snd${RUN}#Qw7p`;

const results = [];
const step = (ok, name, detail = "") => {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function signUp(email, password) {
  const c = new ConvexHttpClient(CONVEX);
  return await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signUp" },
  });
}
async function signIn(email, password) {
  const c = new ConvexHttpClient(CONVEX);
  return await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signIn" },
  });
}
const outcome = async (fn) => {
  try { const r = await fn(); return r?.tokens ? "session" : "no-session"; }
  catch (e) { return "error:" + String(e.message).replace(/[\s\S]*ConvexError:\s*/, "").split("\n")[0].slice(0, 45); }
};

(async () => {
  console.log(`squatting ${VICTIM}\n`);

  // 1. The squat itself must NOT hand out a session.
  const a = await outcome(() => signUp(VICTIM, PW_ATTACKER));
  step(a === "no-session", "squat sign-up issues NO session", a);

  // 2. The squatted credential must not authenticate — nobody proved inbox.
  const b = await outcome(() => signIn(VICTIM, PW_ATTACKER));
  step(b !== "session", "squatted password cannot sign in", b);

  // 3. A colliding sign-up (the victim, or a second attacker) must be
  //    indistinguishable from a fresh sign-up, and must not sign anyone in.
  const c = await outcome(() => signUp(VICTIM, PW_SECOND));
  const fresh = await outcome(() => signUp(`ollasuper.fresh.${RUN}@gmail.com`, PW_SECOND));
  step(c === fresh, "colliding sign-up is indistinguishable from a fresh one", `${c} vs ${fresh}`);
  step(c !== "session", "colliding sign-up issues no session", c);

  // 4. Neither credential is live afterwards. In particular the SECOND
  //    sign-up must not have overwritten the first (that is the mirrored bug).
  const d = await outcome(() => signIn(VICTIM, PW_SECOND));
  step(d !== "session", "second sign-up's password cannot sign in either", d);
  const e = await outcome(() => signIn(VICTIM, PW_ATTACKER));
  step(e !== "session", "original squatted password still cannot sign in", e);

  // 5. Wrong-password and unknown-address must be indistinguishable (no oracle).
  const wrong = await outcome(() => signIn(VICTIM, "TotallyWrong#2026x"));
  const unknown = await outcome(() => signIn(`ollasuper.none.${RUN}@gmail.com`, "TotallyWrong#2026x"));
  step(wrong === unknown, "wrong password vs unknown address are indistinguishable", `${wrong} vs ${unknown}`);

  const pass = results.filter(Boolean).length;
  console.log(`\n===== PRE-REGISTRATION HIJACK: ${pass}/${results.length} =====`);
  process.exit(pass === results.length ? 0 : 1);
})();
