/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;

// Same JWT-subject shape the app uses: getAuthUserId reads the part before `|`.
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

// resolve() schedules redispatch (POST /v1/generate). Stub fetch + drain so the
// scheduled action doesn't touch the network or outlive the test transaction.
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

async function seedStream(
  t: TestT,
  opts: {
    status?: "running" | "queued" | "waiting_approval";
    hasEvents?: boolean;
  } = {},
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "u@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
    // requireThreadAccess re-checks workspace membership as defense-in-depth.
    await ctx.db.insert("members", {
      workspaceId,
      userId,
      role: "owner",
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
      cancelRequested: false,
      chunkSeq: -1,
      committedText: "partial",
      committedSeq: -1,
      heartbeatAt: Date.now(),
      startedAt: Date.now(),
      attempts: 0,
      deadlineAt: Date.now() + 300_000,
      hasEvents: opts.hasEvents ?? false,
    });
    return { streamId, threadId, messageId, userId, workspaceId };
  });
}

async function seedApproval(
  t: TestT,
  s: {
    streamId: string;
    threadId: Id<"chatThreads">;
    messageId: Id<"chatMessages">;
    userId: Id<"users">;
    workspaceId: Id<"workspaces">;
  },
  opts: {
    approvalId?: string;
    status?: "pending" | "approved" | "rejected" | "expired" | "cancelled";
    expiresAt?: number;
  } = {},
) {
  return t.run(async (ctx) => {
    return ctx.db.insert("chatApprovals", {
      approvalId: opts.approvalId ?? "search_web:abc123",
      streamId: s.streamId,
      messageId: s.messageId,
      threadId: s.threadId,
      workspaceId: s.workspaceId,
      userId: s.userId,
      toolId: "search_web",
      toolName: "Search Web",
      argsKey: '{"q":"x"}',
      reason: "External write",
      status: opts.status ?? "pending",
      createdAt: Date.now(),
      expiresAt: opts.expiresAt ?? Date.now() + 900_000,
    });
  });
}

const APPROVAL_EVENT = {
  eventId: "ev_ap1",
  seq: 0,
  type: "APPROVAL_REQUEST" as const,
  v: 1,
  ts: Date.now(),
  payload: JSON.stringify({
    approval_id: "search_web:abc123",
    tool_name: "Search Web",
    reason: "External write",
    status: "pending",
  }),
};

async function loadApprovals(t: TestT, streamId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("chatApprovals")
      .withIndex("by_stream_approval", (q) => q.eq("streamId", streamId))
      .collect(),
  );
}
async function loadStream(t: TestT, streamId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("chatStreams")
      .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
      .unique(),
  );
}

describe("Phase 8 approval — park & suspend", () => {
  test("requestApproval parks the approval and suspends the stream", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "running" });
    const r = await t.mutation(internal.chat.approvals.requestApproval, {
      streamId: s.streamId,
      approvalId: "search_web:abc123",
      toolId: "search_web",
      toolName: "Search Web",
      argsKey: '{"q":"x"}',
      reason: "External write",
      ttlMs: 900_000,
      event: APPROVAL_EVENT,
    });
    expect(r).toMatchObject({ decision: "pending" });
    const stream = await loadStream(t, s.streamId);
    expect(stream?.status).toBe("waiting_approval");
    const rows = await loadApprovals(t, s.streamId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    // The APPROVAL_REQUEST event was inserted so the chip/dialog renders.
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("chatStreamEvents")
        .withIndex("by_message_seq", (q) => q.eq("messageId", s.messageId))
        .collect(),
    );
    expect(events).toHaveLength(1);
    // The stall reaper leaves a parked (waiting_approval) stream alone.
    const reap = await t.mutation(internal.chat.stream.reapStalled, {});
    expect(reap).toMatchObject({ resumed: 0, failed: 0 });
  });

  test("a duplicate request (same approvalId) upserts one row", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "running" });
    const args = {
      streamId: s.streamId,
      approvalId: "search_web:abc123",
      toolId: "search_web",
      toolName: "Search Web",
      argsKey: '{"q":"x"}',
      reason: "External write",
      ttlMs: 900_000,
      event: APPROVAL_EVENT,
    };
    await t.mutation(internal.chat.approvals.requestApproval, args);
    await t.mutation(internal.chat.approvals.requestApproval, args);
    const rows = await loadApprovals(t, s.streamId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  test("a late finalize does NOT destroy a parked approval", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "waiting_approval", hasEvents: true });
    await seedApproval(t, s);
    // A crashed/duplicate run's finalize must be dropped.
    const fin = await t.mutation(internal.chat.ingest.finishStream, {
      streamId: s.streamId,
      text: "late",
    });
    expect(fin).toMatchObject({ suspended: true });
    const fail = await t.mutation(internal.chat.ingest.failStream, {
      streamId: s.streamId,
      error: "late",
    });
    expect(fail).toMatchObject({ suspended: true });
    const stream = await loadStream(t, s.streamId);
    expect(stream?.status).toBe("waiting_approval");
    const rows = await loadApprovals(t, s.streamId);
    expect(rows[0]?.status).toBe("pending");
  });
});

