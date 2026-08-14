// Cross-user chat isolation against a REAL deployment.
//
// This exists because the in-process suite cannot cover it: convex-test 0.0.41
// does not implement withSearchIndex, so a search-leak assertion there would
// pass even with the userId filter removed. See the skipped test in
// packages/backend/convex/chat.security.test.ts.
//
// Two real accounts in the SAME workspace. Chat inverts this codebase's usual
// trust model — everywhere else a workspace member may read any job, file or
// audit log; conversations are private to their author.
//
//   CONVEX_URL=http://10.1.30.14:3210 node p-chat-isolation.js
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");

const CONVEX_URL = process.env.CONVEX_URL || "http://10.1.30.14:3210";
const results = [];

const step = async (n, f) => {
  try {
    await f();
    results.push(true);
    console.log("PASS  " + n);
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + n + " — " + e.message.split("\n")[0]);
  }
};

const denied = async (label, fn) => {
  let threw = false;
  let value;
  try {
    value = await fn();
  } catch {
    threw = true;
  }
  // Reads deny by returning empty rather than throwing, deliberately: "not
  // found" and "not yours" must be indistinguishable, or the error is an
  // existence oracle. So accept either shape — but never real data.
  const empty =
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (value && Array.isArray(value.page) && value.page.length === 0);
  if (!threw && !empty) {
    throw new Error(`${label} LEAKED: ${JSON.stringify(value).slice(0, 160)}`);
  }
};

/** Sign up and verify, capturing the code the backend logs (see ci-bootstrap.js). */
async function signUp(email, password) {
  const captured = [];
  const orig = { warn: console.warn, log: console.log, error: console.error };
  for (const k of ["warn", "log", "error"]) {
    console[k] = (...a) => {
      captured.push(a.join(" "));
    };
  }
  try {
    const c = new ConvexHttpClient(CONVEX_URL);
    await c.action(anyApi.auth.signIn, {
      provider: "password",
      params: { email, password, flow: "signUp" },
    });
    const m = captured.join("\n").match(/code for [^:]+: '?(\d+)/);
    if (!m) throw new Error("no verification code captured for " + email);
    const verified = await c.action(anyApi.auth.signIn, {
      provider: "password",
      params: { email, code: m[1], flow: "email-verification" },
    });
    const token = verified?.tokens?.token;
    if (!token) throw new Error("no token for " + email);
    const authed = new ConvexHttpClient(CONVEX_URL);
    authed.setAuth(token);
    await authed.mutation(anyApi.users.updateUsername, {
      username: email.split("@")[0].slice(0, 20),
    });
    return authed;
  } finally {
    Object.assign(console, orig);
  }
}

(async () => {
  const ts = Date.now();
  const owner = await signUp(`chatowner${ts}@myos.test`, "ChatOwner#2026x");
  const peer = await signUp(`chatpeer${ts}@myos.test`, "ChatPeer#2026x");

  // Owner creates a workspace and invites the peer into it, so the peer is a
  // fully legitimate member — that is the whole point of the test.
  const ws = await owner.mutation(anyApi.orgs.createWorkspace, { name: "IsoWS" });
  const peerEmail = `chatpeer${ts}@myos.test`;
  await owner.mutation(anyApi.orgs.invite, {
    workspaceId: ws,
    email: peerEmail,
    role: "member",
  });
  await peer.mutation(anyApi.orgs.acceptInvite, {
    // acceptInvite takes the invite row; find it as the peer.
    inviteId: (await peer.query(anyApi.orgs.myInvites, {}))[0]._id,
  });

  const SECRET_TITLE = `ownersecret${ts}`;
  const SECRET_BODY = `passphrase-${ts}-do-not-share`;

  const threadId = await owner.mutation(anyApi.chat.threads.create, {
    workspaceId: ws,
    title: SECRET_TITLE,
  });
  await owner.mutation(anyApi.chat.messages.send, {
    threadId,
    content: SECRET_BODY,
    clientId: `iso-${ts}`,
  });

  await step("peer is a real member of the workspace", async () => {
    const members = await peer.query(anyApi.orgs.members, { workspaceId: ws });
    if (!members || members.length < 2) throw new Error("peer is not a member");
  });

  await step("owner can read their own thread", async () => {
    const t = await owner.query(anyApi.chat.threads.get, { threadId });
    if (!t) throw new Error("owner cannot read own thread");
  });

  await step("peer cannot read the thread", () =>
    denied("threads.get", () =>
      peer.query(anyApi.chat.threads.get, { threadId }),
    ),
  );

  await step("peer cannot list the messages", () =>
    denied("messages.listPaged", () =>
      peer.query(anyApi.chat.messages.listPaged, {
        threadId,
        paginationOpts: { numItems: 50, cursor: null },
      }),
    ),
  );

  await step("peer cannot read the live stream", () =>
    denied("stream.active", () =>
      peer.query(anyApi.chat.stream.active, { threadId }),
    ),
  );

  await step("peer cannot see it in their own thread list", async () => {
    const page = await peer.query(anyApi.chat.threads.list, {
      workspaceId: ws,
      paginationOpts: { numItems: 50, cursor: null },
    });
    const hit = (page.page || []).some((t) => t.title === SECRET_TITLE);
    if (hit) throw new Error("thread appeared in the peer's list");
  });

  // THE test convex-test cannot run.
  await step("peer cannot find the thread title by search", () =>
    denied("search.threads", () =>
      peer.query(anyApi.chat.search.threads, {
        workspaceId: ws,
        query: SECRET_TITLE,
      }),
    ),
  );

  await step("peer cannot find the message body by search", () =>
    denied("search.messages", () =>
      peer.query(anyApi.chat.search.messages, {
        workspaceId: ws,
        query: SECRET_BODY,
      }),
    ),
  );

  await step("peer cannot find it via combined search", () =>
    denied("search.combined", () =>
      peer.query(anyApi.chat.search.combined, {
        workspaceId: ws,
        query: SECRET_BODY,
      }),
    ),
  );

  await step("owner CAN find it by search (proves search actually works)", async () => {
    const hits = await owner.query(anyApi.chat.search.threads, {
      workspaceId: ws,
      query: SECRET_TITLE,
    });
    if (!hits || hits.length === 0) {
      throw new Error(
        "owner's own search returned nothing — the isolation results above are vacuous",
      );
    }
  });

  await step("peer cannot mutate the thread", () =>
    denied("threads.rename", () =>
      peer.mutation(anyApi.chat.threads.rename, {
        threadId,
        title: "hijacked",
      }),
    ),
  );

  await step("peer cannot send into the thread", () =>
    denied("messages.send", () =>
      peer.mutation(anyApi.chat.messages.send, {
        threadId,
        content: "injected",
        clientId: `inj-${ts}`,
      }),
    ),
  );

  await step("peer cannot delete the thread", () =>
    denied("threads.remove", () =>
      peer.mutation(anyApi.chat.threads.remove, { threadId }),
    ),
  );

  const passed = results.filter(Boolean).length;
  console.log(`\n===== CHAT ISOLATION: ${passed}/${results.length} =====`);
  if (passed !== results.length) process.exit(1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
