/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
type TestT = ReturnType<typeof convexTest>;

/**
 * PHASE 5 — Project scope across recovery.
 *
 * The reason recovery is safe is structural rather than defensive:
 * `dispatchPayload` RE-READS the thread on every call, and `redispatch` (the
 * reaper/resume path) goes through the same query as the first dispatch. So
 * there is no serialized Project identity anywhere that could go stale, be
 * replayed, or be tampered with — the authoritative relationship is consulted
 * fresh each time.
 *
 * These tests pin that property. If someone ever caches the resolved scope on
 * the stream or the occurrence "for performance", they break here.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "test-service-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ accepted: true }), {
      status: 202,
    })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_SERVICE_KEY;
});

async function drain(t: TestT) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function seed(t: TestT) {
  const { userId, ws } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "u@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId: ws,
      userId,
      role: "owner",
      createdAt: Date.now(),
    });
    return { userId, ws };
  });
  return { userId, ws, u: t.withIdentity(as(userId)) };
}

/** Land an in-flight turn so the next one may start. */
async function settle(t: TestT, threadId: Id<"chatThreads">) {
  await t.run(async (ctx) => {
    await ctx.db.patch(threadId, { streamingMessageId: undefined });
    for (const s of await ctx.db.query("chatStreams").collect()) {
      if (s.threadId !== threadId) continue;
      if (s.status === "queued" || s.status === "running") {
        await ctx.db.patch(s._id, { status: "done" });
      }
    }
  });
}

const payloadOf = (t: TestT, streamId: string) =>
  t.query(internal.chat.stream.dispatchPayload, { streamId });

describe("project scope survives every regeneration path", () => {
  test("send, retry and regenerate all resolve the same Project scope", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
      instructions: "Answer tersely.",
    });
    await t.run(async (ctx) => {
      const now = Date.now();
      const fileId = await ctx.db.insert("userFiles", {
        userId,
        workspaceId: ws,
        name: "spec.pdf",
        size: 10,
        contentType: "application/pdf",
        ingestId: "ing-1",
        status: "ready",
        attempts: 0,
        contentHash: "h",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("projectFiles", {
        projectId,
        fileId,
        userId,
        addedAt: now,
      });
    });

    const threadId = await u.mutation(api.chat.threads.create, {
      workspaceId: ws,
      projectId,
    });

    const sent = await u.mutation(api.chat.messages.send, {
      threadId,
      content: "hello",
      clientId: "c1",
    });
    await drain(t);
    const first = await payloadOf(t, sent.streamId as string);
    expect(first?.projectInstructions).toBe("Answer tersely.");
    expect(first?.ragFileIds).toEqual(["ing-1"]);

    // RETRY — reuses the message, seeds attempts, and re-enters the same query.
    await settle(t, threadId);
    await t.run(async (ctx) => {
      await ctx.db.patch(sent.assistantMessageId as Id<"chatMessages">, {
        status: "error",
      });
    });
    const retried = await u.mutation(api.chat.messages.retry, {
      messageId: sent.assistantMessageId as Id<"chatMessages">,
    });
    await drain(t);
    const afterRetry = await payloadOf(t, retried.streamId as string);
    expect(afterRetry?.projectInstructions).toBe("Answer tersely.");
    expect(afterRetry?.ragFileIds).toEqual(["ing-1"]);

    // REGENERATE — a new variant, same thread, same Project.
    await settle(t, threadId);
    await t.run(async (ctx) => {
      await ctx.db.patch(sent.assistantMessageId as Id<"chatMessages">, {
        status: "complete",
      });
    });
    const regen = await u.mutation(api.chat.messages.regenerate, {
      messageId: sent.assistantMessageId as Id<"chatMessages">,
    });
    await drain(t);
    const afterRegen = await payloadOf(t, regen.streamId);
    expect(afterRegen?.projectInstructions).toBe("Answer tersely.");
    expect(afterRegen?.ragFileIds).toEqual(["ing-1"]);
  });

  test("a resumed stream re-reads the CURRENT Project state, never a snapshot", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
      instructions: "Version A.",
    });
    const threadId = await u.mutation(api.chat.threads.create, {
      workspaceId: ws,
      projectId,
    });
    const sent = await u.mutation(api.chat.messages.send, {
      threadId,
      content: "hello",
      clientId: "c1",
    });
    await drain(t);
    expect((await payloadOf(t, sent.streamId as string))?.projectInstructions).toBe(
      "Version A.",
    );

    // The Project changes mid-flight. redispatch (the reaper path) calls the
    // SAME dispatchPayload, so a resumed turn picks up current state rather
    // than replaying a stale copy — there is no cached scope to go stale.
    await u.mutation(api.projects.setInstructions, {
      projectId,
      instructions: "Version B.",
    });
    expect((await payloadOf(t, sent.streamId as string))?.projectInstructions).toBe(
      "Version B.",
    );
  });

  test("moving a chat out of a Project narrows the very next dispatch", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const projectId = await u.mutation(api.projects.create, {
      workspaceId: ws,
      name: "P",
      instructions: "Project voice.",
    });
    const threadId = await u.mutation(api.chat.threads.create, {
      workspaceId: ws,
      projectId,
    });
    const first = await u.mutation(api.chat.messages.send, {
      threadId,
      content: "one",
      clientId: "c1",
    });
    await drain(t);
    expect((await payloadOf(t, first.streamId as string))?.projectInstructions).toBe(
      "Project voice.",
    );

    await settle(t, threadId);
    await u.mutation(api.projects.moveThread, { threadId, projectId: null });

    const second = await u.mutation(api.chat.messages.send, {
      threadId,
      content: "two",
      clientId: "c2",
    });
    await drain(t);
    const after = await payloadOf(t, second.streamId as string);
    // Scope is re-resolved from the thread, so removal takes effect at once —
    // and it narrows to unassigned rather than lingering as the old Project.
    expect(after?.projectInstructions).toBeNull();
    expect(after?.ragFileIds).toBeNull();
  });

  test("an ordinary chat's recovery payload is unchanged by any of this", async () => {
    const t = convexTest(schema, modules);
    const { ws, u } = await seed(t);
    const threadId = await u.mutation(api.chat.threads.create, {
      workspaceId: ws,
    });
    const sent = await u.mutation(api.chat.messages.send, {
      threadId,
      content: "hello",
      clientId: "c1",
    });
    await drain(t);
    const p = await payloadOf(t, sent.streamId as string);
    expect(p?.projectInstructions).toBeNull();
    expect(p?.ragFileIds).toBeNull();
    expect(p?.unattended).toBe(false);
  });
});

