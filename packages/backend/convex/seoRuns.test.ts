/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

// getAuthUserId reads the part before `|` (mirrors chat.security.test.ts).
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;

// Scheduled dispatchRun POSTs /v1/seo-run-step — stub fetch so it never touches the
// network and never outlives the test transaction. Default 202 (worker accepted).
const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "k";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ accepted: true }), { status: 202 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  // biome-ignore lint/performance/noDelete: the only way to unset an env var
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: the only way to unset an env var
  delete process.env.AI_SERVICE_KEY;
});

async function drain(t: TestT) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

/** A live streaming turn (thread.streamingMessageId === messageId, non-terminal). */
async function seedOwner(t: TestT, streamStatus: "queued" | "running" | "done" = "running") {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "u@t.test" });
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
      status: streamStatus,
      cancelRequested: false,
      chunkSeq: -1,
      committedText: "",
      committedSeq: -1,
      heartbeatAt: Date.now(),
      startedAt: Date.now(),
      attempts: 0,
      deadlineAt: Date.now() + 300_000,
    });
    return { userId, workspaceId, threadId, messageId, streamId };
  });
}

type RunOverrides = Partial<{
  status:
    | "queued"
    | "running"
    | "retry_wait"
    | "succeeded"
    | "partial"
    | "failed"
    | "cancelled"
    | "expired";
  leaseToken: string;
  heartbeatAt: number;
  attempts: number;
  deadlineAt: number;
  cancelRequested: boolean;
  costBudget: number;
  costSpent: number;
  processedCount: number;
  maxUrls: number;
}>;

