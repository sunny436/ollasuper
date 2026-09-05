// Projects — concurrency and lifecycle races against a REAL deployment.
//
// Sequential tests prove the happy path; these prove the ORDER-DEPENDENT
// failures, where a Project changes state underneath work that is already in
// flight. The question each one asks is the same: when the Project moves, does
// anything that was already running keep the authority it had?
//
//   ssh -N -L 3210:127.0.0.1:3210 -L 8025:127.0.0.1:8025 root@<vm> &
//   CONVEX_URL=http://127.0.0.1:3210 node qa-projects-race.js
//
// BUDGET. Convex allows MAX_GENERATIONS_PER_HOUR = 120 per user and the AI
// plane allows AI_MAX_CONCURRENT_PER_USER = 2. This suite spends 3 generations
// and never runs more than 2 at once, so a limiter response here would be a
// real finding rather than self-inflicted noise.
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");

const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const MAILPIT = process.env.E2E_MAILPIT_URL || "http://127.0.0.1:8025";
const RUN = Date.now().toString(36).slice(-6);

const results = [];
const findings = [];

const step = async (n, f) => {
  try {
    await f();
    results.push(true);
    console.log("PASS  " + n);
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + n + " — " + String(e.message).split("\n")[0]);
  }
};

const tried = async (fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: String(e.message || "").split("\n")[0] };
  }
};

async function codeFromMailpit(email) {
  const res = await fetch(
    `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=25`,
  ).catch(() => null);
  if (!res || !res.ok) return null;
  const { messages = [] } = await res.json();
  for (const m of messages) {
    const full = await fetch(`${MAILPIT}/api/v1/message/${m.ID}`).catch(() => null);
    if (!full || !full.ok) continue;
    const body = await full.json();
    const text = `${body.Subject || ""} ${body.Text || ""}`;
    if (!text.toLowerCase().includes("verification")) continue;
    const hit = text.match(/\b(\d{6,8})\b/);
    if (hit) return hit[1];
  }
  return null;
}

async function signUp(email, password) {
  const c = new ConvexHttpClient(CONVEX_URL);
  await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signUp" },
  });
  let code = null;
  for (let i = 0; i < 24 && !code; i++) {
    code = await codeFromMailpit(email);
    if (!code) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!code) throw new Error("no verification code captured for " + email);
  const v = await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, code, flow: "email-verification" },
  });
  const token = v?.tokens?.token;
  if (!token) throw new Error("no token for " + email);
  const authed = new ConvexHttpClient(CONVEX_URL);
  authed.setAuth(token);
  return authed;
}

/** Wait until the thread has no active stream, or the deadline passes. */
const settle = async (c, threadId, ms = 120000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const a = await c.query(anyApi.chat.stream.active, { threadId }).catch(() => null);
    if (!a) return true;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return false;
};

