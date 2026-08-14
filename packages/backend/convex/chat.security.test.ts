/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

/**
 * messages.send schedules internal.chat.stream.dispatch, which POSTs to the
 * Python service. Two things must be true for tests to be deterministic:
 *
 *  1. the service must be "configured", or dispatch fails the stream and every
 *     assertion about a pending/streaming message becomes a race;
 *  2. fetch must not touch the network.
 *
 * So: point AI_BASE_URL at a stub and intercept fetch. Tests then drain the
 * scheduler explicitly via drain() rather than letting the action outlive the
 * test transaction (which surfaces as "Write outside of transaction").
 */
const realFetch = globalThis.fetch;
let dispatched: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "test-service-key";
  dispatched = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    dispatched.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({ accepted: true }), { status: 202 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  // `process.env.X = undefined` stores the *string* "undefined", which is
  // truthy — the config guards in dispatch would then read as configured.
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_SERVICE_KEY;
});

/**
 * Run scheduled functions to completion inside the test.
 *
 * finishInProgressScheduledFunctions() only awaits functions that have already
 * STARTED. A ctx.scheduler.runAfter(0, ...) is queued on a macrotask, so we
 * have to yield the event loop first — otherwise the dispatch action starts
 * after the test's transaction has closed and surfaces as an unhandled
 * "Write outside of transaction".
 */
async function drain(t: ReturnType<typeof convexTest>) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function seedWorkspace(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test" });
    const member = await ctx.db.insert("users", { email: "member@t.test" });
    const outsider = await ctx.db.insert("users", { email: "outsider@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    for (const [userId, role] of [
      [owner, "owner"],
      [member, "member"],
    ] as const) {
      await ctx.db.insert("members", {
        workspaceId: ws,
        userId,
        role,
        createdAt: Date.now(),
      });
    }
    return { owner, member, outsider, ws };
  });
}

/** Owner creates a thread and sends one message; returns the ids. */
async function seedThread(
  t: ReturnType<typeof convexTest>,
  owner: Id<"users">,
  ws: Id<"workspaces">,
  content = "hello from the owner",
) {
  const u = t.withIdentity(as(owner));
  const threadId = await u.mutation(api.chat.threads.create, {
    workspaceId: ws,
    title: "owner thread",
  });
  const sent = await u.mutation(api.chat.messages.send, {
    threadId,
    content,
    clientId: `c-${Math.random()}`,
  });
  // Let the scheduled dispatch action run and settle inside the test.
  await drain(t);
  return { threadId, ...sent };
}

