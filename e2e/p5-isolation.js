// Cross-user isolation for the SCHEDULED TASKS surface, against a live
// deployment. Sibling of p-chat-isolation.js, and deliberately the same shape:
// the peer is a REAL member of the owner's workspace, because "an outsider
// cannot read it" is a much weaker claim than "a colleague cannot".
//
// Phase 4 changed the read paths from throwing to returning nothing, so this
// also pins the property that mattered in that change: a peer, an outsider and
// a nonexistent id must be INDISTINGUISHABLE, or the response becomes an
// existence oracle for someone else's taskId.
//
// Runs on the VM (it talks to Convex directly):
//   cd /opt/myos/e2e && node p5-isolation.js
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");

const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const MAILPIT = process.env.MAILPIT_URL || "http://127.0.0.1:8025";
// Production restricts signup domains; @myos.test is refused.
const DOMAIN = process.env.E2E_EMAIL_DOMAIN || "gmail.com";

const results = [];
const ok = (n) => {
  results.push(true);
  console.log("PASS  " + n);
};
const no = (n, d) => {
  results.push(false);
  console.log("FAIL  " + n + (d ? " — " + d : ""));
};
const must = (c, n, d) => (c ? ok(n) : no(n, d));

async function codeFromMailpit(email) {
  try {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(email)}`);
    const j = await r.json();
    for (const m of j.messages || []) {
      const d = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
      const hit = `${d.Text || ""}${d.Subject || ""}`.match(/\b(\d{8})\b/);
      if (hit) return hit[1];
    }
  } catch {}
  return null;
}

async function signUp(email, password) {
  const c = new ConvexHttpClient(CONVEX_URL);
  await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signUp" },
  });
  let code = null;
  for (let i = 0; i < 14 && !code; i++) {
    code = await codeFromMailpit(email);
    if (!code) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!code) throw new Error("no verification code for " + email);
  const verified = await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, code, flow: "email-verification" },
  });
  const token = verified?.tokens?.token;
  if (!token) throw new Error("no token for " + email);
  const authed = new ConvexHttpClient(CONVEX_URL);
  authed.setAuth(token);
  return authed;
}

/** A read that must come back empty, whatever the reason. */
const isEmpty = (v) =>
  v === null ||
  v === undefined ||
  (Array.isArray(v) && v.length === 0) ||
  (v && typeof v === "object" && Array.isArray(v.page) && v.page.length === 0);

(async () => {
  const ts = Date.now();
  const owner = await signUp(`schedowner${ts}@${DOMAIN}`, "SchedOwner#2026x");
  const peer = await signUp(`schedpeer${ts}@${DOMAIN}`, "SchedPeer#2026x");
  ok("two accounts created and verified");

  const ws = await owner.mutation(anyApi.orgs.createWorkspace, {
    name: `SchedIso${ts}`,
  });
  await owner.mutation(anyApi.orgs.invite, {
    workspaceId: ws,
    email: `schedpeer${ts}@${DOMAIN}`,
    role: "member",
  });
  const invites = await peer.query(anyApi.orgs.myInvites, {});
  await peer.mutation(anyApi.orgs.acceptInvite, { inviteId: invites[0]._id });
  const members = await peer.query(anyApi.orgs.listWorkspaces, {});
  must(
    members.some((w) => String(w._id) === String(ws)),
    "the peer is a real member of the owner's workspace",
  );

  const SECRET = `ownersecret${ts}`;
  const taskId = await owner.mutation(anyApi.scheduled.tasks.create, {
    workspaceId: ws,
    title: SECRET,
    prompt: `passphrase-${ts}-do-not-share`,
    spec: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
  });
  const mine = await owner.query(anyApi.scheduled.tasks.get, { taskId });
  must(mine?.title === SECRET, "the owner can read their own task");

  // ── the peer sees nothing ────────────────────────────────────────────────
  for (const [name, call] of [
    ["get", peer.query(anyApi.scheduled.tasks.get, { taskId })],
    ["history", peer.query(anyApi.scheduled.tasks.history, { taskId })],
    ["activeRun", peer.query(anyApi.scheduled.tasks.activeRun, { taskId })],
    ["deliveries", peer.query(anyApi.scheduled.tasks.deliveries, { taskId })],
  ]) {
    const v = await call.catch((e) => `THREW ${e.message}`);
    must(isEmpty(v), `a workspace peer reads nothing from ${name}`, JSON.stringify(v)?.slice(0, 80));
  }

  const peerList = await peer.query(anyApi.scheduled.tasks.list, {});
  must(
    !peerList.some((t) => t.title === SECRET),
    "the owner's task is absent from the peer's own list",
  );

  // ── no existence oracle ──────────────────────────────────────────────────
  const forPeer = await peer.query(anyApi.scheduled.tasks.get, { taskId });
  const forNonexistent = await peer.query(anyApi.scheduled.tasks.get, {
    taskId: "not-a-real-id",
  });
  must(
    JSON.stringify(forPeer) === JSON.stringify(forNonexistent),
    "someone else's task is indistinguishable from one that never existed",
    `${JSON.stringify(forPeer)} vs ${JSON.stringify(forNonexistent)}`,
  );

  // ── every write refuses, loudly ──────────────────────────────────────────
  for (const [name, call] of [
    ["update", peer.mutation(anyApi.scheduled.tasks.update, { taskId, title: "pwned" })],
    ["pause", peer.mutation(anyApi.scheduled.tasks.pause, { taskId })],
    ["resume", peer.mutation(anyApi.scheduled.tasks.resume, { taskId })],
    ["runNow", peer.mutation(anyApi.scheduled.tasks.runNow, { taskId })],
    ["remove", peer.mutation(anyApi.scheduled.tasks.remove, { taskId })],
    [
      "setNotifyPrefs",
      peer.mutation(anyApi.scheduled.tasks.setNotifyPrefs, {
        taskId,
        emailOnSuccess: true,
      }),
    ],
  ]) {
    const r = await call.then(() => "RESOLVED").catch((e) => String(e.message || e));
    must(/Not found/.test(r), `a peer cannot ${name} someone else's task`, r.slice(0, 90));
  }

  // …and the task really is untouched.
  const after = await owner.query(anyApi.scheduled.tasks.get, { taskId });
  must(after?.title === SECRET, "the task is unchanged after every attempt");
  must(after?.status === "active", "the task is still active after every attempt");
  // A peer must not be able to turn ON email for someone else's task — that
  // would send another person's report to the owner's inbox on the peer's say-so.
  must(after?.emailOnSuccess === false, "the peer could not enable email on it");

  await owner.mutation(anyApi.scheduled.tasks.remove, { taskId });

  const passed = results.filter(Boolean).length;
  console.log(`\n===== SCHEDULED ISOLATION: ${passed}/${results.length} =====`);
  if (passed !== results.length) process.exit(1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