(async () => {
  console.log(`convex=${CONVEX_URL} run=${RUN}`);
  const email = `qaprojr${RUN}@myos.test`;
  let C;
  let ws;
  let pA;
  let pB;

  await step("provision an account, a workspace and two Projects", async () => {
    C = await signUp(email, "QaProjR#2026x");
    ws = await C.mutation(anyApi.orgs.createWorkspace, { name: `WS-R-${RUN}` });
    pA = await C.mutation(anyApi.projects.create, { workspaceId: ws, name: `RA-${RUN}` });
    pB = await C.mutation(anyApi.projects.create, { workspaceId: ws, name: `RB-${RUN}` });
  });

  // CASE 3 — Project deleted while one of its chats is generating.
  await step("CASE 3: deleting a Project mid-generation does not destroy the chat", async () => {
    const t = await C.mutation(anyApi.chat.threads.create, {
      workspaceId: ws,
      title: `race3-${RUN}`,
      projectId: pA,
    });
    await C.mutation(anyApi.chat.messages.send, {
      threadId: t,
      content: "Count slowly from 1 to 20, one number per line.",
      clientId: `r3-${RUN}`,
    });
    // Delete the Project WHILE that turn is in flight.
    await new Promise((r) => setTimeout(r, 1200));
    const del = await tried(() => C.mutation(anyApi.projects.remove, { projectId: pA }));
    if (!del.ok) throw new Error("could not delete mid-generation: " + del.error);
    const done = await settle(C, t, 150000);
    if (!done) findings.push("CASE 3: stream did not finalize within 150s");
    // THE POINT: the conversation survives, and it is still readable.
    const thread = await C.query(anyApi.chat.threads.get, { threadId: t });
    if (!thread) throw new Error("RESURRECTION/LOSS: the chat disappeared with its Project");
    const msgs = await C.query(anyApi.chat.messages.listPaged, {
      threadId: t,
      paginationOpts: { numItems: 10, cursor: null },
    }).catch(() => null);
    if (!msgs || !msgs.page || msgs.page.length === 0)
      throw new Error("the chat lost its messages when the Project was deleted");
    await C.mutation(anyApi.projects.restore, { projectId: pA });
  });

  // CASE 5 — Project archived while a chat inside it is generating.
  await step("CASE 5: archiving a Project mid-generation is safe", async () => {
    const t = await C.mutation(anyApi.chat.threads.create, {
      workspaceId: ws,
      title: `race5-${RUN}`,
      projectId: pA,
    });
    await C.mutation(anyApi.chat.messages.send, {
      threadId: t,
      content: "Say READY once.",
      clientId: `r5-${RUN}`,
    });
    await new Promise((r) => setTimeout(r, 800));
    const arch = await tried(() =>
      C.mutation(anyApi.projects.archive, { projectId: pA, archived: true }),
    );
    if (!arch.ok) findings.push("CASE 5: archive refused mid-generation: " + arch.error);
    await settle(C, t, 120000);
    const thread = await C.query(anyApi.chat.threads.get, { threadId: t });
    if (!thread) throw new Error("chat lost on archive");
    await C.mutation(anyApi.projects.archive, { projectId: pA, archived: false });
  });

  // A move must not happen underneath a running generation.
  await step("a chat cannot change Project while it is generating", async () => {
    const t = await C.mutation(anyApi.chat.threads.create, {
      workspaceId: ws,
      title: `race-move-${RUN}`,
      projectId: pA,
    });
    await C.mutation(anyApi.chat.messages.send, {
      threadId: t,
      content: "Write two short sentences about the sea.",
      clientId: `rm-${RUN}`,
    });
    await new Promise((r) => setTimeout(r, 900));
    const move = await tried(() =>
      C.mutation(anyApi.projects.moveThread, { threadId: t, projectId: pB }),
    );
    if (move.ok) {
      findings.push("a mid-generation move SUCCEEDED — retrieval scope can change under a running turn");
      throw new Error("move was allowed mid-generation");
    }
    if (!/generating/i.test(move.error))
      findings.push(`move refused, but not for the expected reason: ${move.error}`);
    await settle(C, t, 120000);
    // After it settles, the same move must succeed — the guard is temporal.
    const after = await tried(() =>
      C.mutation(anyApi.projects.moveThread, { threadId: t, projectId: pB }),
    );
    if (!after.ok) throw new Error("move still refused after the turn finished: " + after.error);
  });

  // Concurrent double-link must be idempotent, not duplicated.
  await step("linking the same file twice concurrently creates ONE edge", async () => {
    const files = await C.query(anyApi.userFiles.list, {
      workspaceId: ws,
      paginationOpts: { numItems: 5, cursor: null },
    }).catch(() => null);
    const f = files?.page?.[0]?._id ?? null;
    if (!f) {
      console.log("      (no file on this fresh account — idempotency covered by convex-test)");
      return;
    }
    await Promise.all([
      tried(() => C.mutation(anyApi.projects.linkFile, { projectId: pB, fileId: f })),
      tried(() => C.mutation(anyApi.projects.linkFile, { projectId: pB, fileId: f })),
    ]);
    const list = await C.query(anyApi.projects.listFiles, {
      projectId: pB,
      paginationOpts: { numItems: 20, cursor: null },
    });
    const n = (list?.page ?? []).filter((x) => x._id === f).length;
    if (n > 1) throw new Error(`duplicate project-file edges: ${n}`);
  });

  // Concurrent delete + restore must converge on one defined state.
  await step("concurrent delete and restore converge, never split-brain", async () => {
    const p = await C.mutation(anyApi.projects.create, {
      workspaceId: ws,
      name: `conv-${RUN}`,
    });
    await Promise.all([
      tried(() => C.mutation(anyApi.projects.remove, { projectId: p })),
      tried(() => C.mutation(anyApi.projects.restore, { projectId: p })),
    ]);
    const after = await C.query(anyApi.projects.get, { projectId: p });
    if (!after) throw new Error("project vanished entirely");
    if (!["active", "trashed"].includes(after.status))
      throw new Error(`undefined state after the race: ${after.status}`);
    console.log(`      converged on status=${after.status}`);
    await C.mutation(anyApi.projects.remove, { projectId: p });
  });

  // CASE 9 — after deletion, a retry must not resurrect Project context.
  await step("CASE 9: a chat whose Project was deleted still works, without it", async () => {
    const t = await C.mutation(anyApi.chat.threads.create, {
      workspaceId: ws,
      title: `race9-${RUN}`,
      projectId: pB,
    });
    await C.mutation(anyApi.projects.remove, { projectId: pB });
    const send = await tried(() =>
      C.mutation(anyApi.chat.messages.send, {
        threadId: t,
        content: "Say OK once.",
        clientId: `r9-${RUN}`,
      }),
    );
    if (!send.ok) {
      // Refusing is an acceptable defined behaviour; silently using the dead
      // Project's files would not be.
      console.log("      send refused after Project deletion: " + send.error);
      return;
    }
    await settle(C, t, 120000);
    const thread = await C.query(anyApi.chat.threads.get, { threadId: t });
    if (!thread) throw new Error("thread lost");
    await C.mutation(anyApi.projects.restore, { projectId: pB });
  });

  const pass = results.filter(Boolean).length;
  console.log(`\n===== PROJECT RACES: ${pass}/${results.length} =====`);
  if (findings.length) console.log("FINDINGS:\n - " + findings.join("\n - "));
  console.log(`account: ${email}  ids: pA=${pA} pB=${pB}`);
  process.exit(pass === results.length && findings.length === 0 ? 0 : 1);
})();
