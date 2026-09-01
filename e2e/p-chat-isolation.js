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
//   CONVEX_URL=http://172.16.70.25:3210 node p-chat-isolation.js
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");
const ollastack = require("./_lib/ollastack");

// Default to the local backend. The previous default was the OLD VM's address,
// which still answers, so this suite silently exercised a different deployment
// and failed with "Could not find public function for 'chat/threads:create'"
// — a confusing way to discover you are talking to the wrong server.
const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
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

const MAILPIT = process.env.E2E_MAILPIT_URL || "http://127.0.0.1:8025";

/** Read a verification code out of Mailpit, newest message first. */
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

/**
 * A verification code, from wherever this deployment actually delivers mail.
 *
 * Ollastack first: once a real transport is configured, mail no longer reaches
 * the local Mailpit catcher at all, so reading Mailpit would look exactly like
 * "the code never arrived". Mailpit stays as the fallback for a replica.
 */
async function getVerificationCode(email) {
  if (ollastack.enabled()) {
    return await ollastack.codeForAddress(email, "verification", 120000);
  }
  return await codeFromMailpit(email);
}

/**
 * A real, run-isolated address.
 *
 * The old `<prefix><ts>@gmail.com` shape was harmless while every message went
 * to a local catcher. With a real transport it sends to NONEXISTENT Gmail
 * addresses, and every one of those bounces against a shared sending domain's
 * reputation. So the address has to be a mailbox that genuinely exists.
 */
async function testAddress(prefix) {
  if (ollastack.enabled()) return await ollastack.addressFor(prefix);
  return `${prefix}@${typeof DOMAIN === "string" ? DOMAIN : "myos.test"}`;
}

/**
 * Sign up and verify.
 *
 * The code is read from Mailpit, falling back to captured log output. The log
 * path alone is NOT sufficient: `authCodes.deliverCode` only logs the code when
 * no mail transport is configured, so once SMTP points at Mailpit the code stops
 * appearing in logs entirely and this failed with "no verification code
 * captured". Logging codes was also flagged as an auth-bypass risk for anyone
 * with log access, so the mail path is the one worth depending on.
 */
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
    let code = null;
    for (let i = 0; i < 14 && !code; i++) {
      code = await getVerificationCode(email);
      if (!code) await new Promise((r) => setTimeout(r, 1500));
    }
    const m = code
      ? [null, code]
      : captured.join("\n").match(/code for [^:]+: '?(\d+)/);
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
      // The address now carries a +tag, and usernames are alphanumeric
      // only — strip it rather than letting a valid address fail validation.
      username: email.split("@")[0].replace(/[^a-z0-9]/gi, "").slice(0, 20),
    });
    return authed;
  } finally {
    Object.assign(console, orig);
  }
}

(async () => {
  const ts = Date.now();
  const ownerEmailAddr = await testAddress(`chatowner${ts}`);
  const peerEmailAddr = await testAddress(`chatpeer${ts}`);
  const owner = await signUp(ownerEmailAddr, "ChatOwner#2026x");
  const peer = await signUp(peerEmailAddr, "ChatPeer#2026x");

  // Owner creates a workspace and invites the peer into it, so the peer is a
  // fully legitimate member — that is the whole point of the test.
  const ws = await owner.mutation(anyApi.orgs.createWorkspace, { name: "IsoWS" });
  const peerEmail = peerEmailAddr;
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

  // Pin the title as user-set, or the auto-titler will replace it.
  //
  // threads.create stores titleSource "auto" even when a title is supplied, and
  // once the first turn completes the Python plane calls chat/ingest:setTitle,
  // which overwrites any title that is not "user"-sourced. SECRET_TITLE then no
  // longer exists and the owner-side search control fails, which reads alarmingly
  // as "the isolation results above are vacuous". rename() sets titleSource
  // "user", which setTitle explicitly refuses to overwrite.
  //
  // This only began failing once chat generation worked again: with the AI plane
  // unreachable no title was ever generated, so the planted title survived.
  await owner.mutation(anyApi.chat.threads.rename, {
    threadId,
    title: SECRET_TITLE,
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
    // Convex text indexes are eventually consistent: writes land in the SQL store
    // immediately, but the index itself is rebuilt by the TextLiveFlusher into
    // file storage a moment later. Asserting instantly tests index latency rather
    // than search correctness, and it fails in the worst possible way — by
    // declaring the isolation checks above vacuous when they were in fact fine.
    //
    // Still bounded: if search is genuinely broken this fails after 30s, so the
    // control keeps its teeth. The peer-side denials above are NOT polled, on
    // purpose — a leak must never be given time to appear.
    let hits = [];
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      hits = await owner.query(anyApi.chat.search.threads, {
        workspaceId: ws,
        query: SECRET_TITLE,
      });
      if (hits && hits.length) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!hits || hits.length === 0) {
      throw new Error(
        "owner's own search returned nothing after 30s — the isolation results above are vacuous",
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
