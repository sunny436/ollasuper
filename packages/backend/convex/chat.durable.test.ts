/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

// Bind the app DataModel so `.withIndex` on chatStreams/chatStreamEvents
// type-checks inside helpers (a bare ReturnType<typeof convexTest>
// degrades to system-only tables).
type TestT = TestConvex<typeof schema>;

// The reaper's resume branch schedules `redispatch`, which POSTs /v1/generate.
// Point AI_BASE_URL at a stub and intercept fetch so the scheduled action does
// not touch the network and does not outlive the test transaction (which would
// surface as an unhandled "Write outside of transaction"). Mirrors
// chat.security.test.ts.
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

// finishInProgressScheduledFunctions() only awaits functions that have already
// STARTED; a runAfter(0, ...) is queued on a macrotask, so yield the event loop
// first. Mirrors chat.security.test.ts.
async function drain(t: TestT) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function seedStream(
  t: TestT,
  opts: {
    status?: "running" | "queued";
    heartbeatAt?: number;
    attempts?: number;
    deadlineAt?: number;
    cancelRequested?: boolean;
  } = {},
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "u@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
    const threadId = await ctx.db.insert("chatThreads", {
      userId,
      workspaceId,
      title: "t",
      titleSource: "user",
      status: "active",
      pinned: false,
      model: "m",
      nextSeq: 3,
      messageCount: 2,
      tokensIn: 0,
      tokensOut: 0,
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const messageId = await ctx.db.insert("chatMessages", {
      threadId,
      userId,
      workspaceId,
      role: "assistant",
      content: "",
      seq: 2,
      status: "streaming",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.patch(threadId, { streamingMessageId: messageId });
    const streamId = `stream_${Math.random()}`;
    await ctx.db.insert("chatStreams", {
      streamId,
      messageId,
      threadId,
      workspaceId,
      userId,
      status: opts.status ?? "running",
      cancelRequested: opts.cancelRequested ?? false,
      chunkSeq: -1,
      committedText: "partial text",
      committedSeq: -1,
      heartbeatAt: opts.heartbeatAt ?? Date.now() - 10 * 60 * 1000,
      startedAt: Date.now(),
      attempts: opts.attempts ?? 0,
      deadlineAt: opts.deadlineAt ?? Date.now() + 300_000,
    });
    return { streamId, threadId, messageId, userId };
  });
}

async function seedEvent(
  t: TestT,
  messageId: Id<"chatMessages">,
  streamId: string,
  seq: number,
  type: string,
  body: Record<string, unknown>,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("chatStreamEvents", {
      messageId,
      streamId,
      eventId: `e${seq}`,
      seq,
      type: type as "TOOL_CALL",
      v: 1,
      ts: Date.now(),
      payload: JSON.stringify(body),
    });
    // Mirror the running-with-events invariant.
    const s = await ctx.db
      .query("chatStreams")
      .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
      .unique();
    if (s) await ctx.db.patch(s._id, { hasEvents: true });
  });
}

async function loadStream(t: TestT, streamId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("chatStreams")
      .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
      .unique(),
  );
}

describe("Phase 7 reaper resume", () => {
  test("a stalled turn (attempts < MAX) is RESUMED, not failed", async () => {
    const t = convexTest(schema, modules);
    const { streamId, threadId, messageId } = await seedStream(t, {
      attempts: 0,
    });
    await seedEvent(t, messageId, streamId, 0, "TOOL_CALL", {
      tool_name: "Search",
      tool_id: "search_web",
      call_id: "c1",
      arguments: { q: "x" },
    });

    const r = await t.mutation(internal.chat.stream.reapStalled, {});
    expect(r).toMatchObject({ resumed: 1 });

    const s = await loadStream(t, streamId);
    expect(s?.status).toBe("running"); // NOT error — resumed
    expect(s?.attempts).toBe(1); // bumped
    expect(s?.committedText).toBe(""); // text reset (regenerates)
    expect(s?.heartbeatAt).toBeGreaterThan(Date.now() - 5000); // fresh window

    // Events PRESERVED (the checkpoint); the thread stays subscribed.
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("chatStreamEvents")
        .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
        .collect(),
    );
    expect(events).toHaveLength(1);
    const thread = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(thread?.streamingMessageId).toBe(messageId);

    // Let the scheduled redispatch run to completion inside the test.
    await drain(t);
  });

  test("attempts at the ceiling → terminal fail (timeout)", async () => {
    const t = convexTest(schema, modules);
    const { streamId, messageId } = await seedStream(t, { attempts: 3 });
    const r = await t.mutation(internal.chat.stream.reapStalled, {});
    expect(r).toMatchObject({ failed: 1 });
    const s = await loadStream(t, streamId);
    expect(s?.status).toBe("error");
    const msg = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("error");
  });

  test("past the total deadline → terminal fail (deadline), no resume", async () => {
    const t = convexTest(schema, modules);
    const { streamId, messageId } = await seedStream(t, {
      attempts: 0,
      deadlineAt: Date.now() - 1000, // already expired
    });
    const r = await t.mutation(internal.chat.stream.reapStalled, {});
    expect(r).toMatchObject({ failed: 1 });
    const s = await loadStream(t, streamId);
    expect(s?.status).toBe("error");
    // errorCode lives on the message (failStream), not the stream row.
    const msg = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(msg?.errorCode).toBe("deadline");
  });

  test("a cancelled stalled stream is failed, never resumed", async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seedStream(t, {
      attempts: 0,
      cancelRequested: true,
    });
    const r = await t.mutation(internal.chat.stream.reapStalled, {});
    expect(r).toMatchObject({ failed: 1 });
    const s = await loadStream(t, streamId);
    expect(s?.status).toBe("error");
  });
});

describe("Phase 7 resume payload", () => {
  test("dispatchPayload reconstructs completedTools + eventSeqBaseline", async () => {
    const t = convexTest(schema, modules);
    const { streamId, messageId } = await seedStream(t, { attempts: 1 });
    await seedEvent(t, messageId, streamId, 0, "TOOL_CALL", {
      tool_name: "Search",
      tool_id: "search_web",
      call_id: "c1",
      arguments: { q: "cats" },
    });
    await seedEvent(t, messageId, streamId, 1, "TOOL_RESULT", {
      call_id: "c1",
      status: "success",
      content: "the retrieved block",
    });

    const payload = await t.query(internal.chat.stream.dispatchPayload, {
      streamId,
    });
    expect(payload?.attempt).toBe(1);
    expect(payload?.eventSeqBaseline).toBe(2); // maxSeq(1) + 1
    expect(payload?.completedTools).toHaveLength(1);
    expect(payload?.completedTools[0]).toMatchObject({
      toolId: "search_web",
      args: { q: "cats" },
      resultContent: "the retrieved block",
    });
  });

  test("no resume block on a first attempt", async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seedStream(t, { attempts: 0 });
    const payload = await t.query(internal.chat.stream.dispatchPayload, {
      streamId,
    });
    expect(payload?.attempt).toBe(0);
    expect(payload?.completedTools).toHaveLength(0);
  });
});