/** Insert a seoRun directly (isolated state-machine tests). */
async function seedRun(
  t: TestT,
  owner: Awaited<ReturnType<typeof seedOwner>>,
  o: RunOverrides = {},
) {
  const runId = `run_${Math.random()}`;
  await t.run(async (ctx) => {
    await ctx.db.insert("seoRuns", {
      runId,
      streamId: owner.streamId,
      userId: owner.userId,
      workspaceId: owner.workspaceId,
      threadId: owner.threadId,
      inReplyToMessageId: owner.messageId,
      target: "https://example.com",
      scope: "site",
      maxUrls: o.maxUrls ?? 500,
      status: o.status ?? "running",
      leaseToken: o.leaseToken,
      heartbeatAt: o.heartbeatAt ?? Date.now(),
      attempts: o.attempts ?? 0,
      deadlineAt: o.deadlineAt ?? Date.now() + 7_200_000,
      cancelRequested: o.cancelRequested ?? false,
      workflowVersion: 1,
      schemaVersion: 1,
      inputHash: "ih",
      costBudget: o.costBudget ?? 500,
      costSpent: o.costSpent ?? 0,
      processedCount: o.processedCount ?? 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  return runId;
}

async function getRunRow(t: TestT, runId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("seoRuns")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .unique(),
  );
}

// ── Enqueue: live-turn bind + per-user caps ────────────────────────────────────
describe("enqueue", () => {
  test("from a LIVE turn → queued run + scheduled dispatch", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t, "running");
    const r = await t.mutation(internal.seoRuns.enqueueRun, {
      streamId: o.streamId,
      target: "https://example.com",
      scope: "site",
      inputHash: "ih1",
    });
    expect(r).toMatchObject({ ok: true });
    const runId = (r as { runId: string }).runId;
    const run = await getRunRow(t, runId);
    expect(run?.status).toBe("queued");
    expect(run?.userId).toBe(o.userId);
    expect(run?.inReplyToMessageId).toBe(o.messageId);
    await drain(t);
  });

  test("a NON-LIVE stream (streamingMessageId cleared) is rejected", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t, "running");
    await t.run(async (ctx) => {
      await ctx.db.patch(o.threadId, { streamingMessageId: undefined });
    });
    const r = await t.mutation(internal.seoRuns.enqueueRun, {
      streamId: o.streamId,
      target: "x",
      scope: "site",
      inputHash: "ih",
    });
    expect(r).toMatchObject({ ok: false, reason: "not_live" });
  });

  test("a terminal (done) stream is rejected", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t, "done");
    const r = await t.mutation(internal.seoRuns.enqueueRun, {
      streamId: o.streamId,
      target: "x",
      scope: "site",
      inputHash: "ih",
    });
    expect(r).toMatchObject({ ok: false, reason: "not_live" });
  });

  test("MAX_CONCURRENT_RUNS: a 4th active run is rejected", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t, "running");
    await seedRun(t, o, { status: "running" });
    await seedRun(t, o, { status: "queued" });
    await seedRun(t, o, { status: "retry_wait" });
    const r = await t.mutation(internal.seoRuns.enqueueRun, {
      streamId: o.streamId,
      target: "x",
      scope: "site",
      inputHash: "ih_distinct", // distinct from the seeded runs' "ih" (no dedup)
    });
    expect(r).toMatchObject({ ok: false, reason: "too_many_active" });
  });

  test("a re-enqueue with the same inputHash dedups to the existing run", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t, "running");
    const first = await t.mutation(internal.seoRuns.enqueueRun, {
      streamId: o.streamId,
      target: "https://example.com",
      scope: "site",
      inputHash: "same",
    });
    expect(first).toMatchObject({ ok: true });
    const again = await t.mutation(internal.seoRuns.enqueueRun, {
      streamId: o.streamId,
      target: "https://example.com",
      scope: "site",
      inputHash: "same", // resume / double-ask → same active run, not a duplicate
    });
    expect(again).toMatchObject({
      ok: true,
      deduped: true,
      runId: (first as { runId: string }).runId,
    });
    await drain(t);
  });

  test("MAX_RUNS_PER_HOUR: over the hourly window is rejected", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t, "running");
    await t.run(async (ctx) => {
      await ctx.db.insert("chatSettings", {
        workspaceId: o.workspaceId,
        userId: o.userId,
        defaultModel: "m",
        sendOnEnter: true,
        seoRunWindowStart: Date.now(),
        seoRunWindowCount: 10, // == MAX_RUNS_PER_HOUR
        updatedAt: Date.now(),
      });
    });
    const r = await t.mutation(internal.seoRuns.enqueueRun, {
      streamId: o.streamId,
      target: "x",
      scope: "site",
      inputHash: "ih",
    });
    expect(r).toMatchObject({ ok: false, reason: "rate_limited" });
  });
});

// ── Status-only claim (race-free) + refuse-and-finalize ────────────────────────
describe("claimForDispatch", () => {
  test("queued → running + a fresh leaseToken + payload", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "queued" });
    const p = await t.mutation(internal.seoRuns.claimForDispatch, { runId });
    expect(p).toMatchObject({ runId });
    expect((p as { leaseToken: string }).leaseToken).toBeTruthy();
    const run = await getRunRow(t, runId);
    expect(run?.status).toBe("running");
    expect(run?.leaseToken).toBe((p as { leaseToken: string }).leaseToken);
  });

  test("a running run is skipped (null)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "running", leaseToken: "L" });
    expect(await t.mutation(internal.seoRuns.claimForDispatch, { runId })).toBeNull();
  });

  test("two claims of a queued run → exactly one wins (serializable)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "queued" });
    const a = await t.mutation(internal.seoRuns.claimForDispatch, { runId });
    const b = await t.mutation(internal.seoRuns.claimForDispatch, { runId });
    expect([a, b].filter(Boolean)).toHaveLength(1); // second sees `running` → null
  });

  test("refuse-and-FINALIZE past the deadline (expired), not skip", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, {
      status: "queued",
      deadlineAt: Date.now() - 1,
    });
    expect(await t.mutation(internal.seoRuns.claimForDispatch, { runId })).toBeNull();
    expect((await getRunRow(t, runId))?.status).toBe("expired");
  });

  test("refuse-and-FINALIZE past the budget (partial)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, {
      status: "retry_wait",
      costBudget: 100,
      costSpent: 100,
    });
    expect(await t.mutation(internal.seoRuns.claimForDispatch, { runId })).toBeNull();
    expect((await getRunRow(t, runId))?.status).toBe("partial");
  });

  test("refuse-and-FINALIZE a cancel-requested run (cancelled)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, {
      status: "queued",
      cancelRequested: true,
    });
    expect(await t.mutation(internal.seoRuns.claimForDispatch, { runId })).toBeNull();
    expect((await getRunRow(t, runId))?.status).toBe("cancelled");
  });
});