// ---------------------------------------------------------------------------
// The headline property. Every other table in this codebase treats the
// WORKSPACE as the trust boundary — any member reads any job, file or audit
// log. Chat inverts that: conversations are private to their author. Nothing
// in the existing suite checks this, and getting it wrong leaks every
// colleague's conversations to every colleague.
// ---------------------------------------------------------------------------
describe("chat is private to the USER, not the workspace", () => {
  // Read paths that deny by returning empty rather than throwing. This is
  // deliberate: "not found" and "not yours" must be indistinguishable, or the
  // error itself becomes an existence oracle for someone else's threadId.
  test("peer reads are denied silently, not with an oracle", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seedWorkspace(t);
    const ids = await seedThread(t, owner, ws);
    const peer = t.withIdentity(as(member));

    expect(
      await peer.query(api.chat.threads.get, { threadId: ids.threadId }),
    ).toBeNull();
    expect(
      await peer.query(api.chat.stream.active, { threadId: ids.threadId }),
    ).toBeNull();

    // A thread id that does not exist at all must look exactly the same.
    const bogus = await t.run(async (ctx) => {
      const id = await ctx.db.insert("chatThreads", {
        workspaceId: ws,
        userId: owner,
        title: "x",
        titleSource: "auto" as const,
        status: "active" as const,
        pinned: false,
        model: "anthropic/claude-opus-5",
        nextSeq: 0,
        messageCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        lastMessageAt: 0,
        createdAt: 0,
        updatedAt: 0,
      });
      await ctx.db.delete(id);
      return id;
    });
    expect(
      await peer.query(api.chat.threads.get, { threadId: bogus }),
    ).toBeNull();
  });

  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous fn table for a matrix
  const cases: Array<[string, (b: any, ids: any) => Promise<unknown>]> = [
    [
      "messages.listPaged",
      async (b, ids) => {
        // listPaged throws (rather than returning empty) because reaching it at
        // all requires a threadId the caller should not have.
        return await b.query(api.chat.messages.listPaged, {
          threadId: ids.threadId,
          paginationOpts: { numItems: 20, cursor: null },
        });
      },
    ],
    [
      "messages.send throws",
      (b, ids) =>
        b.mutation(api.chat.messages.send, {
          threadId: ids.threadId,
          content: "injected by a peer",
          clientId: "peer-1",
        }),
    ],
    [
      "threads.rename throws",
      (b, ids) =>
        b.mutation(api.chat.threads.rename, {
          threadId: ids.threadId,
          title: "hijacked",
        }),
    ],
    [
      "threads.remove throws",
      (b, ids) =>
        b.mutation(api.chat.threads.remove, { threadId: ids.threadId }),
    ],
    [
      "threads.setModel throws",
      (b, ids) =>
        b.mutation(api.chat.threads.setModel, {
          threadId: ids.threadId,
          model: "anthropic/claude-haiku-4.5",
        }),
    ],
    [
      "stream.stop throws",
      (b, ids) =>
        b.mutation(api.chat.stream.stop, { messageId: ids.assistantMessageId }),
    ],
    [
      "messages.get throws",
      (b, ids) =>
        b.query(api.chat.messages.get, { messageId: ids.userMessageId }),
    ],
    [
      "messages.regenerate throws",
      (b, ids) =>
        b.mutation(api.chat.messages.regenerate, {
          messageId: ids.assistantMessageId,
        }),
    ],
  ];

  for (const [name, call] of cases) {
    test(`same-workspace member is refused: ${name}`, async () => {
      const t = convexTest(schema, modules);
      const { owner, member, ws } = await seedWorkspace(t);
      const ids = await seedThread(t, owner, ws);
      // `member` is a legitimate, fully-authorized member of this workspace.
      await expect(call(t.withIdentity(as(member)), ids)).rejects.toThrow();
    });
  }

  test("the owner can still do all of it", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const ids = await seedThread(t, owner, ws);
    const u = t.withIdentity(as(owner));
    expect(
      await u.query(api.chat.threads.get, { threadId: ids.threadId }),
    ).toBeTruthy();
    const msgs = await u.query(api.chat.messages.listPaged, {
      threadId: ids.threadId,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(msgs.page.length).toBe(1); // the user message; assistant is in-flight
    await u.mutation(api.chat.threads.rename, {
      threadId: ids.threadId,
      title: "renamed",
    });
  });
});

