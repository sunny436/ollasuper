/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Phase 7 — the SEO-mutation SAFETY matrix, proven against the REAL machinery:
 * the durable approval round-trip (chat/approvals.ts), the write-ahead ledger
 * (chat/executions.ts — the `persisted:false` gate that aborts a side-effecting
 * call while parked), and the seoMutations result ledger + owner-scoped reads +
 * cascades. Exit bar: 100% zero unauthorized writes.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

// resolve() schedules a redispatch POST; stub fetch so it never touches the network.
const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "test-service-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ accepted: true }), { status: 202 })) as typeof fetch;
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
  opts: { status?: "running" | "queued" | "waiting_approval"; email?: string } = {},
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: opts.email ?? "u@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
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
      committedText: "",
      committedSeq: -1,
      heartbeatAt: Date.now(),
      startedAt: Date.now(),
      attempts: 0,
      deadlineAt: Date.now() + 300_000,
      hasEvents: false,
    });
    return { streamId, threadId, messageId, userId, workspaceId };
  });
}

const RESULT = {
  toolId: "seo_update_metadata",
  action: "update_metadata" as const,
  target: "https://example.com/",
  provider: "seo_write",
  argsHash: "abc123",
  reversibility: "reversible" as const,
  estimatedCost: JSON.stringify({ unit: "requests", writes: 1 }),
  status: "succeeded" as const,
  before: JSON.stringify({ title: "Old" }),
  after: JSON.stringify({ title: "New" }),
  verification: JSON.stringify({ method: "re-read", passed: true, detail: "title matches" }),
  rollbackStatus: "not_needed" as const,
};

async function loadMutations(t: TestT, approvalId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("seoMutations")
      .withIndex("by_approval", (q) => q.eq("approvalId", approvalId))
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

// A side-effecting execution intent — mirrors what the executor write-aheads before a write.
function execArgs(streamId: string, executionId: string, state: string) {
  return {
    streamId,
    executionId,
    stepId: "s1",
    toolCallId: "call_1",
    toolId: "seo_update_metadata",
    attemptId: "a1",
    attempt: 0,
    actionType: "tool",
    sideEffect: "external_side_effect",
    state: state as "running",
    inputHash: "abc123",
    createdAt: Date.now(),
  };
}

describe("Phase 7 — recordResult ledger", () => {
  test("records the auditable result; owner derived from the stream; audits", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t);
    const r = await t.mutation(internal.seoMutations.recordResult, {
      streamId: s.streamId,
      approvalId: "seo_update_metadata:HASHA",
      executionId: "exec_1",
      ...RESULT,
    });
    expect(r).toMatchObject({ ok: true });
    const rows = await loadMutations(t, "seo_update_metadata:HASHA");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: s.userId, // DERIVED from the stream, not client-sent
      workspaceId: s.workspaceId,
      threadId: s.threadId,
      status: "succeeded",
      rollbackStatus: "not_needed",
      before: JSON.stringify({ title: "Old" }),
      after: JSON.stringify({ title: "New" }),
    });
    // A workspace-level audit trail row was written.
    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("auditLogs")
        .filter((q) => q.eq(q.field("action"), "seo.mutation_recorded"))
        .collect(),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId).toBe(s.userId);
  });

  test("idempotent by approvalId — a resume re-emit updates ONE row", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t);
    const base = {
      streamId: s.streamId,
      approvalId: "seo_update_metadata:HASHA",
      executionId: "exec_1",
      ...RESULT,
    };
    await t.mutation(internal.seoMutations.recordResult, base);
    await t.mutation(internal.seoMutations.recordResult, {
      ...base,
      status: "rolled_back" as const,
      rollbackStatus: "succeeded" as const,
    });
    const rows = await loadMutations(t, "seo_update_metadata:HASHA");
    expect(rows).toHaveLength(1); // never a duplicate
    expect(rows[0]?.status).toBe("rolled_back");
    expect(rows[0]?.rollbackStatus).toBe("succeeded");
  });

  test("an unknown stream is rejected — no orphan ledger row", async () => {
    const t = convexTest(schema, modules);
    const r = await t.mutation(internal.seoMutations.recordResult, {
      streamId: "stream_missing",
      approvalId: "seo_update_metadata:HASHA",
      ...RESULT,
    });
    expect(r).toMatchObject({ ok: false, unknown: true });
    expect(await loadMutations(t, "seo_update_metadata:HASHA")).toHaveLength(0);
  });

  test("records a rollback FAILURE outcome faithfully", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t);
    await t.mutation(internal.seoMutations.recordResult, {
      streamId: s.streamId,
      approvalId: "seo_update_content:HASHZ",
      ...RESULT,
      action: "update_content" as const,
      status: "rollback_failed" as const,
      rollbackStatus: "failed" as const,
      verification: JSON.stringify({ method: "re-read", passed: false, detail: "drift" }),
    });
    const rows = await loadMutations(t, "seo_update_content:HASHZ");
    expect(rows[0]).toMatchObject({ status: "rollback_failed", rollbackStatus: "failed" });
  });
});