// ── recordProgress: snapshot + recompute (no double-count) + lease ordering ─────
describe("recordProgress", () => {
  async function claimed(t: TestT, o: Awaited<ReturnType<typeof seedOwner>>, ov: RunOverrides = {}) {
    const runId = await seedRun(t, o, { status: "queued", ...ov });
    const p = (await t.mutation(internal.seoRuns.claimForDispatch, { runId })) as {
      leaseToken: string;
    };
    return { runId, leaseToken: p.leaseToken };
  }

  test("valid lease → step succeeded + run aggregate recomputed", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const { runId, leaseToken } = await claimed(t, o);
    const r = await t.mutation(internal.seoRuns.recordProgress, {
      runId,
      leaseToken,
      stepKey: "batch:0",
      inputHash: "b0",
      processedCount: 20,
      cost: 20,
      findingsCounts: { totalFindings: 3, passed: 1, failed: 1, warnings: 1, notTested: 0 },
    });
    expect(r).toMatchObject({ stale: false });
    const run = await getRunRow(t, runId);
    expect(run?.costSpent).toBe(20);
    expect(run?.processedCount).toBe(20);
  });

  test("re-recording the SAME batch does NOT double-count (P0-1)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const { runId, leaseToken } = await claimed(t, o);
    const args = {
      runId,
      leaseToken,
      stepKey: "batch:0",
      inputHash: "b0",
      processedCount: 20,
      cost: 20,
    };
    await t.mutation(internal.seoRuns.recordProgress, args);
    await t.mutation(internal.seoRuns.recordProgress, args); // resume re-record
    const run = await getRunRow(t, runId);
    expect(run?.costSpent).toBe(20); // NOT 40
    expect(run?.processedCount).toBe(20);
    const steps = await t.run(async (ctx) =>
      ctx.db
        .query("seoRunSteps")
        .withIndex("by_run_step", (q) => q.eq("runId", runId))
        .collect(),
    );
    expect(steps).toHaveLength(1); // idempotent by (runId, stepKey)
  });

  test("a WRONG lease is rejected before any write (stale)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const { runId } = await claimed(t, o);
    const r = await t.mutation(internal.seoRuns.recordProgress, {
      runId,
      leaseToken: "stale-token",
      stepKey: "batch:0",
      inputHash: "b0",
      processedCount: 20,
      cost: 20,
    });
    expect(r).toMatchObject({ stale: true });
    const run = await getRunRow(t, runId);
    expect(run?.costSpent).toBe(0); // nothing written
  });

  test("progress on a terminal run is a stale no-op", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "succeeded", leaseToken: "L" });
    const r = await t.mutation(internal.seoRuns.recordProgress, {
      runId,
      leaseToken: "L",
      stepKey: "batch:0",
      inputHash: "b0",
      processedCount: 5,
      cost: 5,
    });
    expect(r).toMatchObject({ stale: true });
  });

  test("an oversize checkpoint is refused", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const { runId, leaseToken } = await claimed(t, o);
    const r = await t.mutation(internal.seoRuns.recordProgress, {
      runId,
      leaseToken,
      stepKey: "batch:0",
      inputHash: "b0",
      processedCount: 1,
      cost: 1,
      checkpoint: "x".repeat(100_001),
    });
    expect(r).toMatchObject({ rejected: "checkpoint_too_large" });
  });

  test("forward progress resets attempts; a stale writer cannot (ordering)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    // A run that has already been reaped twice (attempts=2), freshly claimed.
    const { runId, leaseToken } = await claimed(t, o, { attempts: 2 });
    // Stale writer: attempts must NOT reset.
    await t.mutation(internal.seoRuns.recordProgress, {
      runId,
      leaseToken: "stale",
      stepKey: "batch:0",
      inputHash: "b0",
      processedCount: 10,
      cost: 10,
    });
    expect((await getRunRow(t, runId))?.attempts).toBe(2);
    // Valid writer with forward progress: attempts resets to 0.
    await t.mutation(internal.seoRuns.recordProgress, {
      runId,
      leaseToken,
      stepKey: "batch:0",
      inputHash: "b0",
      processedCount: 10,
      cost: 10,
    });
    expect((await getRunRow(t, runId))?.attempts).toBe(0);
  });
});

