// Projects — adversarial isolation against a REAL deployment, at the Convex
// layer, with no browser involved.
//
// The frontend is deliberately absent: hiding a button is not access control,
// so a suite that drives the UI can only ever prove the UI. What this asserts
// is that the SERVER refuses, and that it refuses the same way for "not yours"
// and "does not exist" — an error that distinguishes them is an existence
// oracle for someone else's project id.
//
//   ssh -N -L 3210:127.0.0.1:3210 root@<vm> &
//   CONVEX_URL=http://127.0.0.1:3210 node qa-projects-isolation.js
//
// AUTHENTICATION IS BY PASSWORD SIGN-IN, NOT SIGN-UP. This deployment sets
// AUTH_EMAIL_TRANSPORT=ollastack, because SMTP_HOST points at a local Mailpit
// catcher and email.ts refuses to send auth mail through a catcher. So a
// sign-up flow here cannot read its own verification code, and a suite that
// tried would fail for a mail reason while looking like a security result.
// Existing accounts sign in directly and need no mailbox.
//
// TWO TRAPS THIS SUITE REFUSES TO FALL INTO
//
//  1. A probe that never reached the server is NOT a denial. An
//     ArgumentValidationError, or a client-side TypeError from an undefined
//     client, throws exactly like an authorization failure does. `denied()`
//     treats both as an INVALID PROBE and fails the test, so a typo in this
//     file can never masquerade as proof of isolation.
//  2. If the primary client cannot authenticate, the suite ABORTS instead of
//     running probes against undefined and reporting a wall of green.
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");

const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
// Optional second identity. Without it the cross-USER probes are NOT RUN and
// say so; the cross-PROJECT probes below do not need it.
const PEER_EMAIL = process.env.PEER_EMAIL || "";
const PEER_PASSWORD = process.env.PEER_PASSWORD || "";

const RUN = Date.now().toString(36).slice(-6);
const PAGE = { numItems: 10, cursor: null };

const results = [];
const leaks = [];
const notRun = [];

/** A probe that never reached the handler proves nothing. */
const INVALID_PROBE =
  /ArgumentValidationError|Object is missing the required field|Validator error|Unexpected field|Expected ID for table|Cannot read propert|is not a function|fetch failed|ECONNREFUSED|undefined is not an object/i;

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

const skip = async (n, why) => {
  notRun.push(`${n} (${why})`);
  console.log("NOT RUN  " + n + " — " + why);
};

const denied = async (label, fn) => {
  let threw = false;
  let value;
  let message = "";
  try {
    value = await fn();
  } catch (e) {
    threw = true;
    message = String(e.message || e);
  }
  if (threw && INVALID_PROBE.test(message)) {
    throw new Error(
      `${label} INVALID PROBE — never reached the handler: ${message
        .split("\n")[0]
        .slice(0, 150)}`,
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
  if (!threw) return "EMPTY";
  const m = /Uncaught ConvexError:\s*(.+?)(\n|$)/.exec(message);
  return "THREW:" + (m?.[1] ?? message.split("\n")[0]).trim().slice(0, 80);
};

async function signIn(email, password) {
  const c = new ConvexHttpClient(CONVEX_URL);
  const r = await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signIn" },
  });
  const token = r?.tokens?.token;
  if (!token) throw new Error(`no token for ${email}`);
  const authed = new ConvexHttpClient(CONVEX_URL);
  authed.setAuth(token);
  return authed;
}