describe("Phase 7 — 100% zero unauthorized writes (write-ahead gate)", () => {
  test("NO approval: a side-effecting write cannot record intent while parked", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "running" });
    // Park a real approval (stream → waiting_approval), exactly as the executor does.
    await t.mutation(internal.chat.approvals.requestApproval, {
      streamId: s.streamId,
      approvalId: "seo_update_metadata:HASHA",
      toolId: "seo_update_metadata",
      toolName: "Update metadata",
      argsKey: "abc123",
      reason: "Update <title> on example.com/",
      ttlMs: 900_000,
      event: {
        eventId: "ev1",
        seq: 0,
        type: "APPROVAL_REQUEST" as const,
        v: 1,
        ts: Date.now(),
        payload: JSON.stringify({
          approval_id: "seo_update_metadata:HASHA",
          tool_name: "Update metadata",
          reason: "Update <title>",
          status: "pending",
        }),
      },
    });
    expect((await loadStream(t, s.streamId))?.status).toBe("waiting_approval");
    // The executor's write-ahead: a side-effecting intent against a parked stream is
    // REFUSED (persisted:false) → the dual gate aborts the provider write. No write runs.
    const gate = await t.mutation(internal.chat.executions.upsertExecution, {
      ...execArgs(s.streamId, "exec_1", "running"),
      approvalRef: "seo_update_metadata:HASHA",
    });
    expect(gate).toMatchObject({ persisted: false });
  });

  test("APPROVED: the same write records intent only after the owner approves", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "running" });
    await t.mutation(internal.chat.approvals.requestApproval, {
      streamId: s.streamId,
      approvalId: "seo_update_metadata:HASHA",
      toolId: "seo_update_metadata",
      toolName: "Update metadata",
      argsKey: "abc123",
      reason: "Update <title>",
      ttlMs: 900_000,
      event: {
        eventId: "ev1",
        seq: 0,
        type: "APPROVAL_REQUEST" as const,
        v: 1,
        ts: Date.now(),
        payload: JSON.stringify({ approval_id: "seo_update_metadata:HASHA", tool_name: "x", reason: "x", status: "pending" }),
      },
    });
    const apId = (await loadMutationsApproval(t, s.streamId))._id;
    // Owner approves → token minted, stream → queued (live again).
    const res = await t
      .withIdentity(as(s.userId))
      .mutation(api.chat.approvals.resolve, { approvalId: apId, decision: "approve" });
    expect(res).toMatchObject({ status: "approved" });
    expect((await loadStream(t, s.streamId))?.status).toBe("queued");
    // NOW the write-ahead succeeds (stream live) → the provider write is allowed to run.
    const gate = await t.mutation(internal.chat.executions.upsertExecution, {
      ...execArgs(s.streamId, "exec_1", "running"),
      approvalRef: "seo_update_metadata:HASHA",
    });
    expect(gate).toMatchObject({ persisted: true });
    await drain(t);
  });

  test("EXPIRED approval terminates the turn; the write can never record intent", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "waiting_approval" });
    await t.run(async (ctx) =>
      ctx.db.insert("chatApprovals", {
        approvalId: "seo_update_metadata:HASHA",
        streamId: s.streamId,
        messageId: s.messageId,
        threadId: s.threadId,
        workspaceId: s.workspaceId,
        userId: s.userId,
        toolId: "seo_update_metadata",
        toolName: "Update metadata",
        argsKey: "abc123",
        reason: "x",
        status: "pending",
        createdAt: Date.now(),
        expiresAt: Date.now() - 1000,
      }),
    );
    const r = await t.mutation(internal.chat.approvals.reapExpired, {});
    expect(r).toMatchObject({ expired: 1 });
    expect((await loadStream(t, s.streamId))?.status).toBe("error");
    // A terminal stream refuses the side-effecting intent (persisted:false).
    const gate = await t.mutation(internal.chat.executions.upsertExecution, {
      ...execArgs(s.streamId, "exec_1", "running"),
    });
    expect(gate).toMatchObject({ persisted: false });
  });

  test("DUPLICATE execute (same executionId) is deduped — one write, not two", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "running" });
    const first = await t.mutation(internal.chat.executions.upsertExecution, {
      ...execArgs(s.streamId, "exec_dup", "running"),
    });
    expect(first).toMatchObject({ persisted: true });
    // A re-emit of the SAME (streamId, executionId) upserts the same row (idempotent).
    await t.mutation(internal.chat.executions.upsertExecution, {
      ...execArgs(s.streamId, "exec_dup", "succeeded"),
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("toolExecutions")
        .withIndex("by_stream_execution", (q) =>
          q.eq("streamId", s.streamId).eq("executionId", "exec_dup"),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1); // never two — the write is at-most-once
  });
});