// ── Heartbeat lease-gated ──────────────────────────────────────────────────────
describe("recordHeartbeat", () => {
  test("valid lease bumps heartbeatAt; a stale lease is rejected", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const old = Date.now() - 60_000;
    const runId = await seedRun(t, o, {
      status: "running",
      leaseToken: "L",
      heartbeatAt: old,
    });
    const bad = await t.mutation(internal.seoRuns.recordHeartbeat, {
      runId,
      leaseToken: "WRONG",
    });
    expect(bad).toMatchObject({ stale: true });
    expect((await getRunRow(t, runId))?.heartbeatAt).toBe(old); // NOT bumped

    const ok = await t.mutation(internal.seoRuns.recordHeartbeat, {
      runId,
      leaseToken: "L",
    });
    expect(ok).toMatchObject({ stale: false });
    expect((await getRunRow(t, runId))?.heartbeatAt).toBeGreaterThan(old);
  });
});

// ── finalizeRun: cancel-aware + idempotent ─────────────────────────────────────
describe("finalizeRun", () => {
  test("succeeded (valid lease)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "running", leaseToken: "L" });
    await t.mutation(internal.seoRuns.finalizeRun, {
      runId,
      leaseToken: "L",
      status: "succeeded",
      reportId: "rep1",
    });
    const run = await getRunRow(t, runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.reportId).toBe("rep1");
    expect(run?.leaseToken).toBeUndefined();
  });

  test("a cancel mid-window coerces `succeeded` → partial (processed>0)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, {
      status: "running",
      leaseToken: "L",
      cancelRequested: true,
      processedCount: 40,
    });
    await t.mutation(internal.seoRuns.finalizeRun, {
      runId,
      leaseToken: "L",
      status: "succeeded",
    });
    const run = await getRunRow(t, runId);
    expect(run?.status).toBe("partial");
    expect(run?.terminalErrorCode).toBe("cancelled");
  });

  test("re-finalize of a terminal run is a no-op (first status stays)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "succeeded", leaseToken: "L" });
    const r = await t.mutation(internal.seoRuns.finalizeRun, {
      runId,
      leaseToken: "L",
      status: "failed",
    });
    expect(r).toMatchObject({ stale: true });
    expect((await getRunRow(t, runId))?.status).toBe("succeeded");
  });
});

// ── parkRun (continue) ─────────────────────────────────────────────────────────
describe("parkRun", () => {
  test("valid lease → retry_wait, no attempts bump, dispatch rescheduled", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, {
      status: "running",
      leaseToken: "L",
      attempts: 1,
    });
    const r = await t.mutation(internal.seoRuns.parkRun, {
      runId,
      leaseToken: "L",
      checkpoint: "{}",
    });
    expect(r).toMatchObject({ stale: false });
    const run = await getRunRow(t, runId);
    expect(run?.status).toBe("retry_wait");
    expect(run?.attempts).toBe(1); // NOT bumped by a continue
    expect(run?.leaseToken).toBeUndefined();
    await drain(t);
  });

  test("park with a cancel pending finalizes cancelled", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, {
      status: "running",
      leaseToken: "L",
      cancelRequested: true,
    });
    await t.mutation(internal.seoRuns.parkRun, { runId, leaseToken: "L" });
    expect((await getRunRow(t, runId))?.status).toBe("cancelled");
  });
});