describe("Phase 8 approval — resolve", () => {
  test("approve mints a token, requeues the stream, schedules redispatch", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "waiting_approval", hasEvents: true });
    const apId = await seedApproval(t, s);
    const r = await t
      .withIdentity(as(s.userId))
      .mutation(api.chat.approvals.resolve, {
        approvalId: apId,
        decision: "approve",
      });
    expect(r).toMatchObject({ status: "approved" });
    const rows = await loadApprovals(t, s.streamId);
    expect(rows[0]?.status).toBe("approved");
    expect(rows[0]?.token).toBeTruthy();
    const stream = await loadStream(t, s.streamId);
    expect(stream?.status).toBe("queued");
    expect(stream?.attempts).toBe(0);
    expect(stream?.deadlineAt ?? 0).toBeGreaterThan(Date.now());
    await drain(t);
  });

  test("reject requeues the stream (the model finishes in text)", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "waiting_approval", hasEvents: true });
    const apId = await seedApproval(t, s);
    const r = await t
      .withIdentity(as(s.userId))
      .mutation(api.chat.approvals.resolve, {
        approvalId: apId,
        decision: "reject",
      });
    expect(r).toMatchObject({ status: "rejected" });
    const rows = await loadApprovals(t, s.streamId);
    expect(rows[0]?.status).toBe("rejected");
    expect(rows[0]?.token).toBeFalsy();
    expect((await loadStream(t, s.streamId))?.status).toBe("queued");
    await drain(t);
  });

  test("a non-owner cannot resolve (Not found, no oracle)", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "waiting_approval" });
    const apId = await seedApproval(t, s);
    const outsider = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "x@t.test" }),
    );
    await expect(
      t
        .withIdentity(as(outsider))
        .mutation(api.chat.approvals.resolve, {
          approvalId: apId,
          decision: "approve",
        }),
    ).rejects.toThrow();
    // Untouched.
    expect((await loadApprovals(t, s.streamId))[0]?.status).toBe("pending");
  });

  test("double resolve is idempotent (second returns the prior decision)", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "waiting_approval", hasEvents: true });
    const apId = await seedApproval(t, s);
    const asOwner = t.withIdentity(as(s.userId));
    await asOwner.mutation(api.chat.approvals.resolve, {
      approvalId: apId,
      decision: "approve",
    });
    const second = await asOwner.mutation(api.chat.approvals.resolve, {
      approvalId: apId,
      decision: "reject",
    });
    expect(second).toMatchObject({ status: "approved" }); // not re-opened
    await drain(t);
  });
});

describe("Phase 8 approval — expiry & cancel", () => {
  test("a click after the deadline expires the approval, never approves it", async () => {
    // Audit M-05. The card shows a deadline; resolving after it minted an
    // execute token anyway. Now: expired, no token, the stream is not requeued.
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "waiting_approval", hasEvents: true });
    const apId = await seedApproval(t, s, { expiresAt: Date.now() - 1000 });
    const r = await t
      .withIdentity(as(s.userId))
      .mutation(api.chat.approvals.resolve, { approvalId: apId, decision: "approve" });
    expect(r).toMatchObject({ status: "expired" });
    const rows = await loadApprovals(t, s.streamId);
    expect(rows[0]?.status).toBe("expired");
    expect(rows[0]?.token).toBeUndefined();
    const stream = await loadStream(t, s.streamId);
    expect(stream?.status).toBe("waiting_approval");
  });

  test("reapExpired expires a stale approval and terminates the turn", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "waiting_approval", hasEvents: true });
    await seedApproval(t, s, { expiresAt: Date.now() - 1000 });
    const r = await t.mutation(internal.chat.approvals.reapExpired, {});
    expect(r).toMatchObject({ expired: 1 });
    expect((await loadApprovals(t, s.streamId))[0]?.status).toBe("expired");
    const stream = await loadStream(t, s.streamId);
    expect(stream?.status).toBe("error");
    const msg = await t.run(async (ctx) => ctx.db.get(s.messageId));
    expect(msg?.errorCode).toBe("approval_expired");
  });

  test("stopping a parked turn cancels the approval; tool never runs", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "waiting_approval", hasEvents: true });
    await seedApproval(t, s);
    await t
      .withIdentity(as(s.userId))
      .mutation(api.chat.stream.stop, { messageId: s.messageId });
    expect((await loadStream(t, s.streamId))?.status).toBe("aborted");
    expect((await loadApprovals(t, s.streamId))[0]?.status).toBe("cancelled");
  });
});