// ---------------------------------------------------------------------------
describe("cross-tenant isolation matrix — chat surfaces", () => {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous fn table for a matrix
  const cases: Array<[string, (b: any, ws: any) => Promise<unknown>]> = [
    [
      "chat.threads.list",
      (b, ws) =>
        b.query(api.chat.threads.list, {
          workspaceId: ws,
          paginationOpts: { numItems: 5, cursor: null },
        }),
    ],
    [
      "chat.threads.listPinned",
      (b, ws) => b.query(api.chat.threads.listPinned, { workspaceId: ws }),
    ],
    [
      "chat.threads.create",
      (b, ws) => b.mutation(api.chat.threads.create, { workspaceId: ws }),
    ],
    [
      "chat.folders.list",
      (b, ws) => b.query(api.chat.folders.list, { workspaceId: ws }),
    ],
    [
      "chat.folders.create",
      (b, ws) =>
        b.mutation(api.chat.folders.create, { workspaceId: ws, name: "f" }),
    ],
    [
      "chat.prompts.list",
      (b, ws) => b.query(api.chat.prompts.list, { workspaceId: ws }),
    ],
    [
      "chat.prompts.create",
      (b, ws) =>
        b.mutation(api.chat.prompts.create, {
          workspaceId: ws,
          title: "t",
          body: "b",
        }),
    ],
    [
      "chat.settings.get",
      (b, ws) => b.query(api.chat.settings.get, { workspaceId: ws }),
    ],
    [
      "chat.settings.upsert",
      (b, ws) =>
        b.mutation(api.chat.settings.upsert, {
          workspaceId: ws,
          sendOnEnter: false,
        }),
    ],
    [
      "chat.attachments.generateUploadUrl",
      (b, ws) =>
        b.mutation(api.chat.attachments.generateUploadUrl, { workspaceId: ws }),
    ],
  ];
  for (const [name, call] of cases) {
    test(`outsider is denied: ${name}`, async () => {
      const t = convexTest(schema, modules);
      const { ws, outsider } = await seedWorkspace(t);
      await expect(call(t.withIdentity(as(outsider)), ws)).rejects.toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// Catches a dropped .eq("userId", userId) in a withSearchIndex chain. That is
// a ONE-LINE omission that leaks every conversation in the tenant, and no type
// checker will catch it, because the query is still perfectly valid without it.
describe("search does not leak across users", () => {
  /**
   * SKIPPED, and deliberately not deleted.
   *
   * convex-test 0.0.41 does not implement withSearchIndex at all (the string
   * does not appear in its dist), so every search query returns [] in-process.
   * Asserting "the peer got []" here would therefore PASS even if the
   * .eq("userId", userId) filter were removed entirely — a test that cannot
   * fail is worse than no test, because it reads as coverage.
   *
   * Newer convex-test does support it, but requires convex ^1.32 and this
   * project is pinned to 1.19.2 to stay aligned with the live self-hosted
   * deployment.
   *
   * => This property MUST be verified against a real deployment. See the
   *    e2e suite, which searches as two separate real accounts.
   */
  test.skip("a peer cannot find the owner's threads or message text", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seedWorkspace(t);

    const asOwner = t.withIdentity(as(owner));
    const threadId = await asOwner.mutation(api.chat.threads.create, {
      workspaceId: ws,
      title: "ownersecretalpha planning",
    });
    await asOwner.mutation(api.chat.messages.send, {
      threadId,
      content: "the passphrase is ownersecretbeta, do not share",
      clientId: "s1",
    });
    await drain(t);

    expect(
      await asOwner.query(api.chat.search.threads, {
        workspaceId: ws,
        query: "ownersecretalpha",
      }),
    ).toHaveLength(1);

    const peer = t.withIdentity(as(member));
    for (const term of ["ownersecretalpha", "ownersecretbeta", "planning"]) {
      expect(
        await peer.query(api.chat.search.threads, { workspaceId: ws, query: term }),
      ).toEqual([]);
      expect(
        await peer.query(api.chat.search.messages, { workspaceId: ws, query: term }),
      ).toEqual([]);
    }
  });

  test("an outsider is refused outright", async () => {
    const t = convexTest(schema, modules);
    const { ws, outsider } = await seedWorkspace(t);
    await expect(
      t
        .withIdentity(as(outsider))
        .query(api.chat.search.threads, { workspaceId: ws, query: "anything" }),
    ).rejects.toThrow();
  });

  test("a too-short term returns nothing rather than scanning the index", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    await seedThread(t, owner, ws);
    const u = t.withIdentity(as(owner));
    expect(
      await u.query(api.chat.search.threads, { workspaceId: ws, query: "a" }),
    ).toEqual([]);
    expect(
      await u.query(api.chat.search.threads, { workspaceId: ws, query: "   " }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("attachments", () => {
  async function seedAttachment(
    t: ReturnType<typeof convexTest>,
    userId: Id<"users">,
    ws: Id<"workspaces">,
  ) {
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["hello"], { type: "text/plain" })),
    );
    const attachmentId = await t
      .withIdentity(as(userId))
      .mutation(api.chat.attachments.register, {
        workspaceId: ws,
        storageId,
        name: "secret.txt",
        size: 5,
        contentType: "text/plain",
      });
    return { storageId, attachmentId };
  }

  test("a peer cannot read another user's attachment", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seedWorkspace(t);
    const { attachmentId } = await seedAttachment(t, owner, ws);
    await expect(
      t
        .withIdentity(as(member))
        .query(api.chat.attachments.get, { attachmentId }),
    ).rejects.toThrow();
  });

  test("a peer cannot claim-squat another user's storageId", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seedWorkspace(t);
    const { storageId } = await seedAttachment(t, owner, ws);
    // Without the by_storage uniqueness check, `member` could register the
    // owner's blob and then read the bytes through the sanctioned path.
    await expect(
      t.withIdentity(as(member)).mutation(api.chat.attachments.register, {
        workspaceId: ws,
        storageId,
        name: "stolen.txt",
        size: 5,
        contentType: "text/plain",
      }),
    ).rejects.toThrow(/Already registered/);
  });

  test("storageId is never exposed to the client", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const { attachmentId } = await seedAttachment(t, owner, ws);
    const row = await t
      .withIdentity(as(owner))
      .query(api.chat.attachments.get, { attachmentId });
    // ctx.storage.getUrl() is a bearer capability: anyone with the URL fetches
    // the bytes. The id must not leak so a client can never mint its own.
    expect(row).not.toHaveProperty("storageId");
    expect(row).toHaveProperty("url");
  });

  test("unsupported file types are rejected", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["MZ"], { type: "application/x-msdownload" })),
    );
    await expect(
      t.withIdentity(as(owner)).mutation(api.chat.attachments.register, {
        workspaceId: ws,
        storageId,
        name: "evil.exe",
        size: 2,
        contentType: "application/x-msdownload",
      }),
    ).rejects.toThrow(/Unsupported file type/);
  });
});