// ── dispatchRun: 409 / non-2xx → retry_wait (the SEO third behavior) ───────────
describe("dispatchRun failure handling", () => {
  test("a 409 requeues to retry_wait (benign, NOT wedged running, NOT failed)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "queued" });
    globalThis.fetch = (async () =>
      new Response("busy", { status: 409 })) as typeof fetch;
    await t.action(internal.seoRuns.dispatchRun, { runId });
    expect((await getRunRow(t, runId))?.status).toBe("retry_wait");
    await drain(t);
  });

  test("a 500 also requeues to retry_wait (a transient blip is not terminal)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "queued" });
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;
    await t.action(internal.seoRuns.dispatchRun, { runId });
    expect((await getRunRow(t, runId))?.status).toBe("retry_wait");
    await drain(t);
  });

  test("a 202 leaves the run running (the worker holds it)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "queued" });
    await t.action(internal.seoRuns.dispatchRun, { runId });
    expect((await getRunRow(t, runId))?.status).toBe("running");
  });
});

// ── Reaper: all non-terminal states ────────────────────────────────────────────
describe("reapStalledRuns", () => {
  const STALE = Date.now() - 11 * 60_000; // > SEO_STALL_MS (10m)

  test("a stalled RUNNING run (attempts<MAX) is resumed (queued, attempts+1, deadline kept, lease rotated)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const deadline = Date.now() + 3_600_000;
    const runId = await seedRun(t, o, {
      status: "running",
      leaseToken: "OLD",
      heartbeatAt: STALE,
      attempts: 1,
      deadlineAt: deadline,
    });
    const r = await t.mutation(internal.seoRuns.reapStalledRuns, {});
    expect(r).toMatchObject({ resumed: 1 });
    const run = await getRunRow(t, runId);
    expect(run?.status).toBe("queued");
    expect(run?.attempts).toBe(2); // bumped ONLY by the reaper
    expect(run?.deadlineAt).toBe(deadline); // NEVER reset
    expect(run?.leaseToken).toBeUndefined(); // rotated → the OLD worker is now stale
    await drain(t);
  });

  test("a stalled RETRY_WAIT run is also reaped (scans every non-terminal state)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, {
      status: "retry_wait",
      heartbeatAt: STALE,
      attempts: 0,
    });
    await t.mutation(internal.seoRuns.reapStalledRuns, {});
    expect((await getRunRow(t, runId))?.status).toBe("queued");
    await drain(t);
  });

  test("cancel-requested stalled → cancelled", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, {
      status: "running",
      heartbeatAt: STALE,
      cancelRequested: true,
    });
    await t.mutation(internal.seoRuns.reapStalledRuns, {});
    expect((await getRunRow(t, runId))?.status).toBe("cancelled");
  });

  test("past deadline → expired (no processing) / partial (some processing)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const a = await seedRun(t, o, {
      status: "running",
      heartbeatAt: STALE,
      deadlineAt: Date.now() - 1,
    });
    const b = await seedRun(t, o, {
      status: "running",
      heartbeatAt: STALE,
      deadlineAt: Date.now() - 1,
      processedCount: 30,
    });
    await t.mutation(internal.seoRuns.reapStalledRuns, {});
    expect((await getRunRow(t, a))?.status).toBe("expired");
    expect((await getRunRow(t, b))?.status).toBe("partial");
  });

  test("attempts at the ceiling → failed (no processing)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, {
      status: "running",
      heartbeatAt: STALE,
      attempts: 5,
    });
    await t.mutation(internal.seoRuns.reapStalledRuns, {});
    expect((await getRunRow(t, runId))?.status).toBe("failed");
  });
});

