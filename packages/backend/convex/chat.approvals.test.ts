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