describe("unattended memory writes are refused in Convex too", () => {
  test("a scheduled turn cannot remember or forget, an interactive one can", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);

    // An interactive turn writes normally.
    const threadId = await u.mutation(api.chat.threads.create, {
      workspaceId: ws,
    });
    const sent = await u.mutation(api.chat.messages.send, {
      threadId,
      content: "remember this",
      clientId: "c1",
    });
    await drain(t);
    const ok = await t.mutation(internal.memories.rememberFromIngress, {
      streamId: sent.streamId as string,
      content: "An interactive fact.",
      kind: "fact",
    });
    expect(ok).toMatchObject({ ok: true });
    expect(await t.run(async (ctx) => ctx.db.query("userMemories").collect()))
      .toHaveLength(1);

    // A scheduled (hidden) thread is refused, even holding a live streamId.
    // The Python runner already withholds the tool; this is the second line.
    const hidden = await t.run(async (ctx) => {
      const now = Date.now();
      return ctx.db.insert("chatThreads", {
        workspaceId: ws,
        userId,
        title: "Nightly",
        titleSource: "user",
        status: "scheduled",
        pinned: false,
        model: "deepseek-v4-flash",
        nextSeq: 0,
        messageCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
    const schedStream = await t.run(async (ctx) => {
      const now = Date.now();
      const messageId = await ctx.db.insert("chatMessages", {
        threadId: hidden,
        workspaceId: ws,
        userId,
        role: "assistant",
        seq: 0,
        content: "",
        status: "streaming",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("chatStreams", {
        streamId: "sched-stream-1",
        threadId: hidden,
        messageId,
        userId,
        workspaceId: ws,
        status: "running",
        cancelRequested: false,
        committedText: "",
        committedSeq: -1,
        chunkSeq: -1,
        heartbeatAt: now,
        startedAt: now,
      });
      return "sched-stream-1";
    });

    const refused = await t.mutation(internal.memories.rememberFromIngress, {
      streamId: schedStream,
      content: "An unattended fact.",
      kind: "fact",
    });
    expect(refused).toMatchObject({ dropped: "unattended" });
    // Nothing new was written.
    expect(await t.run(async (ctx) => ctx.db.query("userMemories").collect()))
      .toHaveLength(1);

    // And it cannot destroy the interactive one either.
    const existing = (await t.run(async (ctx) =>
      ctx.db.query("userMemories").collect(),
    ))[0];
    const forgot = await t.mutation(internal.memories.forgetFromIngress, {
      streamId: schedStream,
      memoryIds: [existing?._id as Id<"userMemories">],
    });
    expect(forgot).toMatchObject({ disabled: 0 });
    expect(
      await t.run(async (ctx) =>
        ctx.db.get(existing?._id as Id<"userMemories">),
      ),
    ).toMatchObject({ status: "active" });
  });
});