// ── requestCancel: every state, userId-gated ───────────────────────────────────
describe("requestCancel", () => {
  test("queued → cancelled immediately", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "queued" });
    await t.withIdentity(as(o.userId)).mutation(api.seoRuns.requestCancel, { runId });
    expect((await getRunRow(t, runId))?.status).toBe("cancelled");
  });

  test("retry_wait → cancelled immediately", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "retry_wait" });
    await t.withIdentity(as(o.userId)).mutation(api.seoRuns.requestCancel, { runId });
    expect((await getRunRow(t, runId))?.status).toBe("cancelled");
  });

  test("running → cancelRequested set (worker finalizes next flush)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "running", leaseToken: "L" });
    await t.withIdentity(as(o.userId)).mutation(api.seoRuns.requestCancel, { runId });
    const run = await getRunRow(t, runId);
    expect(run?.status).toBe("running");
    expect(run?.cancelRequested).toBe(true);
  });

  test("a non-owner cannot cancel (Not found)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "queued" });
    const other = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "e@t.test" }),
    );
    await expect(
      t.withIdentity(as(other)).mutation(api.seoRuns.requestCancel, { runId }),
    ).rejects.toThrow(/Not found/);
  });
});

// ── upsertRunReport: owner from run, first-committed-wins; getReport tenancy ────
describe("upsertRunReport + getReport", () => {
  const REPORT = (reportId: string, status = "completed") => ({
    reportId,
    status,
    target: "https://example.com",
    scope: "site",
    methodologyName: "SEO",
    methodologyVersion: "1",
    generatedAt: "2026-01-01T00:00:00Z",
    summary: { totalFindings: 1, passed: 1, failed: 0, warnings: 0, notTested: 0 },
    report: JSON.stringify({ report_id: reportId }),
    manifest: [],
  });

  test("first write inserts (owner from run); the owner reads it, a peer cannot", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "running", leaseToken: "L" });
    const r = await t.mutation(internal.seoRuns.upsertRunReport, {
      runId,
      leaseToken: "L",
      ...REPORT("rep1"),
    });
    expect(r).toMatchObject({ ok: true, reportId: "rep1" });
    const got = await t
      .withIdentity(as(o.userId))
      .query(api.chat.reports.getReport, { reportId: "rep1" });
    expect(got.status).toBe("completed");
    const other = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "e@t.test" }),
    );
    await expect(
      t.withIdentity(as(other)).query(api.chat.reports.getReport, { reportId: "rep1" }),
    ).rejects.toThrow(/Not found/);
  });

  test("first-committed-wins: a second (differing) report does not overwrite", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "running", leaseToken: "L" });
    await t.mutation(internal.seoRuns.upsertRunReport, {
      runId,
      leaseToken: "L",
      ...REPORT("rep1", "completed"),
    });
    await t.mutation(internal.seoRuns.upsertRunReport, {
      runId,
      leaseToken: "L",
      ...REPORT("rep1", "partial"), // different content, same (runId, reportId)
    });
    const got = await t
      .withIdentity(as(o.userId))
      .query(api.chat.reports.getReport, { reportId: "rep1" });
    expect(got.status).toBe("completed"); // first wins
  });
});

