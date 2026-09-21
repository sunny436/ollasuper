/**
 * messages.createAndSend — one round trip for "create a thread and send its
 * first message". Behaviour must be indistinguishable from the old
 * `threads.create` then `messages.send` pair, INCLUDING the error path: a
 * rejected first send used to leave the freshly created thread behind and
 * show a toast, so here it returns `{ threadId, sendError }` instead of
 * throwing (which would roll the thread back), and never consumes hourly
 * budget for a rejected send. Idempotency by clientId is checked first.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "test-service-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ accepted: true }), { status: 202 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  // biome-ignore lint/performance/noDelete: must be absent, not "undefined"
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: same
  delete process.env.AI_SERVICE_KEY;
});

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test" });
    const outsider = await ctx.db.insert("users", { email: "outsider@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId: ws,
      userId: owner,
      role: "owner",
      createdAt: Date.now(),
    });
    return { owner, outsider, ws };
  });
}

async function drain(t: ReturnType<typeof convexTest>) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

const threadsOf = (t: ReturnType<typeof convexTest>, userId: Id<"users">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("chatThreads").collect()).filter((x) => x.userId === userId),
  );
const messagesIn = (t: ReturnType<typeof convexTest>, threadId: Id<"chatThreads">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("chatMessages").collect()).filter((m) => m.threadId === threadId),
  );
const quota = (t: ReturnType<typeof convexTest>, userId: Id<"users">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("userQuotas")
      .withIndex("by_user_kind", (q) => q.eq("userId", userId).eq("kind", "chat"))
      .unique(),
  );

describe("messages.createAndSend", () => {
  test("creates the thread and the first turn exactly like create + send", { timeout: 180_000 }, async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const u = t.withIdentity(as(owner));

    const r = await u.mutation(api.chat.messages.createAndSend, {
      workspaceId: ws,
      content: "hello there",
      clientId: "c1",
    });
    expect(r.sendError).toBeUndefined();
    if (r.sendError !== undefined) throw new Error("unreachable");
    expect(r.deduped).toBe(false);

    const threads = await threadsOf(t, owner);
    expect(threads).toHaveLength(1);
    const thread = threads[0];
    if (!thread) throw new Error("no thread");
    expect(thread._id).toBe(r.threadId);
    expect(thread.workspaceId).toBe(ws);
    // Same side effects as the old pair: title from the first message, two
    // rows (user + pending assistant), streaming row, stream control row.
    expect(thread.title).toBe("hello there");
    expect(thread.messageCount).toBe(2);
    expect(thread.streamingMessageId).toBe(r.assistantMessageId);
    const msgs = await messagesIn(t, r.threadId);
    expect(msgs.map((m) => m.role).sort()).toEqual(["assistant", "user"]);
    expect(msgs.find((m) => m.role === "user")?.clientId).toBe("c1");
    expect((await quota(t, owner))?.windowCount).toBe(1);
    await drain(t);
  });

  test("a replayed request (same clientId) returns the SAME thread, never a second one", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const u = t.withIdentity(as(owner));
    const args = { workspaceId: ws, content: "once", clientId: "same" };

    const a = await u.mutation(api.chat.messages.createAndSend, args);
    const b = await u.mutation(api.chat.messages.createAndSend, args);
    expect(b.threadId).toBe(a.threadId);
    expect(b.sendError).toBeUndefined();
    if (b.sendError !== undefined) throw new Error("unreachable");
    expect(b.deduped).toBe(true);
    expect(b.userMessageId).toBe(a.sendError === undefined ? a.userMessageId : null);
    expect(await threadsOf(t, owner)).toHaveLength(1);
    expect((await quota(t, owner))?.windowCount).toBe(1);
    await drain(t);
  });

  test("two different clientIds are two threads, as two sends were", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const u = t.withIdentity(as(owner));
    await u.mutation(api.chat.messages.createAndSend, { workspaceId: ws, content: "a", clientId: "x" });
    await u.mutation(api.chat.messages.createAndSend, { workspaceId: ws, content: "b", clientId: "y" });
    expect(await threadsOf(t, owner)).toHaveLength(2);
    await drain(t);
  });

  test("a rejected send keeps the thread, returns the error, consumes no budget", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const u = t.withIdentity(as(owner));

    // "Message cannot be empty" is the first check send makes.
    const r = await u.mutation(api.chat.messages.createAndSend, {
      workspaceId: ws,
      content: "   ",
      clientId: "empty",
    });
    expect(r.sendError).toBe("Message cannot be empty");
    const threads = await threadsOf(t, owner);
    expect(threads).toHaveLength(1); // the thread exists, exactly as before
    expect(threads[0]?._id).toBe(r.threadId);
    expect(threads[0]?.messageCount).toBe(0);
    expect(await messagesIn(t, r.threadId)).toHaveLength(0);
    expect(await quota(t, owner)).toBeNull();
  });

  test("hourly limit: thread created, error returned, count unchanged", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const u = t.withIdentity(as(owner));
    await t.run((ctx) =>
      ctx.db.insert("userQuotas", {
        userId: owner,
        kind: "chat",
        windowStart: Date.now(),
        windowCount: 120,
      }),
    );
    const r = await u.mutation(api.chat.messages.createAndSend, {
      workspaceId: ws,
      content: "over the limit",
      clientId: "limit",
    });
    expect(r.sendError).toMatch(/Hourly message limit reached/);
    expect(await threadsOf(t, owner)).toHaveLength(1);
    expect((await quota(t, owner))?.windowCount).toBe(120);
  });

  test("an unsupported explicit model is rejected by thread creation, so nothing is created", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const u = t.withIdentity(as(owner));
    // threads.create itself rejects an explicit unknown model, before anything
    // is written — identical to the old flow, where create threw first.
    await expect(
      u.mutation(api.chat.messages.createAndSend, {
        workspaceId: ws,
        content: "hi",
        clientId: "model",
        model: "not/a-model",
      }),
    ).rejects.toThrow(/Unsupported model/);
    expect(await threadsOf(t, owner)).toHaveLength(0);
    expect(await quota(t, owner)).toBeNull();
  });

  test("an attachment owned by someone else is rejected, thread kept, no budget used", async () => {
    const t = convexTest(schema, modules);
    const { owner, outsider, ws } = await seed(t);
    await t.run((ctx) =>
      ctx.db.insert("members", { workspaceId: ws, userId: outsider, role: "member", createdAt: Date.now() }),
    );
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["x"], { type: "text/plain" })),
    );
    const foreign = await t.withIdentity(as(outsider)).mutation(api.chat.attachments.register, {
      workspaceId: ws,
      storageId,
      name: "x.txt",
      size: 1,
      contentType: "text/plain",
    });
    const u = t.withIdentity(as(owner));
    const r = await u.mutation(api.chat.messages.createAndSend, {
      workspaceId: ws,
      content: "with a foreign file",
      clientId: "attach",
      attachmentIds: [foreign],
    });
    expect(r.sendError).toBe("Not found");
    expect(await threadsOf(t, owner)).toHaveLength(1);
    expect(await quota(t, owner)).toBeNull();
  });

  test("a non-member cannot create in the workspace at all (throws, nothing created)", async () => {
    const t = convexTest(schema, modules);
    const { outsider, ws } = await seed(t);
    await expect(
      t.withIdentity(as(outsider)).mutation(api.chat.messages.createAndSend, {
        workspaceId: ws,
        content: "hi",
        clientId: "out",
      }),
    ).rejects.toThrow();
    expect(await threadsOf(t, outsider)).toHaveLength(0);
  });

  test("a foreign or archived project is rejected before anything is created", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const u = t.withIdentity(as(owner));
    await expect(
      u.mutation(api.chat.messages.createAndSend, {
        workspaceId: ws,
        content: "hi",
        clientId: "proj",
        projectId: "not-a-project-id",
      }),
    ).rejects.toThrow();
    expect(await threadsOf(t, owner)).toHaveLength(0);
  });

  test("plain send still consumes the window exactly once per accepted turn", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const u = t.withIdentity(as(owner));
    const threadId = await u.mutation(api.chat.threads.create, { workspaceId: ws });
    await u.mutation(api.chat.messages.send, { threadId, content: "one", clientId: "s1" });
    expect((await quota(t, owner))?.windowCount).toBe(1);
    // second send while the first is still generating → rejected, no budget burned
    await expect(
      u.mutation(api.chat.messages.send, { threadId, content: "two", clientId: "s2" }),
    ).rejects.toThrow(/already generating/);
    expect((await quota(t, owner))?.windowCount).toBe(1);
    await drain(t);
  });
});
