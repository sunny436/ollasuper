/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

// Owner identity — mirrors chat.security.test.ts (getAuthUserId reads the part
// before `|`).
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

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
    // Owner membership — requireThreadAccess (via stop) re-checks it.
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
    expect(payload?.attemptedTools).toHaveLength(0);
  });
});

describe("Phase 2 resume classification (state-driven + fail-safe)", () => {
  test("SUCCEEDED -> completed; INDETERMINATE -> attempted", async () => {
    const t = convexTest(schema, modules);
    const { streamId, messageId } = await seedStream(t, { attempts: 1 });
    // A succeeded op.
    await seedEvent(t, messageId, streamId, 0, "TOOL_CALL", {
      tool_id: "search_web",
      call_id: "c1",
      arguments: { q: "ok" },
      side_effect: "external_side_effect",
    });
    await seedEvent(t, messageId, streamId, 1, "TOOL_RESULT", {
      call_id: "c1",
      status: "success",
      state: "succeeded",
      content: "done",
    });
    // An indeterminate op (a side-effecting timeout recorded its state).
    await seedEvent(t, messageId, streamId, 2, "TOOL_CALL", {
      tool_id: "send_email",
      call_id: "c2",
      arguments: { to: "a" },
      side_effect: "external_side_effect",
    });
    await seedEvent(t, messageId, streamId, 3, "TOOL_RESULT", {
      call_id: "c2",
      status: "error",
      state: "indeterminate",
    });

    const p = await t.query(internal.chat.stream.dispatchPayload, { streamId });
    expect(p?.completedTools).toMatchObject([{ toolId: "search_web" }]);
    expect(p?.attemptedTools).toMatchObject([{ toolId: "send_email" }]);
  });

  test("crash orphan: side-effecting -> attempted, read-only -> dropped", async () => {
    const t = convexTest(schema, modules);
    const { streamId, messageId } = await seedStream(t, { attempts: 1 });
    // Side-effecting TOOL_CALL with NO TOOL_RESULT (crashed mid-flight).
    await seedEvent(t, messageId, streamId, 0, "TOOL_CALL", {
      tool_id: "send_email",
      call_id: "c1",
      arguments: { to: "a" },
      side_effect: "external_side_effect",
    });
    // Read-only orphan -> safe to re-run -> dropped from both lists.
    await seedEvent(t, messageId, streamId, 1, "TOOL_CALL", {
      tool_id: "search_web",
      call_id: "c2",
      arguments: { q: "x" },
      side_effect: "read_only",
    });

    const p = await t.query(internal.chat.stream.dispatchPayload, { streamId });
    expect(p?.completedTools).toHaveLength(0);
    expect(p?.attemptedTools).toMatchObject([{ toolId: "send_email" }]);
  });

  test("un-stamped orphan (built-in) fails safe -> attempted", async () => {
    const t = convexTest(schema, modules);
    const { streamId, messageId } = await seedStream(t, { attempts: 1 });
    // A TOOL_CALL with NO side_effect stamp (e.g. an old/legacy emit): a missing
    // classification must fail safe (treated side-effecting -> never re-run).
    await seedEvent(t, messageId, streamId, 0, "TOOL_CALL", {
      tool_id: "remember",
      call_id: "c1",
      arguments: {},
    });
    const p = await t.query(internal.chat.stream.dispatchPayload, { streamId });
    expect(p?.attemptedTools).toMatchObject([{ toolId: "remember" }]);
  });

  test("FAILED result is dropped (definite non-execution), never re-run-blocked", async () => {
    const t = convexTest(schema, modules);
    const { streamId, messageId } = await seedStream(t, { attempts: 1 });
    await seedEvent(t, messageId, streamId, 0, "TOOL_CALL", {
      tool_id: "search_web",
      call_id: "c1",
      arguments: { q: "x" },
      side_effect: "read_only",
    });
    await seedEvent(t, messageId, streamId, 1, "TOOL_RESULT", {
      call_id: "c1",
      status: "error",
      state: "failed",
    });
    const p = await t.query(internal.chat.stream.dispatchPayload, { streamId });
    expect(p?.completedTools).toHaveLength(0);
    expect(p?.attemptedTools).toHaveLength(0);
  });
});