describe("Phase 8 approval — read model", () => {
  test("active surfaces the pending approval (survives refresh)", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "waiting_approval", hasEvents: true });
    await seedApproval(t, s);
    const active = await t
      .withIdentity(as(s.userId))
      .query(api.chat.stream.active, { threadId: s.threadId });
    expect(active?.status).toBe("waiting_approval");
    expect(active?.pendingApproval?.approvalId).toBe("search_web:abc123");
  });

  test("dispatchPayload threads the resolved decision to Python", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "queued", hasEvents: true });
    await seedApproval(t, s, { status: "approved" });
    // Give the approved row a token so it is a genuine execute capability.
    const rows = await loadApprovals(t, s.streamId);
    await t.run(async (ctx) => ctx.db.patch(rows[0]._id, { token: "tok_1" }));
    const payload = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: s.streamId,
    });
    expect(payload?.approvals).toHaveLength(1);
    expect(payload?.approvals[0]).toMatchObject({
      toolId: "search_web",
      decision: "approved",
      token: "tok_1",
    });
  });
});

describe("Phase 8 approval — several gated calls in one step (all-or-pause)", () => {
  test("active returns EVERY pending approval of the live message, never another turn's", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "waiting_approval", hasEvents: true });
    // A stale pending row left by an EARLIER turn of the same thread.
    await t.run(async (ctx) => {
      const olderMessage = await ctx.db.insert("chatMessages", {
        threadId: s.threadId,
        userId: s.userId,
        workspaceId: s.workspaceId,
        role: "assistant",
        content: "old",
        seq: 1,
        status: "complete",
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
      });
      await ctx.db.insert("chatApprovals", {
        approvalId: "search_web:stale",
        streamId: "stream_older",
        messageId: olderMessage,
        threadId: s.threadId,
        workspaceId: s.workspaceId,
        userId: s.userId,
        toolId: "search_web",
        toolName: "Search Web",
        argsKey: "{}",
        reason: "old",
        status: "pending",
        createdAt: Date.now() - 60_000,
        expiresAt: Date.now() + 900_000,
      });
    });
    await seedApproval(t, s, { approvalId: "search_web:first" });
    await seedApproval(t, s, { approvalId: "search_web:second" });

    const live = await t
      .withIdentity(as(s.userId))
      .query(api.chat.stream.active, { threadId: s.threadId });
    expect(live?.pendingApprovals.map((a) => a.approvalId).sort()).toEqual([
      "search_web:first",
      "search_web:second",
    ]);
    expect(live?.pendingApproval?.approvalId).not.toBe("search_web:stale");
  });

  test("deciding the first of two keeps the turn parked; the last decision resumes it", async () => {
    const t = convexTest(schema, modules);
    let dispatches = 0;
    globalThis.fetch = (async () => {
      dispatches += 1;
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }) as typeof fetch;
    const s = await seedStream(t, { status: "waiting_approval", hasEvents: true });
    const first = await seedApproval(t, s, { approvalId: "search_web:first" });
    const second = await seedApproval(t, s, { approvalId: "search_web:second" });
    const user = t.withIdentity(as(s.userId));

    await user.mutation(api.chat.approvals.resolve, { approvalId: first, decision: "reject" });
    await drain(t);
    expect((await loadStream(t, s.streamId))?.status).toBe("waiting_approval");
    expect(dispatches).toBe(0);
    // The remaining card is still answerable.
    const live = await user.query(api.chat.stream.active, { threadId: s.threadId });
    expect(live?.pendingApprovals.map((a) => a.approvalId)).toEqual(["search_web:second"]);

    await user.mutation(api.chat.approvals.resolve, { approvalId: second, decision: "approve" });
    expect((await loadStream(t, s.streamId))?.status).toBe("queued");
    await drain(t);
    expect(dispatches).toBe(1);
  });

  test("a re-emitted pending approval re-suspends a stream that was requeued", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "queued", hasEvents: true });
    await seedApproval(t, s, { approvalId: "search_web:abc123" });
    const r = await t.mutation(internal.chat.approvals.requestApproval, {
      streamId: s.streamId,
      approvalId: "search_web:abc123",
      toolId: "search_web",
      toolName: "Search Web",
      argsKey: '{"q":"x"}',
      reason: "External write",
      ttlMs: 900_000,
      event: APPROVAL_EVENT,
    });
    expect(r).toMatchObject({ decision: "pending" });
    expect((await loadStream(t, s.streamId))?.status).toBe("waiting_approval");
    expect(await loadApprovals(t, s.streamId)).toHaveLength(1);
  });
});