// ── Run-owned artifacts: idempotency + contentHash-on-dedup + download tenancy ──
describe("seoArtifacts", () => {
  async function store(t: TestT, bytes: string) {
    return t.run(async (ctx) => ctx.storage.store(new Blob([bytes])));
  }

  test("idempotent by (runId, artifactKey): a re-store dedups + returns the EXISTING hash", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "running", leaseToken: "L" });
    const s1 = await store(t, "aaa");
    const first = await t.mutation(internal.seoRuns.registerSeoArtifact, {
      runId,
      leaseToken: "L",
      stepKey: "batch:0",
      artifactKey: `${runId}:batch:0`,
      storageId: s1,
      filename: "c.jsonl.gz",
      format: "jsonl.gz",
      mime: "application/gzip",
      size: 3,
      rowCount: 1,
      contentHash: "HASH_V1",
    });
    const s2 = await store(t, "bbb"); // a re-crawl produced different bytes
    const second = await t.mutation(internal.seoRuns.registerSeoArtifact, {
      runId,
      leaseToken: "L",
      stepKey: "batch:0",
      artifactKey: `${runId}:batch:0`,
      storageId: s2,
      filename: "c.jsonl.gz",
      format: "jsonl.gz",
      mime: "application/gzip",
      size: 3,
      rowCount: 1,
      contentHash: "HASH_V2",
    });
    expect(second.artifactId).toBe(first.artifactId); // dedup
    expect(second.contentHash).toBe("HASH_V1"); // authoritative stored hash, not V2
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("seoArtifacts")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("a stale lease cannot register an artifact", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "running", leaseToken: "L" });
    const s = await store(t, "x");
    const r = await t.mutation(internal.seoRuns.registerSeoArtifact, {
      runId,
      leaseToken: "WRONG",
      stepKey: "batch:0",
      artifactKey: `${runId}:batch:0`,
      storageId: s,
      filename: "c",
      format: "jsonl.gz",
      mime: "application/gzip",
      size: 1,
      rowCount: 1,
      contentHash: "H",
    });
    expect(r.ok).toBe(false);
  });

  test("mintSeoDownload is owner-gated; resolveSeoDownload honours the TTL", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "running", leaseToken: "L" });
    const s = await store(t, "data");
    const reg = await t.mutation(internal.seoRuns.registerSeoArtifact, {
      runId,
      leaseToken: "L",
      stepKey: "batch:0",
      artifactKey: `${runId}:batch:0`,
      storageId: s,
      filename: "c.jsonl.gz",
      format: "jsonl.gz",
      mime: "application/gzip",
      size: 4,
      rowCount: 1,
      contentHash: "H",
    });
    const artifactId = reg.artifactId as string;
    // A peer cannot mint.
    const other = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "e@t.test" }),
    );
    await expect(
      t.withIdentity(as(other)).mutation(api.seoRuns.mintSeoDownload, { artifactId }),
    ).rejects.toThrow(/Not found/);
    // The owner mints + resolves.
    const { token } = await t
      .withIdentity(as(o.userId))
      .mutation(api.seoRuns.mintSeoDownload, { artifactId });
    const resolved = await t.query(internal.seoRuns.resolveSeoDownload, { token });
    expect(resolved?.mime).toBe("application/gzip");
    // Expire the token → null.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("seoArtifacts")
        .withIndex("by_downloadToken", (q) => q.eq("downloadToken", token))
        .unique();
      if (row) await ctx.db.patch(row._id, { downloadTokenExpiresAt: Date.now() - 1 });
    });
    expect(await t.query(internal.seoRuns.resolveSeoDownload, { token })).toBeNull();
  });
});

// ── Surfacing tenancy ──────────────────────────────────────────────────────────
describe("getRun + listActiveRuns", () => {
  test("getRun is owner-gated and never leaks the lease token", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "running", leaseToken: "SECRET" });
    const got = await t.withIdentity(as(o.userId)).query(api.seoRuns.getRun, { runId });
    expect(got?.status).toBe("running");
    expect(JSON.stringify(got)).not.toContain("SECRET");
    // A peer gets null (no throw → no console.error; no existence oracle either).
    const other = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "e@t.test" }),
    );
    expect(
      await t.withIdentity(as(other)).query(api.seoRuns.getRun, { runId }),
    ).toBeNull();
  });

  test("listActiveRuns surfaces a run even when its chat event is gone", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    await seedRun(t, o, { status: "running" });
    await seedRun(t, o, { status: "succeeded" }); // terminal → excluded
    const rows = await t
      .withIdentity(as(o.userId))
      .query(api.seoRuns.listActiveRuns, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("running");
  });
});