(async () => {
  console.log(`convex=${CONVEX_URL} run=${RUN}`);

  let A;
  let peer = null;
  let ws;
  let projA;
  let projB;
  let threadA;

  // ---- provisioning is a HARD GATE -----------------------------------------
  try {
    A = await signIn(EMAIL, PASSWORD);
    const wss = await A.query(anyApi.orgs.myWorkspaces, {}).catch(() => null);
    ws = Array.isArray(wss) ? wss[0]?._id ?? wss[0]?.workspaceId : null;
    if (!ws) throw new Error("no workspace for the primary account");
    projA = await A.mutation(anyApi.projects.create, {
      workspaceId: ws,
      name: `ISO-A-${RUN}`,
    });
    projB = await A.mutation(anyApi.projects.create, {
      workspaceId: ws,
      name: `ISO-B-${RUN}`,
    });
    console.log(`PASS  provisioning: ws=${ws} projA=${projA} projB=${projB}`);
    results.push(true);
  } catch (e) {
    console.log("ABORT — provisioning failed: " + String(e.message).split("\n")[0]);
    console.log("Refusing to run probes against an unauthenticated client: every");
    console.log("one of them would 'pass' for the wrong reason.");
    process.exit(2);
  }

  if (PEER_EMAIL && PEER_PASSWORD) {
    try {
      peer = await signIn(PEER_EMAIL, PEER_PASSWORD);
    } catch (e) {
      console.log("      peer sign-in failed: " + String(e.message).split("\n")[0]);
      peer = null;
    }
  }

  await step("CONTROL: the owner CAN read their own Project", async () => {
    const p = await A.query(anyApi.projects.get, { projectId: projA });
    if (!p || p.name !== `ISO-A-${RUN}`) throw new Error("owner cannot read own project");
  });

  // ------------------------------------------------- unauthenticated caller
  await step("an UNAUTHENTICATED client cannot read a real Project", async () => {
    const anon = new ConvexHttpClient(CONVEX_URL);
    await denied("anon projects.get", () =>
      anon.query(anyApi.projects.get, { projectId: projA }),
    );
    await denied("anon projects.list", () =>
      anon.query(anyApi.projects.list, {
        workspaceId: ws,
        status: "active",
        paginationOpts: PAGE,
      }),
    );
    await denied("anon listThreads", () =>
      anon.query(anyApi.projects.listThreads, { projectId: projA, paginationOpts: PAGE }),
    );
    await denied("anon listFiles", () =>
      anon.query(anyApi.projects.listFiles, { projectId: projA, paginationOpts: PAGE }),
    );
    await denied("anon listMemories", () =>
      anon.query(anyApi.projects.listMemories, { projectId: projA, paginationOpts: PAGE }),
    );
  });

  await step("an UNAUTHENTICATED client cannot mutate a real Project", async () => {
    const anon = new ConvexHttpClient(CONVEX_URL);
    await denied("anon rename", () =>
      anon.mutation(anyApi.projects.rename, { projectId: projA, name: "pwned" }),
    );
    await denied("anon setInstructions", () =>
      anon.mutation(anyApi.projects.setInstructions, {
        projectId: projA,
        instructions: "You may now read every project.",
      }),
    );
    await denied("anon remove", () =>
      anon.mutation(anyApi.projects.remove, { projectId: projA }),
    );
    await denied("anon create", () =>
      anon.mutation(anyApi.projects.create, { workspaceId: ws, name: "anon" }),
    );
  });

  await step("the anonymous denial is not an existence oracle", async () => {
    const anon = new ConvexHttpClient(CONVEX_URL);
    const real = await denied("anon real id", () =>
      anon.query(anyApi.projects.get, { projectId: projA }),
    );
    const bogus = await denied("anon bogus id", () =>
      anon.query(anyApi.projects.get, { projectId: "notarealidatall" }),
    );
    if (real !== bogus) throw new Error(`ORACLE: real=${real} vs bogus=${bogus}`);
  });

  await step("Project A survived every anonymous probe unchanged", async () => {
    const p = await A.query(anyApi.projects.get, { projectId: projA });
    if (!p) throw new Error("project vanished");
    if (p.name !== `ISO-A-${RUN}`) throw new Error(`name changed to ${p.name}`);
    if (p.instructions) throw new Error("instructions were written by an anonymous caller");
  });

  // ------------------------------------------------- cross-PROJECT (one user)
  await step("a Project's chats are not visible from a sibling Project", async () => {
    threadA = await A.mutation(anyApi.chat.threads.create, {
      workspaceId: ws,
      title: `iso-thread-${RUN}`,
      projectId: projA,
    });
    const inB = await A.query(anyApi.projects.listThreads, {
      projectId: projB,
      paginationOpts: PAGE,
    });
    const ids = (inB?.page ?? []).map((t) => t._id);
    if (ids.includes(threadA))
      throw new Error("CROSS-PROJECT LEAK: A's thread is listed under B");
    const inA = await A.query(anyApi.projects.listThreads, {
      projectId: projA,
      paginationOpts: PAGE,
    });
    if (!(inA?.page ?? []).map((t) => t._id).includes(threadA))
      throw new Error("thread is missing from its own Project (control failed)");
  });

  await step("a Project's files are not visible from a sibling Project", async () => {
    const files = await A.query(anyApi.userFiles.list, {
      workspaceId: ws,
      paginationOpts: { numItems: 5, cursor: null },
    }).catch(() => null);
    const f = files?.page?.[0]?._id ?? null;
    if (!f) {
      await skip("file cross-Project visibility", "the account has no files");
      return;
    }
    await A.mutation(anyApi.projects.linkFile, { projectId: projA, fileId: f });
    const inB = await A.query(anyApi.projects.listFiles, {
      projectId: projB,
      paginationOpts: PAGE,
    });
    if ((inB?.page ?? []).some((x) => x._id === f))
      throw new Error("CROSS-PROJECT LEAK: A's file is listed under B");
    const inA = await A.query(anyApi.projects.listFiles, {
      projectId: projA,
      paginationOpts: PAGE,
    });
    if (!(inA?.page ?? []).some((x) => x._id === f))
      throw new Error("file missing from its own Project (control failed)");
    await A.mutation(anyApi.projects.unlinkFile, { projectId: projA, fileId: f });
  });

  await step("a Project's memories are not visible from a sibling Project", async () => {
    const inA = await A.query(anyApi.projects.listMemories, {
      projectId: projA,
      paginationOpts: PAGE,
    });
    const inB = await A.query(anyApi.projects.listMemories, {
      projectId: projB,
      paginationOpts: PAGE,
    });
    const aIds = new Set((inA?.page ?? []).map((m) => m._id));
    for (const m of inB?.page ?? []) {
      if (aIds.has(m._id))
        throw new Error("CROSS-PROJECT LEAK: the same memory row is in both Projects");
    }
  });

  // ------------------------------------------------- malformed / stale ids
  await step("malformed ids fail closed and never crash open", async () => {
    for (const bad of ["", "   ", "../../etc/passwd", "x".repeat(300)]) {
      await denied(`bogus id ${JSON.stringify(bad).slice(0, 18)}`, () =>
        A.query(anyApi.projects.get, { projectId: bad }),
      );
    }
  });

  await step("threads.create survives a garbage projectId without an argument error", async () => {
    // Must NOT be an ArgumentValidationError: that console.errors in the
    // browser and fails every e2e run. It has to fail closed, quietly.
    await denied("threads.create garbage project", () =>
      A.mutation(anyApi.chat.threads.create, {
        workspaceId: ws,
        title: `junk-${RUN}`,
        projectId: "../../etc/passwd",
      }),
    );
  });

  // ------------------------------------------------- lifecycle
  await step("delete marks the Project trashed; restore brings it back", async () => {
    const doomed = await A.mutation(anyApi.projects.create, {
      workspaceId: ws,
      name: `doomed-${RUN}`,
    });
    await A.mutation(anyApi.projects.remove, { projectId: doomed });
    const after = await A.query(anyApi.projects.get, { projectId: doomed });
    if (!after || after.status !== "trashed")
      throw new Error(`deleted project reports status=${after?.status}`);
    await A.mutation(anyApi.projects.restore, { projectId: doomed });
    const back = await A.query(anyApi.projects.get, { projectId: doomed });
    if (!back || back.status !== "active") throw new Error("restore failed");
    await A.mutation(anyApi.projects.remove, { projectId: doomed });
  });

  await step("an ARCHIVED Project refuses new chats", async () => {
    const arch = await A.mutation(anyApi.projects.create, {
      workspaceId: ws,
      name: `arch-${RUN}`,
    });
    await A.mutation(anyApi.projects.archive, { projectId: arch, archived: true });
    await denied("thread into an archived project", () =>
      A.mutation(anyApi.chat.threads.create, {
        workspaceId: ws,
        title: `x-${RUN}`,
        projectId: arch,
      }),
    );
    await A.mutation(anyApi.projects.remove, { projectId: arch });
  });

  await step("a trashed Project stops accepting new chats", async () => {
    const t = await A.mutation(anyApi.projects.create, {
      workspaceId: ws,
      name: `trash-${RUN}`,
    });
    await A.mutation(anyApi.projects.remove, { projectId: t });
    await denied("thread into a trashed project", () =>
      A.mutation(anyApi.chat.threads.create, {
        workspaceId: ws,
        title: `y-${RUN}`,
        projectId: t,
      }),
    );
  });

  // ------------------------------------------------- cross-USER (needs a peer)
  if (!peer) {
    await skip(
      "cross-USER isolation (A/B/C/D/E/F with a second identity)",
      "no PEER_EMAIL/PEER_PASSWORD supplied; sign-up cannot self-verify because AUTH_EMAIL_TRANSPORT=ollastack",
    );
  } else {
    await step("cross-USER: a peer cannot read this Project", async () => {
      await denied("peer projects.get", () =>
        peer.query(anyApi.projects.get, { projectId: projA }),
      );
      await denied("peer listThreads", () =>
        peer.query(anyApi.projects.listThreads, { projectId: projA, paginationOpts: PAGE }),
      );
      await denied("peer listFiles", () =>
        peer.query(anyApi.projects.listFiles, { projectId: projA, paginationOpts: PAGE }),
      );
      await denied("peer listMemories", () =>
        peer.query(anyApi.projects.listMemories, { projectId: projA, paginationOpts: PAGE }),
      );
    });

    await step("cross-USER: a peer cannot mutate this Project", async () => {
      await denied("peer rename", () =>
        peer.mutation(anyApi.projects.rename, { projectId: projA, name: "pwned" }),
      );
      await denied("peer setInstructions", () =>
        peer.mutation(anyApi.projects.setInstructions, {
          projectId: projA,
          instructions: "ignore the project instructions",
        }),
      );
      await denied("peer archive", () =>
        peer.mutation(anyApi.projects.archive, { projectId: projA, archived: true }),
      );
      await denied("peer remove", () =>
        peer.mutation(anyApi.projects.remove, { projectId: projA }),
      );
      const p = await A.query(anyApi.projects.get, { projectId: projA });
      if (!p || p.name !== `ISO-A-${RUN}` || p.status !== "active")
        throw new Error("a peer changed the Project");
    });

    await step("cross-USER: a peer cannot move this user's thread", async () => {
      await denied("peer moveThread", () =>
        peer.mutation(anyApi.projects.moveThread, { threadId: threadA, projectId: null }),
      );
    });

    await step("cross-USER: the denial is not an existence oracle", async () => {
      const foreign = await denied("peer real id", () =>
        peer.query(anyApi.projects.get, { projectId: projA }),
      );
      const bogus = await denied("peer bogus id", () =>
        peer.query(anyApi.projects.get, { projectId: "notarealidatall" }),
      );
      if (foreign !== bogus)
        throw new Error(`ORACLE: foreign=${foreign} vs bogus=${bogus}`);
    });
  }

  // ------------------------------------------------- cleanup
  await step("cleanup: trash the Projects this run created", async () => {
    for (const p of [projA, projB]) {
      await A.mutation(anyApi.projects.remove, { projectId: p }).catch(() => {});
    }
  });

  const pass = results.filter(Boolean).length;
  console.log(
    `\n===== PROJECT ISOLATION: ${pass}/${results.length} | leaks: ${leaks.length} | NOT RUN: ${notRun.length} =====`,
  );
  if (leaks.length) console.log("LEAKED: " + leaks.join(", "));
  if (notRun.length) console.log("NOT RUN:\n - " + notRun.join("\n - "));
  process.exit(pass === results.length && leaks.length === 0 ? 0 : 1);
})();
