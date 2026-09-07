// Projects — SECOND red-team pass, deliberately NOT a re-run of pass one.
//
// A fix that only closes the exact hole you probed is worse than no fix, because
// it comes with the confidence of a green suite. So every probe here is a shape
// the first pass did not use: an id from the WRONG TABLE, a well-formed id that
// never existed, a STALE id whose Project has since been trashed, a
// CROSS-WORKSPACE pairing, and a REPLAYED mutation.
//
//   ssh -N -L 3210:127.0.0.1:3210 root@<vm> &
//   CONVEX_URL=http://127.0.0.1:3210 node qa-projects-redteam2.js
//
// As in pass one, a probe that never reached the handler is not a denial: an
// argument-validation error or a client-side TypeError fails the test rather
// than scoring as proof.
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");

const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const PEER_EMAIL = process.env.PEER_EMAIL || "";
const PEER_PASSWORD = process.env.PEER_PASSWORD || "";

const RUN = Date.now().toString(36).slice(-6);
const PAGE = { numItems: 10, cursor: null };

const results = [];
const leaks = [];
const notRun = [];

const INVALID_PROBE =
  /ArgumentValidationError|Object is missing the required field|Validator error|Unexpected field|Expected ID for table|Cannot read propert|is not a function|fetch failed|ECONNREFUSED/i;

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

const denied = async (label, fn) => {
  let threw = false;
  let value;
  let message = "";
  try {
    value = await fn();
  } catch (e) {
    threw = true;
    message = typeof e?.data === "string" ? e.data : String(e.message || e);
  }
  if (threw && INVALID_PROBE.test(message)) {
    throw new Error(
      `${label} INVALID PROBE — never reached the handler: ${message.slice(0, 140)}`,
    );
  }
  const empty =
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (value && Array.isArray(value.page) && value.page.length === 0);
  if (!threw && !empty) {
    leaks.push(label);
    throw new Error(`${label} LEAKED: ${JSON.stringify(value).slice(0, 200)}`);
  }
  return threw ? "THREW:" + message.slice(0, 80) : "EMPTY";
};

async function signIn(email, password) {
  const c = new ConvexHttpClient(CONVEX_URL);
  const r = await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signIn" },
  });
  if (!r?.tokens?.token) throw new Error("no token for " + email);
  const authed = new ConvexHttpClient(CONVEX_URL);
  authed.setAuth(r.tokens.token);
  return authed;
}

