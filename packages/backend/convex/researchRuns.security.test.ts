/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

/**
 * Deep Research — the durable research-state SAFETY matrix, proven against the REAL
 * machinery: the idempotent `checkpoint` upsert (owner DERIVED from the stream, never
 * client-sent), the cross-thread-reuse guard, the terminal-stream guard, the
 * owner-scoped resume seed read into dispatchPayload, and the account/thread cascades.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;

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
    status?: "running" | "queued" | "done";
    email?: string;
    threadTitle?: string;
  } = {},
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: opts.email ?? "u@t.test",
    });
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
      title: opts.threadTitle ?? "t",
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

// The payload is what the Python writer sends — the CLEANED (camelCase) shape from
// app/research/tool.py::clean_plan_args / clean_finding_args, not the raw tool args.
const plan = (streamId: string, runId: string) => ({
  streamId,
  researchRunId: runId,
  kind: "plan" as const,
  payloadJson: JSON.stringify({
    objective: "compare CRMs",
    reason: "multi-source comparison needing current pricing",
    subquestions: ["pricing", "reviews"],
    timeSensitive: true,
  }),
});
const finding = (
  streamId: string,
  runId: string,
  url: string,
  subq = "pricing",
) => ({
  streamId,
  researchRunId: runId,
  kind: "finding" as const,
  payloadJson: JSON.stringify({
    subquestion: subq,
    claim: `claim from ${url}`,
    sourceUrl: url,
    sourceTitle: "T",
    sourceType: "official",
    confidence: "high",
    supports: true,
  }),
});

async function loadRun(t: TestT, runId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("researchRuns")
      .withIndex("by_run", (q) => q.eq("researchRunId", runId))
      .collect(),
  );
}

describe("checkpoint — durable, owner-derived, idempotent", () => {
  test("plan then findings accumulate in ONE row; owner derived from the stream; audits", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t);
    expect(
      await t.mutation(internal.researchRuns.checkpoint, plan(s.streamId, "r1")),
    ).toMatchObject({ ok: true, saved: true });
    await t.mutation(
      internal.researchRuns.checkpoint,
      finding(s.streamId, "r1", "https://a.com"),
    );
    await t.mutation(
      internal.researchRuns.checkpoint,
      finding(s.streamId, "r1", "https://b.com", "reviews"),
    );
    const rows = await loadRun(t, "r1");
    expect(rows).toHaveLength(1); // idempotent by researchRunId — never duplicated
    expect(rows[0]).toMatchObject({
      userId: s.userId, // DERIVED from the stream, not client-sent
      workspaceId: s.workspaceId,
      threadId: s.threadId,
      objective: "compare CRMs",
      reason: "multi-source comparison needing current pricing",
      status: "researching",
      timeSensitive: true,
      sourceCount: 2, // two distinct sources
    });
    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("auditLogs")
        .filter((q) => q.eq(q.field("action"), "research.checkpoint"))
        .collect(),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0]?.userId).toBe(s.userId);
  });

  test("distinct-source count is stable when the SAME source is recorded twice", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t);
    await t.mutation(internal.researchRuns.checkpoint, plan(s.streamId, "r1"));
    await t.mutation(
      internal.researchRuns.checkpoint,
      finding(s.streamId, "r1", "https://a.com"),
    );
    await t.mutation(
      internal.researchRuns.checkpoint,
      finding(s.streamId, "r1", "https://a.com"),
    );
    expect((await loadRun(t, "r1"))[0]?.sourceCount).toBe(1);
  });

  test("an unknown stream is rejected — no orphan run row", async () => {
    const t = convexTest(schema, modules);
    const r = await t.mutation(
      internal.researchRuns.checkpoint,
      plan("stream_missing", "r1"),
    );
    expect(r).toMatchObject({ ok: false, unknown: true });
    expect(await loadRun(t, "r1")).toHaveLength(0);
  });

  test("a terminal (done) stream drops the write — no state written outside a live turn", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t, { status: "done" });
    const r = await t.mutation(
      internal.researchRuns.checkpoint,
      plan(s.streamId, "r1"),
    );
    expect(r).toMatchObject({ dropped: "terminal" });
    expect(await loadRun(t, "r1")).toHaveLength(0);
  });

  test("cross-thread runId reuse is REJECTED — a runId is bound to its own thread", async () => {
    const t = convexTest(schema, modules);
    const a = await seedStream(t, { email: "a@t.test" });
    const b = await seedStream(t, { email: "b@t.test" });
    await t.mutation(internal.researchRuns.checkpoint, plan(a.streamId, "shared"));
    // The SAME runId presented on a DIFFERENT thread's stream must be refused.
    const r = await t.mutation(
      internal.researchRuns.checkpoint,
      finding(b.streamId, "shared", "https://x.com"),
    );
    expect(r).toMatchObject({ rejected: "cross_thread" });
    const rows = await loadRun(t, "shared");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.threadId).toBe(a.threadId); // still bound to thread A only
    expect(rows[0]?.sourceCount).toBe(0); // B's finding never landed
  });
});

describe("resume seed — owner-scoped, terminal-excluded", () => {
  test("dispatchPayload carries the thread's incomplete run; completed run does NOT linger", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t);
    await t.mutation(internal.researchRuns.checkpoint, plan(s.streamId, "r1"));
    await t.mutation(
      internal.researchRuns.checkpoint,
      finding(s.streamId, "r1", "https://a.com"),
    );
    let payload = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: s.streamId,
    });
    expect(payload?.activeResearchRun).toMatchObject({
      runId: "r1",
      objective: "compare CRMs",
      status: "researching",
      sourceCount: 1,
    });
    // "pricing" has a finding → completed; "reviews" is still open.
    expect(payload?.activeResearchRun?.completed).toContain("pricing");
    expect(payload?.activeResearchRun?.findings.length).toBe(1);

    // Once complete, the run is terminal and no longer seeds future turns.
    await t.mutation(internal.researchRuns.checkpoint, {
      streamId: s.streamId,
      researchRunId: "r1",
      kind: "complete" as const,
      payloadJson: "{}",
    });
    payload = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: s.streamId,
    });
    expect(payload?.activeResearchRun).toBeNull();
  });

  test("a run owned by another user on the same thread is NOT seeded (owner boundary)", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t);
    // Forge a run row on this thread but owned by a DIFFERENT user.
    const other = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "other@t.test" }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("researchRuns", {
        researchRunId: "foreign",
        userId: other,
        workspaceId: s.workspaceId,
        threadId: s.threadId,
        objective: "secret",
        status: "researching",
        timeSensitive: false,
        sourceCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const payload = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: s.streamId,
    });
    // The foreign run is filtered out by the userId owner boundary.
    expect(payload?.activeResearchRun).toBeNull();
  });
});

describe("cascade on account / thread deletion", () => {
  test("deleting the user purges their research runs", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t);
    await t.mutation(internal.researchRuns.checkpoint, plan(s.streamId, "r1"));
    expect(await loadRun(t, "r1")).toHaveLength(1);
    await t.mutation(internal.users.deleteUserAccount, { userId: s.userId });
    await drain(t);
    expect(await loadRun(t, "r1")).toHaveLength(0);
  });

  test("purging the thread purges its research runs", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStream(t);
    await t.mutation(internal.researchRuns.checkpoint, plan(s.streamId, "r1"));
    await t.run(async (ctx) =>
      ctx.db.patch(s.threadId, { status: "trashed", trashedAt: Date.now() }),
    );
    await t.mutation(internal.chat.threads.purge, { threadId: s.threadId });
    await drain(t);
    expect(await loadRun(t, "r1")).toHaveLength(0);
  });
});