describe("Phase 3 durable toolExecutions", () => {
  // Seed via the REAL upsert mutation (derives owner ids from the stream).
  async function seedExec(
    t: TestT,
    streamId: string,
    o: {
      executionId: string;
      toolId: string;
      inputHash: string;
      state:
        | "running"
        | "waiting_approval"
        | "succeeded"
        | "indeterminate"
        | "failed";
      args?: unknown;
      resultContent?: string;
      approvalRef?: string;
      sideEffect?: string;
    },
  ) {
    return t.mutation(internal.chat.executions.upsertExecution, {
      streamId,
      executionId: o.executionId,
      stepId: "s1",
      toolCallId: "tc",
      toolId: o.toolId,
      attemptId: "a1",
      attempt: 1,
      actionType: "tool",
      sideEffect: o.sideEffect ?? "external_side_effect",
      state: o.state,
      inputHash: o.inputHash,
      args: o.args,
      resultContent: o.resultContent,
      approvalRef: o.approvalRef,
      createdAt: Date.now(),
    });
  }

  test("upsert: insert → persisted; same-state → no-op; illegal → keep", async () => {
    const t = convexTest(schema, modules);
    const { streamId, messageId } = await seedStream(t, { attempts: 1 });
    const r1 = await seedExec(t, streamId, {
      executionId: "e1",
      toolId: "send_email",
      inputHash: "h1",
      state: "running",
    });
    expect(r1).toMatchObject({ persisted: true });
    // same state → idempotent no-op, still 1 row
    const r2 = await seedExec(t, streamId, {
      executionId: "e1",
      toolId: "send_email",
      inputHash: "h1",
      state: "running",
    });
    expect(r2).toMatchObject({ persisted: true });
    // legal forward
    await seedExec(t, streamId, {
      executionId: "e1",
      toolId: "send_email",
      inputHash: "h1",
      state: "succeeded",
      resultContent: "ok",
    });
    // illegal (terminal → running) is kept + logged, row stays succeeded
    await seedExec(t, streamId, {
      executionId: "e1",
      toolId: "send_email",
      inputHash: "h1",
      state: "running",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("toolExecutions")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("succeeded");
  });

  test("write-ahead abort: a terminal stream does NOT persist", async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seedStream(t, { status: "running" });
    await t.run(async (ctx) => {
      const s = await ctx.db
        .query("chatStreams")
        .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
        .unique();
      if (s) await ctx.db.patch(s._id, { status: "done" });
    });
    const r = await seedExec(t, streamId, {
      executionId: "e1",
      toolId: "x",
      inputHash: "h1",
      state: "running",
    });
    expect(r).toMatchObject({ persisted: false });
  });

  test("dispatchPayload classifies from the table (succeeded/indeterminate)", async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seedStream(t, { attempts: 1 });
    await seedExec(t, streamId, {
      executionId: "e1",
      toolId: "search",
      inputHash: "h1",
      state: "succeeded",
      args: { q: "x" },
      resultContent: "R",
    });
    await seedExec(t, streamId, {
      executionId: "e2",
      toolId: "send_email",
      inputHash: "h2",
      state: "indeterminate",
      args: { to: "a" },
    });
    const p = await t.query(internal.chat.stream.dispatchPayload, { streamId });
    expect(p?.completedTools).toMatchObject([
      { toolId: "search", resultContent: "R" },
    ]);
    expect(p?.attemptedTools).toMatchObject([{ toolId: "send_email" }]);
    expect(p?.approvedPending).toHaveLength(0);
  });

  test("approved parked tool → approvedPending with durable args + token", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedStream(t, { attempts: 1 });
    await seedExec(t, seeded.streamId, {
      executionId: "e1",
      toolId: "send_email",
      inputHash: "h1",
      state: "waiting_approval",
      args: { to: "a@b.c" },
      approvalRef: "ap1",
    });
    // A resolved-approved approval row (the token is the execute capability).
    await t.run(async (ctx) => {
      await ctx.db.insert("chatApprovals", {
        approvalId: "ap1",
        streamId: seeded.streamId,
        messageId: seeded.messageId,
        threadId: seeded.threadId,
        workspaceId: (await ctx.db.get(seeded.messageId))!.workspaceId,
        userId: seeded.userId,
        toolId: "send_email",
        toolName: "Send Email",
        argsKey: "h1",
        reason: "",
        status: "approved",
        token: "tok_1",
        createdAt: Date.now(),
        expiresAt: Date.now() + 100000,
      });
    });
    const p = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: seeded.streamId,
    });
    expect(p?.approvedPending).toMatchObject([
      { toolId: "send_email", token: "tok_1", approvalId: "ap1" },
    ]);
  });

  test("double-fire guard: waiting_approval + running sibling → NOT approvedPending", async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seedStream(t, { attempts: 1 });
    // Same (toolId, inputHash): a stale parked row + the continuation's running row.
    await seedExec(t, streamId, {
      executionId: "old",
      toolId: "send_email",
      inputHash: "h1",
      state: "waiting_approval",
      approvalRef: "ap1",
    });
    await seedExec(t, streamId, {
      executionId: "new",
      toolId: "send_email",
      inputHash: "h1",
      state: "running",
    });
    await t.run(async (ctx) => {
      const s = await ctx.db
        .query("chatStreams")
        .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
        .unique();
      // approved approval exists, but the group's furthest state is `running`.
      await ctx.db.insert("chatApprovals", {
        approvalId: "ap1",
        streamId,
        messageId: s!.messageId,
        threadId: s!.threadId,
        workspaceId: s!.workspaceId,
        userId: s!.userId,
        toolId: "send_email",
        toolName: "x",
        argsKey: "h1",
        reason: "",
        status: "approved",
        token: "tok_1",
        createdAt: Date.now(),
        expiresAt: Date.now() + 100000,
      });
    });
    const p = await t.query(internal.chat.stream.dispatchPayload, { streamId });
    expect(p?.approvedPending).toHaveLength(0); // suppressed
    expect(p?.attemptedTools).toMatchObject([{ toolId: "send_email" }]);
  });

  test("table present → events are NOT consulted; lifecycle deleted at finalize", async () => {
    const t = convexTest(schema, modules);
    const { streamId, messageId } = await seedStream(t, { attempts: 1 });
    // An EVENT says succeeded, but the TABLE says the same tool is indeterminate.
    // With the table present, the table wins (event ignored).
    await seedEvent(t, messageId, streamId, 0, "TOOL_CALL", {
      tool_id: "send_email",
      call_id: "c1",
      arguments: { to: "a" },
      side_effect: "external_side_effect",
    });
    await seedEvent(t, messageId, streamId, 1, "TOOL_RESULT", {
      call_id: "c1",
      status: "success",
      state: "succeeded",
      content: "R",
    });
    await seedExec(t, streamId, {
      executionId: "e1",
      toolId: "send_email",
      inputHash: "h1",
      state: "indeterminate",
      args: { to: "a" },
    });
    const p = await t.query(internal.chat.stream.dispatchPayload, { streamId });
    expect(p?.completedTools).toHaveLength(0); // table (indeterminate) wins
    expect(p?.attemptedTools).toMatchObject([{ toolId: "send_email" }]);
    expect(p?.eventSeqBaseline).toBe(2); // still from the event log

    // finalize retires the durable execution rows.
    await t.mutation(internal.chat.ingest.finishStream, {
      streamId,
      text: "done",
    });
    const left = await t.run(async (ctx) =>
      ctx.db
        .query("toolExecutions")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .collect(),
    );
    expect(left).toHaveLength(0);
  });
});