(async () => {
  console.log(`convex=${CONVEX_URL} run=${RUN}`);
  let A;
  let peer = null;
  let ws;
  let ws2 = null;
  let proj;
  let projWs2 = null;
  let thread;
  let staleProj;

  try {
    A = await signIn(EMAIL, PASSWORD);
    const wss = await A.query(anyApi.orgs.myWorkspaces, {});
    ws = wss[0]?._id;
    if (!ws) throw new Error("no workspace");
    proj = await A.mutation(anyApi.projects.create, {
      workspaceId: ws,
      name: `RT2-${RUN}`,
    });
    thread = await A.mutation(anyApi.chat.threads.create, {
      workspaceId: ws,
      title: `rt2-${RUN}`,
      projectId: proj,
    });
    // A Project that WILL be trashed, to give later probes a stale id.
    staleProj = await A.mutation(anyApi.projects.create, {
      workspaceId: ws,
      name: `RT2-stale-${RUN}`,
    });
    await A.mutation(anyApi.projects.remove, { projectId: staleProj });
    console.log(`PASS  provisioning: proj=${proj} stale=${staleProj}`);
    results.push(true);
  } catch (e) {
    console.log("ABORT — provisioning failed: " + String(e.message).split("\n")[0]);
    process.exit(2);
  }

  if (PEER_EMAIL && PEER_PASSWORD) {
    peer = await signIn(PEER_EMAIL, PEER_PASSWORD).catch(() => null);
  }

  // ---------------------------------------------- variant 1: wrong-table id
  await step("VARIANT 1: a THREAD id used as a Project id fails closed", async () => {
    // Well-formed Convex id, wrong table. normalizeId must reject it rather
    // than the handler treating it as a Project that happens not to exist.
    await denied("thread id as projectId (get)", () =>
      A.query(anyApi.projects.get, { projectId: thread }),
    );
    await denied("thread id as projectId (listThreads)", () =>
      A.query(anyApi.projects.listThreads, { projectId: thread, paginationOpts: PAGE }),
    );
    await denied("thread id as projectId (listFiles)", () =>
      A.query(anyApi.projects.listFiles, { projectId: thread, paginationOpts: PAGE }),
    );
    await denied("thread id as projectId (threads.create)", () =>
      A.mutation(anyApi.chat.threads.create, {
        workspaceId: ws,
        title: `v1-${RUN}`,
        projectId: thread,
      }),
    );
  });

  // ---------------------------------------------- variant 2: never-existed id
  await step("VARIANT 2: a well-formed id that never existed is indistinguishable", async () => {
    // Same shape as a real project id, but nothing was ever stored under it.
    const fabricated = String(proj).slice(0, -3) + "zzz";
    await denied("fabricated id", () =>
      A.query(anyApi.projects.get, { projectId: fabricated }),
    );
    // The OWNER must still be able to read their own trashed Project — that is
    // exactly what makes Restore possible, and the UI renders the "deleted,
    // restore within 30 days" banner from it. Asserting a denial here would be
    // asserting a bug.
    const own = await A.query(anyApi.projects.get, { projectId: staleProj });
    if (!own || own.status !== "trashed")
      throw new Error(`owner cannot read their own trashed Project (status=${own?.status})`);
  });

  // ---------------------------------------------- variant 3: stale id
  await step("VARIANT 3: a STALE (trashed) Project accepts no new work", async () => {
    await denied("new chat into a trashed project", () =>
      A.mutation(anyApi.chat.threads.create, {
        workspaceId: ws,
        title: `v3-${RUN}`,
        projectId: staleProj,
      }),
    );
    await denied("move a chat into a trashed project", () =>
      A.mutation(anyApi.projects.moveThread, { threadId: thread, projectId: staleProj }),
    );
    const files = await A.query(anyApi.userFiles.list, {
      workspaceId: ws,
      paginationOpts: { numItems: 3, cursor: null },
    }).catch(() => null);
    const f = files?.page?.[0]?._id;
    if (f) {
      await denied("link a file into a trashed project", () =>
        A.mutation(anyApi.projects.linkFile, { projectId: staleProj, fileId: f }),
      );
    }
  });

  // ---------------------------------------------- variant 4: cross-workspace
  await step("VARIANT 4: a Project cannot adopt a chat from another workspace", async () => {
    ws2 = await A.mutation(anyApi.orgs.createWorkspace, { name: `RT2-WS2-${RUN}` });
    projWs2 = await A.mutation(anyApi.projects.create, {
      workspaceId: ws2,
      name: `RT2-ws2-${RUN}`,
    });
    // Same USER, different WORKSPACE: ownership passes, tenancy must not.
    await denied("cross-workspace moveThread", () =>
      A.mutation(anyApi.projects.moveThread, { threadId: thread, projectId: projWs2 }),
    );
    await denied("cross-workspace threads.create", () =>
      A.mutation(anyApi.chat.threads.create, {
        workspaceId: ws,
        title: `v4-${RUN}`,
        projectId: projWs2,
      }),
    );
    const t = await A.query(anyApi.chat.threads.get, { threadId: thread });
    if (t?.projectId && String(t.projectId) === String(projWs2))
      throw new Error("thread crossed a workspace boundary");
  });

  await step("VARIANT 4b: a file cannot cross a workspace into a Project", async () => {
    const files = await A.query(anyApi.userFiles.list, {
      workspaceId: ws,
      paginationOpts: { numItems: 3, cursor: null },
    }).catch(() => null);
    const f = files?.page?.[0]?._id;
    if (!f) {
      notRun.push("VARIANT 4b (no files on this account)");
      console.log("NOT RUN  VARIANT 4b — no files on this account");
      return;
    }
    await denied("cross-workspace linkFile", () =>
      A.mutation(anyApi.projects.linkFile, { projectId: projWs2, fileId: f }),
    );
  });

  // ---------------------------------------------- variant 5: replay
  await step("VARIANT 5: a REPLAYED send is idempotent, not a second generation", async () => {
    const t = await A.mutation(anyApi.chat.threads.create, {
      workspaceId: ws,
      title: `v5-${RUN}`,
      projectId: proj,
    });
    const clientId = `replay-${RUN}`;
    const first = await A.mutation(anyApi.chat.messages.send, {
      threadId: t,
      content: "Say REPLAYOK once.",
      clientId,
    });
    const second = await A.mutation(anyApi.chat.messages.send, {
      threadId: t,
      content: "Say REPLAYOK once.",
      clientId,
    }).catch((e) => ({ refused: typeof e?.data === "string" ? e.data : String(e.message) }));
    // Either the same result comes back, or the replay is refused. What must
    // NOT happen is two user messages queued from one clientId.
    for (let i = 0; i < 80; i++) {
      const a = await A.query(anyApi.chat.stream.active, { threadId: t }).catch(() => null);
      if (!a) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    const msgs = await A.query(anyApi.chat.messages.listPaged, {
      threadId: t,
      paginationOpts: { numItems: 20, cursor: null },
    });
    const users = (msgs?.page ?? []).filter((m) => m.role === "user");
    if (users.length > 1)
      throw new Error(`replay created ${users.length} user messages from one clientId`);
    console.log(
      `      first=${String(first).slice(0, 12)} replay=${JSON.stringify(second).slice(0, 60)} userMsgs=${users.length}`,
    );
  });

  // ---------------------------------------------- variant 6: peer + new shapes
  if (!peer) {
    notRun.push("VARIANT 6 cross-user new shapes (no peer credentials)");
    console.log("NOT RUN  VARIANT 6 — no peer credentials");
  } else {
    await step("VARIANT 6: a peer cannot use the new id shapes either", async () => {
      await denied("peer + thread-id-as-project", () =>
        peer.query(anyApi.projects.get, { projectId: thread }),
      );
      await denied("peer + stale project", () =>
        peer.query(anyApi.projects.get, { projectId: staleProj }),
      );
      await denied("peer + cross-workspace project", () =>
        peer.query(anyApi.projects.get, { projectId: projWs2 }),
      );
      await denied("peer listThreads on ws2 project", () =>
        peer.query(anyApi.projects.listThreads, {
          projectId: projWs2,
          paginationOpts: PAGE,
        }),
      );
    });
  }

  // ---------------------------------------------- cleanup
  await step("cleanup", async () => {
    for (const p of [proj, projWs2].filter(Boolean)) {
      await A.mutation(anyApi.projects.remove, { projectId: p }).catch(() => {});
    }
  });

  const pass = results.filter(Boolean).length;
  console.log(
    `\n===== SECOND RED-TEAM: ${pass}/${results.length} | leaks: ${leaks.length} | NOT RUN: ${notRun.length} =====`,
  );
  if (leaks.length) console.log("LEAKED: " + leaks.join(", "));
  if (notRun.length) console.log("NOT RUN: " + notRun.join(" | "));
  process.exit(pass === results.length && leaks.length === 0 ? 0 : 1);
})();