// ── Cascade: stop cancels (keeps), delete reclaims ─────────────────────────────
describe("cascade reclamation", () => {
  test("chat STOP cancels the run but keeps it (still visible via listActiveRuns)", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "running", leaseToken: "L" });
    await t
      .withIdentity(as(o.userId))
      .mutation(api.chat.stream.stop, { messageId: o.messageId });
    const run = await getRunRow(t, runId);
    expect(run).not.toBeNull(); // NOT deleted
    expect(run?.cancelRequested).toBe(true); // but told to stop crawling/billing
  });

  test("regenerate/edit tail-purge DELETES the run + its steps + artifact blobs", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "running", leaseToken: "L" });
    const s = await t.run(async (ctx) => ctx.storage.store(new Blob(["x"])));
    await t.mutation(internal.seoRuns.registerSeoArtifact, {
      runId,
      leaseToken: "L",
      stepKey: "batch:0",
      artifactKey: `${runId}:batch:0`,
      storageId: s,
      filename: "c",
      format: "jsonl.gz",
      mime: "application/gzip",
      size: 1,
      rowCount: 1,
      contentHash: "H",
    });
    await t.mutation(internal.seoRuns.recordProgress, {
      runId,
      leaseToken: "L",
      stepKey: "batch:0",
      inputHash: "b0",
      processedCount: 1,
      cost: 1,
    });
    // deleteFromSeq (regenerate/edit) runs via purgeTail; the seeded message is seq 2.
    await t.mutation(internal.chat.messages.purgeTail, {
      threadId: o.threadId,
      fromSeq: 2,
    });
    await drain(t);
    expect(await getRunRow(t, runId)).toBeNull(); // run gone
    const steps = await t.run(async (ctx) =>
      ctx.db
        .query("seoRunSteps")
        .withIndex("by_run_step", (q) => q.eq("runId", runId))
        .collect(),
    );
    expect(steps).toHaveLength(0);
    const arts = await t.run(async (ctx) =>
      ctx.db
        .query("seoArtifacts")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .collect(),
    );
    expect(arts).toHaveLength(0);
  });

  test("thread purge cascades: deletes the run + steps + artifact blobs", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "running", leaseToken: "L" });
    const s = await t.run(async (ctx) => ctx.storage.store(new Blob(["x"])));
    await t.mutation(internal.seoRuns.registerSeoArtifact, {
      runId,
      leaseToken: "L",
      stepKey: "batch:0",
      artifactKey: `${runId}:batch:0`,
      storageId: s,
      filename: "c",
      format: "jsonl.gz",
      mime: "application/gzip",
      size: 1,
      rowCount: 1,
      contentHash: "H",
    });
    // Trash the thread, then run the purge fan-out.
    await t.run(async (ctx) => {
      await ctx.db.patch(o.threadId, { status: "trashed" });
    });
    await t.mutation(internal.chat.threads.purge, { threadId: o.threadId });
    await drain(t);
    expect(await getRunRow(t, runId)).toBeNull();
    const arts = await t.run(async (ctx) =>
      ctx.db
        .query("seoArtifacts")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .collect(),
    );
    expect(arts).toHaveLength(0);
  });

  test("gcTerminalArtifacts reclaims a failed run's blobs", async () => {
    const t = convexTest(schema, modules);
    const o = await seedOwner(t);
    const runId = await seedRun(t, o, { status: "running", leaseToken: "L" });
    const s = await t.run(async (ctx) => ctx.storage.store(new Blob(["x"])));
    await t.mutation(internal.seoRuns.registerSeoArtifact, {
      runId,
      leaseToken: "L",
      stepKey: "batch:0",
      artifactKey: `${runId}:batch:0`,
      storageId: s,
      filename: "c",
      format: "jsonl.gz",
      mime: "application/gzip",
      size: 1,
      rowCount: 1,
      contentHash: "H",
    });
    await t.run(async (ctx) => {
      const run = await ctx.db
        .query("seoRuns")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .unique();
      if (run) await ctx.db.patch(run._id, { status: "failed", leaseToken: undefined });
    });
    const r = await t.mutation(internal.seoRuns.gcTerminalArtifacts, {});
    expect(r.reclaimed).toBeGreaterThanOrEqual(1);
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("seoArtifacts")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .collect(),
    );
    expect(rows).toHaveLength(0);
  });
});