async function loadMutationsApproval(t: TestT, streamId: string) {
  const row = await t.run(async (ctx) =>
    ctx.db
      .query("chatApprovals")
      .withIndex("by_stream_approval", (q) => q.eq("streamId", streamId))
      .first(),
  );
  if (!row) throw new Error("no approval");
  return row;
}

describe("Phase 7 — changed args/target rejected (token does not transfer)", () => {
  test("a token minted for one approvalId is not threaded to a different (changed) one", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "queued" });
    // Approved WITH a token for the ORIGINAL args-hash.
    await t.run(async (ctx) =>
      ctx.db.insert("chatApprovals", {
        approvalId: "seo_update_metadata:HASHA",
        streamId: s.streamId,
        messageId: s.messageId,
        threadId: s.threadId,
        workspaceId: s.workspaceId,
        userId: s.userId,
        toolId: "seo_update_metadata",
        toolName: "Update metadata",
        argsKey: "abc123",
        reason: "x",
        status: "approved",
        token: "tok_A",
        createdAt: Date.now(),
        expiresAt: Date.now() + 900_000,
      }),
    );
    const payload = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: s.streamId,
    });
    // The resume only carries the decision for the ORIGINAL approvalId. A write with
    // changed args/target has a DIFFERENT approvalId (tool_id+args-hash) → no token here.
    expect(payload?.approvals).toHaveLength(1);
    expect(payload?.approvals[0]).toMatchObject({
      approvalId: "seo_update_metadata:HASHA",
      token: "tok_A",
    });
    const forChanged = payload?.approvals.find(
      (a: { approvalId: string }) => a.approvalId === "seo_update_metadata:HASHB",
    );
    expect(forChanged).toBeUndefined();
  });
});

describe("Phase 7 — reads are user-trust owner-scoped", () => {
  test("listMyMutations returns only the caller's rows; getMutation blocks non-owners", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { email: "owner@t.test" });
    await t.mutation(internal.seoMutations.recordResult, {
      streamId: s.streamId,
      approvalId: "seo_update_metadata:HASHA",
      ...RESULT,
    });
    const mine = await t
      .withIdentity(as(s.userId))
      .query(api.seoMutations.listMyMutations, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ action: "update_metadata", status: "succeeded" });

    const rowId = (await loadMutations(t, "seo_update_metadata:HASHA"))[0]._id;
    // Owner can read the detail.
    const got = await t
      .withIdentity(as(s.userId))
      .query(api.seoMutations.getMutation, { mutationId: rowId });
    expect(got).toMatchObject({ target: "https://example.com/" });

    // A cross-tenant outsider gets "Not found" (no existence oracle, no before/after leak).
    const outsider = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "outsider@t.test" }),
    );
    await expect(
      t
        .withIdentity(as(outsider))
        .query(api.seoMutations.getMutation, { mutationId: rowId }),
    ).rejects.toThrow();
    const theirs = await t
      .withIdentity(as(outsider))
      .query(api.seoMutations.listMyMutations, {});
    expect(theirs).toHaveLength(0);
  });
});

describe("Phase 7 — cascade on account/thread deletion", () => {
  test("deleting the user purges their mutation ledger", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t);
    await t.mutation(internal.seoMutations.recordResult, {
      streamId: s.streamId,
      approvalId: "seo_update_metadata:HASHA",
      ...RESULT,
    });
    expect(await loadMutations(t, "seo_update_metadata:HASHA")).toHaveLength(1);
    await t.mutation(internal.users.deleteUserAccount, { userId: s.userId });
    await drain(t);
    expect(await loadMutations(t, "seo_update_metadata:HASHA")).toHaveLength(0);
  });

  test("purging the thread purges its mutation rows", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t);
    await t.mutation(internal.seoMutations.recordResult, {
      streamId: s.streamId,
      approvalId: "seo_update_metadata:HASHA",
      ...RESULT,
    });
    // purge only runs on a TRASHED thread (chat/threads.ts:314).
    await t.run(async (ctx) =>
      ctx.db.patch(s.threadId, { status: "trashed", trashedAt: Date.now() }),
    );
    await t.mutation(internal.chat.threads.purge, { threadId: s.threadId });
    await drain(t);
    expect(await loadMutations(t, "seo_update_metadata:HASHA")).toHaveLength(0);
  });
});