describe("Phase 2 appendEvent persistence reporting (write-ahead)", () => {
  test("a live event write reports persisted:true", async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seedStream(t, { status: "running" });
    const r = await t.mutation(internal.chat.ingest.appendEvent, {
      streamId,
      events: [
        {
          eventId: "e0",
          seq: 0,
          type: "TOOL_CALL" as const,
          v: 1,
          ts: Date.now(),
          payload: JSON.stringify({ tool_id: "x", call_id: "c1" }),
        },
      ],
    });
    expect(r).toMatchObject({ ok: true, persisted: true });
  });

  test("a terminal stream does NOT persist (write-ahead must abort)", async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seedStream(t, { status: "running" });
    await t.run(async (ctx) => {
      const s = await ctx.db
        .query("chatStreams")
        .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
        .unique();
      if (s) await ctx.db.patch(s._id, { status: "done" });
    });
    const r = await t.mutation(internal.chat.ingest.appendEvent, {
      streamId,
      events: [
        {
          eventId: "e0",
          seq: 0,
          type: "TOOL_CALL" as const,
          v: 1,
          ts: Date.now(),
          payload: JSON.stringify({ tool_id: "x", call_id: "c1" }),
        },
      ],
    });
    expect(r).toMatchObject({ persisted: false });
  });
});