// ---------------------------------------------------------------------------
describe("AI ingress (/ai/ingress)", () => {
  const SECRET = "test-ingress-secret-0123456789ab";
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.AI_INGRESS_SECRET;
    process.env.AI_INGRESS_SECRET = SECRET;
  });
  afterEach(() => {
    if (prev === undefined) {
      // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
      delete process.env.AI_INGRESS_SECRET;
    } else {
      process.env.AI_INGRESS_SECRET = prev;
    }
  });

  const post = (
    t: ReturnType<typeof convexTest>,
    body: unknown,
    key: string | null = SECRET,
  ) =>
    t.fetch("/ai/ingress", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { "x-ai-key": key } : {}),
      },
      body: JSON.stringify(body),
    });

  test("missing key is rejected", async () => {
    const t = convexTest(schema, modules);
    const res = await post(t, { op: "heartbeat", streamId: "x" }, null);
    expect(res.status).toBe(401);
  });

  test("wrong key is rejected", async () => {
    const t = convexTest(schema, modules);
    const res = await post(
      t,
      { op: "heartbeat", streamId: "x" },
      "wrong-key-aaaaaaaaaaaaaaaaaaaa",
    );
    expect(res.status).toBe(401);
  });

  test("correct key + unknown streamId writes NOTHING", async () => {
    const t = convexTest(schema, modules);
    const res = await post(t, {
      op: "delta",
      streamId: "00000000-0000-0000-0000-000000000000",
      deltas: [{ seq: 0, text: "should not persist" }],
    });
    expect(res.status).toBe(404);
    // The row count is the assertion that matters: it proves the ingress is
    // capability-scoped, not merely secret-gated.
    const count = await t.run(
      async (ctx) => (await ctx.db.query("chatStreamChunks").collect()).length,
    );
    expect(count).toBe(0);
  });

  test("deltas are idempotent, order-independent, and finalize wins", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const { threadId, streamId, assistantMessageId } = await seedThread(
      t,
      owner,
      ws,
    );
    expect(streamId).toBeTruthy();

    // Duplicate seq — an HTTP retry must not double-write.
    await post(t, {
      op: "delta",
      streamId,
      deltas: [{ seq: 0, text: "Hello" }],
    });
    await post(t, {
      op: "delta",
      streamId,
      deltas: [{ seq: 0, text: "Hello" }],
    });
    // Out of order — seq 2 lands before seq 1.
    await post(t, {
      op: "delta",
      streamId,
      deltas: [{ seq: 2, text: " world" }],
    });
    await post(t, { op: "delta", streamId, deltas: [{ seq: 1, text: "," }] });

    const chunks = await t.run(async (ctx) =>
      ctx.db
        .query("chatStreamChunks")
        .withIndex("by_message_seq", (q) =>
          q.eq("messageId", assistantMessageId as Id<"chatMessages">),
        )
        .collect(),
    );
    expect(chunks.length).toBe(3); // not 4 — the duplicate was dropped

    const live = await t
      .withIdentity(as(owner))
      .query(api.chat.stream.active, { threadId });
    // The read path orders by seq, so out-of-order arrival self-heals.
    expect(
      (live?.committedText ?? "") +
        (live?.chunks ?? []).map((c) => c.text).join(""),
    ).toBe("Hello, world");

    await post(t, {
      op: "finalize",
      streamId,
      status: "done",
      text: "Hello, world!",
      usage: { promptTokens: 10, completionTokens: 4 },
    });

    const msg = await t.run(async (ctx) =>
      ctx.db.get(assistantMessageId as Id<"chatMessages">),
    );
    expect(msg?.status).toBe("complete");
    expect(msg?.content).toBe("Hello, world!"); // finalize text is authoritative
    const left = await t.run(
      async (ctx) => (await ctx.db.query("chatStreamChunks").collect()).length,
    );
    expect(left).toBe(0); // chunks cleaned up
  });

  test("finalize after stop does not resurrect an aborted message", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const { streamId, assistantMessageId } = await seedThread(t, owner, ws);

    await post(t, {
      op: "delta",
      streamId,
      deltas: [{ seq: 0, text: "partial" }],
    });
    await t.withIdentity(as(owner)).mutation(api.chat.stream.stop, {
      messageId: assistantMessageId as Id<"chatMessages">,
    });

    // Python is still mid-flight and posts a finalize. It must be ignored.
    await post(t, {
      op: "finalize",
      streamId,
      status: "done",
      text: "the full answer the user cancelled",
    });

    const msg = await t.run(async (ctx) =>
      ctx.db.get(assistantMessageId as Id<"chatMessages">),
    );
    expect(msg?.status).toBe("aborted");
    expect(msg?.content).toBe("partial");
  });

  test("a stopped stream tells Python to cancel on its next delta", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const { streamId, assistantMessageId } = await seedThread(t, owner, ws);
    await t.withIdentity(as(owner)).mutation(api.chat.stream.stop, {
      messageId: assistantMessageId as Id<"chatMessages">,
    });
    const res = await post(t, {
      op: "delta",
      streamId,
      deltas: [{ seq: 5, text: "more" }],
    });
    expect(await res.json()).toMatchObject({ cancel: true });
  });
});