describe("Phase 4 approval + cancellation controls", () => {
  async function upsertExec(
    t: TestT,
    streamId: string,
    o: {
      executionId: string;
      toolId: string;
      inputHash: string;
      state: "running" | "waiting_approval" | "succeeded";
      args?: unknown;
      resultContent?: string;
      approvalRef?: string;
      sideEffect?: string;
    },
  ) {
    return t.mutation(internal.chat.executions.upsertExecution, {
      streamId,
      executionId: o.executionId,
      stepId: "s1",
      toolCallId: "tc",
      toolId: o.toolId,
      attemptId: "a1",
      attempt: 1,
      actionType: "tool",
      sideEffect: o.sideEffect ?? "external_side_effect",
      state: o.state,
      inputHash: o.inputHash,
      args: o.args,
      resultContent: o.resultContent,
      approvalRef: o.approvalRef,
      createdAt: Date.now(),
    });
  }

  async function insertApproval(
    t: TestT,
    seeded: {
      streamId: string;
      messageId: Id<"chatMessages">;
      threadId: Id<"chatThreads">;
      userId: Id<"users">;
    },
    o: { approvalId: string; status: string; token?: string; toolId?: string },
  ) {
    await t.run(async (ctx) => {
      const msg = await ctx.db.get(seeded.messageId);
      await ctx.db.insert("chatApprovals", {
        approvalId: o.approvalId,
        streamId: seeded.streamId,
        messageId: seeded.messageId,
        threadId: seeded.threadId,
        workspaceId: msg!.workspaceId,
        userId: seeded.userId,
        toolId: o.toolId ?? "send_email",
        toolName: "Send Email",
        argsKey: "h1",
        reason: "",
        status: o.status as "pending",
        token: o.token,
        createdAt: Date.now(),
        expiresAt: Date.now() + 100_000,
      });
    });
  }

  // A2: single-use by construction. After the approved tool RAN (succeeded), a
  // re-dispatch must NOT re-offer it as approvedPending — the furthest-progressed
  // classification returns it as completed instead. The token is spent by the run.
  test("A2 single-use: after the approved tool succeeded, re-dispatch does not re-offer it", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedStream(t, { attempts: 1 });
    await upsertExec(t, seeded.streamId, {
      executionId: "e1",
      toolId: "send_email",
      inputHash: "h1",
      state: "waiting_approval",
      args: { to: "a@b.c" },
      approvalRef: "ap1",
    });
    // The approved tool then RAN to completion (waiting_approval → running →
    // succeeded), the write-ahead terminal record of a spent token.
    await upsertExec(t, seeded.streamId, {
      executionId: "e1",
      toolId: "send_email",
      inputHash: "h1",
      state: "running",
    });
    await upsertExec(t, seeded.streamId, {
      executionId: "e1",
      toolId: "send_email",
      inputHash: "h1",
      state: "succeeded",
      resultContent: "sent",
    });
    await insertApproval(t, seeded, {
      approvalId: "ap1",
      status: "approved",
      token: "tok_1",
    });

    const p = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: seeded.streamId,
    });
    expect(p?.approvedPending).toHaveLength(0); // NOT re-offered → single-use
    expect(p?.completedTools).toMatchObject([{ toolId: "send_email" }]);
  });

  // C3: a side effect still RUNNING at the stop is marked honestly on the message.
  test("C3 stop marks interruptedSideEffect when a side-effecting tool was running", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedStream(t, { status: "running" });
    await upsertExec(t, seeded.streamId, {
      executionId: "e1",
      toolId: "send_email",
      inputHash: "h1",
      state: "running",
      sideEffect: "external_side_effect",
    });
    await t
      .withIdentity(as(seeded.userId))
      .mutation(api.chat.stream.stop, { messageId: seeded.messageId });

    const msg = await t.run(async (ctx) => ctx.db.get(seeded.messageId));
    expect(msg?.status).toBe("aborted");
    expect(msg?.interruptedSideEffect).toMatchObject({ toolId: "send_email" });
    // The durable execution checkpoint is still retired.
    const left = await t.run(async (ctx) =>
      ctx.db
        .query("toolExecutions")
        .withIndex("by_message", (q) => q.eq("messageId", seeded.messageId))
        .collect(),
    );
    expect(left).toHaveLength(0);
  });

  test("C3 a running READ-ONLY tool is not an interrupted side effect", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedStream(t, { status: "running" });
    await upsertExec(t, seeded.streamId, {
      executionId: "e1",
      toolId: "search_web",
      inputHash: "h1",
      state: "running",
      sideEffect: "read_only",
    });
    await t
      .withIdentity(as(seeded.userId))
      .mutation(api.chat.stream.stop, { messageId: seeded.messageId });
    const msg = await t.run(async (ctx) => ctx.db.get(seeded.messageId));
    expect(msg?.interruptedSideEffect).toBeUndefined();
  });

  // C4: a 409 (old worker still holds the reused messageId) is benign — the
  // stream must NOT be failed; a redispatch is scheduled instead.
  test("C4 dispatch treats a 409 as benign (stream stays queued, not error)", async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seedStream(t, { status: "queued" });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "already generating" }), {
        status: 409,
      })) as typeof fetch;

    await t.action(internal.chat.stream.dispatch, { streamId });
    const s = await loadStream(t, streamId);
    expect(s?.status).toBe("queued"); // NOT error — the retry can still resume
    await drain(t); // let the scheduled redispatch run (409 again → still benign)
    expect((await loadStream(t, streamId))?.status).toBe("queued");
  });

  test("C4 a genuine 500 still fails the stream (409 handling is not a blanket pass)", async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seedStream(t, { status: "queued" });
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;
    await t.action(internal.chat.stream.dispatch, { streamId });
    expect((await loadStream(t, streamId))?.status).toBe("error");
  });

  // A6: a leftover pending approval (e.g. a deferred all-or-pause sibling the
  // model didn't re-emit) is retired at the success terminal, leaving no orphan.
  test("A6 finishStream retires a leftover pending approval", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedStream(t, { status: "running" });
    await insertApproval(t, seeded, { approvalId: "ap1", status: "pending" });

    await t.mutation(internal.chat.ingest.finishStream, {
      streamId: seeded.streamId,
      text: "done",
    });
    const left = await t.run(async (ctx) =>
      ctx.db
        .query("chatApprovals")
        .withIndex("by_stream_approval", (q) =>
          q.eq("streamId", seeded.streamId),
        )
        .collect(),
    );
    expect(left).toHaveLength(0);
  });
});