// ---------------------------------------------------------------------------
describe("send() invariants", () => {
  test("duplicate clientId does not create a second turn", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const u = t.withIdentity(as(owner));
    const threadId = await u.mutation(api.chat.threads.create, {
      workspaceId: ws,
    });
    const a = await u.mutation(api.chat.messages.send, {
      threadId,
      content: "hi",
      clientId: "same-id",
    });
    const b = await u.mutation(api.chat.messages.send, {
      threadId,
      content: "hi",
      clientId: "same-id",
    });
    await drain(t);
    expect(b.deduped).toBe(true);
    expect(b.userMessageId).toBe(a.userMessageId);
    const n = await t.run(
      async (ctx) => (await ctx.db.query("chatMessages").collect()).length,
    );
    expect(n).toBe(2); // one user + one assistant, not four
  });

  test("a second send while generating is refused", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const u = t.withIdentity(as(owner));
    const threadId = await u.mutation(api.chat.threads.create, {
      workspaceId: ws,
    });
    await u.mutation(api.chat.messages.send, {
      threadId,
      content: "first",
      clientId: "c1",
    });
    await drain(t);
    await expect(
      u.mutation(api.chat.messages.send, {
        threadId,
        content: "second",
        clientId: "c2",
      }),
    ).rejects.toThrow(/already generating/i);
  });

  test("an unsupported model is refused", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const u = t.withIdentity(as(owner));
    const threadId = await u.mutation(api.chat.threads.create, {
      workspaceId: ws,
    });
    await expect(
      u.mutation(api.chat.messages.send, {
        threadId,
        content: "hi",
        clientId: "c1",
        model: "openai/gpt-4o",
      }),
    ).rejects.toThrow(/Unsupported model/);
  });

  test("empty message is refused", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const u = t.withIdentity(as(owner));
    const threadId = await u.mutation(api.chat.threads.create, {
      workspaceId: ws,
    });
    await expect(
      u.mutation(api.chat.messages.send, {
        threadId,
        content: "   ",
        clientId: "c1",
      }),
    ).rejects.toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// Pins the wire contract the Python service depends on. If any of this drifts,
// the inference plane breaks in a way no type checker can catch.
describe("dispatch contract (Convex -> Python)", () => {
  test("POSTs /v1/generate with the service key and a complete payload", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const { streamId, threadId } = await seedThread(
      t,
      owner,
      ws,
      "what is 2+2?",
    );

    expect(dispatched.length).toBe(1);
    const call = dispatched[0];
    expect(call?.url).toBe("http://ai.invalid:8000/v1/generate");

    const body = call?.body as Record<string, unknown>;
    expect(body.streamId).toBe(streamId);
    expect(body.threadId).toBe(threadId);
    expect(body.model).toBe("anthropic/claude-opus-5");
    // History excludes the in-flight assistant row and includes the user turn.
    const history = body.history as Array<{ role: string; content: string }>;
    expect(history.map((h) => h.role)).toEqual(["user"]);
    expect(history[0]?.content).toBe("what is 2+2?");
  });

  test("a dispatch failure surfaces as an error message, not a hang", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    // Inference service down.
    globalThis.fetch = (async () =>
      new Response("boom", { status: 503 })) as typeof fetch;

    const { threadId, assistantMessageId } = await seedThread(t, owner, ws);
    const msg = await t.run(async (ctx) =>
      ctx.db.get(assistantMessageId as Id<"chatMessages">),
    );
    expect(msg?.status).toBe("error");
    expect(msg?.errorCode).toBe("dispatch_failed");
    // And crucially the thread is unblocked so the user can retry.
    const thread = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(thread?.streamingMessageId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("stall reaper", () => {
  test("a stream whose worker died is finalized as an error", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const { threadId, assistantMessageId } = await seedThread(t, owner, ws);

    // Simulate a SIGKILLed Python process: running, but no heartbeat for ages.
    await t.run(async (ctx) => {
      const s = await ctx.db
        .query("chatStreams")
        .withIndex("by_message", (q) =>
          q.eq("messageId", assistantMessageId as Id<"chatMessages">),
        )
        .unique();
      if (s) {
        await ctx.db.patch(s._id, {
          status: "running",
          heartbeatAt: Date.now() - 10 * 60 * 1000,
        });
      }
    });

    await t.mutation(internal.chat.stream.reapStalled, {});

    const msg = await t.run(async (ctx) =>
      ctx.db.get(assistantMessageId as Id<"chatMessages">),
    );
    expect(msg?.status).toBe("error");
    const thread = await t.run(async (ctx) => ctx.db.get(threadId));
    // Crucially the thread is unblocked, so the user can send again.
    expect(thread?.streamingMessageId).toBeUndefined();
  });
});
