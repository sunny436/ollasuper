import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";

/**
 * Phase 5 — the durable SEO-run authority.
 *
 * Convex owns the state machine, the lease, the scheduler and the reaper; Python is a
 * stateless bounded worker that crawls one dispatch-window of batches and writes back
 * (progress / heartbeat / finalize / report / artifact), every write LEASE-GATED and
 * RUN-OWNED. The exit criterion — large audits survive crashes/retries/cancellation
 * with no duplicate active execution and no data corruption — is defended here:
 *
 * - No double-count: `costSpent`/`processedCount` are RECOMPUTED as Σ over `succeeded`
 *   step rows (never an additive delta); the step ledger is idempotent by (runId, stepKey).
 * - No duplicate execution: the claim is STATUS-ONLY + serializable (one queued→running
 *   wins); Python additionally `acquire(runId)`s in-process; the lease token rejects a
 *   stale cross-process worker's writes (checked BEFORE any state change).
 * - No wedge: a claim that refuses past deadline/budget FINALIZES the run; the reaper
 *   scans EVERY non-terminal state; `attempts` bumps only on reap; `deadlineAt` never resets.
 * - Cost bound: per-user MAX_CONCURRENT_RUNS + MAX_RUNS_PER_HOUR at enqueue (a run is far
 *   costlier than a chat turn), and per-run maxUrls/costBudget.
 */

const SEO_STALL_MS = 10 * 60_000; // »» a single batch (the userFiles ingest precedent)
const MAX_RUN_ATTEMPTS = 5; // reaper resumes of a crashed RUNNING worker (no-progress cap)
const SEO_RUN_DEADLINE_MS = 2 * 60 * 60_000; // wall-clock safety net (maxUrls is the real bound)
const MAX_CONCURRENT_RUNS = 3;
const MAX_RUNS_PER_HOUR = 10; // « chat's 120 — a run is much more expensive
const RATE_WINDOW_MS = 60 * 60_000;
const DISPATCH_BACKOFF_MS = 4_000; // ≥ worst-case finalize+release so a window-boundary re-acquire rarely 409s
const DISPATCH_JITTER_MS = 2_000;
const MAX_CHECKPOINT_BYTES = 100_000;
const MAX_SUMMARY_BYTES = 600_000; // matches report.py MAX_ROW_BYTES; the report source
const DEFAULT_MAX_URLS = 500;
const DOWNLOAD_TTL_MS = 5 * 60_000;
const DELETE_BATCH = 100;
// Runs drag steps + artifact blobs, so the thread-purge fan-out reclaims a SMALL
// number of runs per tick (and reschedules) to stay well under the mutation op cap.
export const SEO_RUN_PURGE_BATCH = 20;
const WORKFLOW_VERSION = 1;
const SCHEMA_VERSION = 1;

const TERMINAL_RUN = new Set([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "expired",
]);
function isTerminalRun(status: string): boolean {
  return TERMINAL_RUN.has(status);
}

async function loadRun(
  ctx: MutationCtx | QueryCtx,
  runId: string,
): Promise<Doc<"seoRuns"> | null> {
  return await ctx.db
    .query("seoRuns")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();
}

async function loadStream(
  ctx: MutationCtx,
  streamId: string,
): Promise<Doc<"chatStreams"> | null> {
  return await ctx.db
    .query("chatStreams")
    .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
    .unique();
}

function streamIsTerminal(status: string): boolean {
  return status === "done" || status === "error" || status === "aborted";
}

const ZERO_COUNTS = {
  totalFindings: 0,
  passed: 0,
  failed: 0,
  warnings: 0,
  notTested: 0,
};
type Counts = typeof ZERO_COUNTS;

/**
 * The single anti-double-count primitive: recompute the run aggregate from the
 * `succeeded` step rows. Re-recording a batch (same stepKey) leaves this unchanged —
 * immune to a non-monotonic snapshot the budget gate reads. Bounded at ~50 steps.
 */
async function recomputeAggregate(
  ctx: MutationCtx,
  runId: string,
): Promise<{ costSpent: number; processedCount: number; counts: Counts }> {
  const rows = await ctx.db
    .query("seoRunSteps")
    .withIndex("by_run_status", (q) =>
      q.eq("runId", runId).eq("status", "succeeded"),
    )
    .collect();
  let costSpent = 0;
  let processedCount = 0;
  const counts: Counts = { ...ZERO_COUNTS };
  for (const r of rows) {
    costSpent += r.cost;
    processedCount += r.processedCount;
    if (r.findingsCounts) {
      counts.totalFindings += r.findingsCounts.totalFindings;
      counts.passed += r.findingsCounts.passed;
      counts.failed += r.findingsCounts.failed;
      counts.warnings += r.findingsCounts.warnings;
      counts.notTested += r.findingsCounts.notTested;
    }
  }
  return { costSpent, processedCount, counts };
}

// ── Enqueue (from the chat turn's SEO agent tool) ──────────────────────────────

/**
 * op:"seo-run-enqueue" — the ONLY way a durable run is created.
 *
 * Bound to the LIVE streaming turn (a chatStreams row resolves forever, so any past
 * streamId would be a replayable spend token). Per-user caps close the
 * send→enqueue→cancel→re-enqueue billing loop. Owner ids DERIVED from the stream.
 * Returns a typed rejection the tool surfaces honestly.
 */
export const enqueueRun = internalMutation({
  args: {
    streamId: v.string(),
    target: v.string(),
    scope: v.string(),
    maxUrls: v.optional(v.number()),
    inputHash: v.string(),
  },
  handler: async (ctx, a) => {
    const stream = await loadStream(ctx, a.streamId);
    if (!stream) return { ok: false as const, reason: "unknown_stream" };
    // Live-turn bind: only the currently-authorized, non-terminal streaming message
    // may enqueue — not an old/replayed streamId.
    if (streamIsTerminal(stream.status))
      return { ok: false as const, reason: "not_live" };
    const thread = await ctx.db.get(stream.threadId);
    if (!thread || thread.streamingMessageId !== stream.messageId)
      return { ok: false as const, reason: "not_live" };

    // Per-user concurrency cap (across queued|retry_wait|running). While scanning,
    // DEDUP by inputHash: a re-emitted enqueue (resume, or the model asking twice) for
    // the same target/scope returns the EXISTING active run instead of a duplicate.
    let active = 0;
    for (const s of ["queued", "retry_wait", "running"] as const) {
      const rows = await ctx.db
        .query("seoRuns")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", stream.userId).eq("status", s),
        )
        .take(MAX_CONCURRENT_RUNS + 1);
      for (const r of rows) {
        if (r.inputHash === a.inputHash)
          return { ok: true as const, runId: r.runId, deduped: true as const };
      }
      active += rows.length;
    }
    if (active >= MAX_CONCURRENT_RUNS)
      return { ok: false as const, reason: "too_many_active" };

    // Per-user hourly rate cap (fixed window on the chatSettings row).
    const now = Date.now();
    const settings = await ctx.db
      .query("chatSettings")
      .withIndex("by_user_workspace", (q) =>
        q.eq("userId", stream.userId).eq("workspaceId", stream.workspaceId),
      )
      .unique();
    const start = settings?.seoRunWindowStart ?? 0;
    const fresh = now - start >= RATE_WINDOW_MS;
    const count = fresh ? 0 : (settings?.seoRunWindowCount ?? 0);
    if (count >= MAX_RUNS_PER_HOUR)
      return { ok: false as const, reason: "rate_limited" };
    const windowPatch = {
      seoRunWindowStart: fresh ? now : start,
      seoRunWindowCount: count + 1,
    };
    if (settings) await ctx.db.patch(settings._id, windowPatch);
    // (No settings row ⇒ the user hasn't chatted; enqueue can only come from a live
    //  turn that already created settings, so this branch is unreachable in practice.)

    const runId = crypto.randomUUID();
    const maxUrls = Math.max(1, Math.min(a.maxUrls ?? DEFAULT_MAX_URLS, 5000));
    await ctx.db.insert("seoRuns", {
      runId,
      streamId: a.streamId,
      userId: stream.userId,
      workspaceId: stream.workspaceId,
      threadId: stream.threadId,
      inReplyToMessageId: stream.messageId,
      target: a.target.slice(0, 2048),
      scope: a.scope.slice(0, 512),
      maxUrls,
      status: "queued",
      heartbeatAt: now,
      attempts: 0,
      deadlineAt: now + SEO_RUN_DEADLINE_MS,
      cancelRequested: false,
      workflowVersion: WORKFLOW_VERSION,
      schemaVersion: SCHEMA_VERSION,
      inputHash: a.inputHash,
      costBudget: maxUrls,
      costSpent: 0,
      processedCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.seoRuns.dispatchRun, { runId });
    return { ok: true as const, runId };
  },
});

/**
 * Phase 6 — enqueue a MONITORING run for a project (no chat stream). Owner + target from
 * the seoProject; same per-user caps as a chat run; DEDUP by a per-project inputHash so a
 * schedule + a manual rerun can't run two audits of the same project at once. Reuses the
 * whole Phase-5 dispatch/reap/finalize engine (the run is run-owned).
 */
export async function enqueueScheduledRun(
  ctx: MutationCtx,
  projectId: Id<"seoProjects">,
  origin: "schedule" | "manual",
): Promise<
  | { ok: true; runId: string; deduped?: true }
  | { ok: false; reason: string }
> {
  {
    const project = await ctx.db.get(projectId);
    if (!project) return { ok: false as const, reason: "no_project" };
    if (project.status !== "active")
      return { ok: false as const, reason: "paused" };

    const now = Date.now();
    const inputHash = `proj:${projectId}:${project.target}:${project.scope}:${WORKFLOW_VERSION}`;
    // Concurrency cap + per-project dedup: an active run for this project ⇒ reuse it
    // (never stack two audits of the same site).
    let active = 0;
    for (const s of ["queued", "retry_wait", "running"] as const) {
      const rows = await ctx.db
        .query("seoRuns")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", project.userId).eq("status", s),
        )
        .take(MAX_CONCURRENT_RUNS + 1);
      for (const r of rows) {
        if (r.inputHash === inputHash)
          return { ok: true as const, runId: r.runId, deduped: true as const };
      }
      active += rows.length;
    }
    if (active >= MAX_CONCURRENT_RUNS)
      return { ok: false as const, reason: "too_many_active" };

    // Per-user hourly rate cap (best-effort; a user with no settings row is bounded by
    // the concurrency cap instead — a daily/weekly schedule never approaches 10/hour).
    const settings = await ctx.db
      .query("chatSettings")
      .withIndex("by_user_workspace", (q) =>
        q.eq("userId", project.userId).eq("workspaceId", project.workspaceId),
      )
      .unique();
    const start = settings?.seoRunWindowStart ?? 0;
    const fresh = now - start >= RATE_WINDOW_MS;
    const count = fresh ? 0 : (settings?.seoRunWindowCount ?? 0);
    if (count >= MAX_RUNS_PER_HOUR)
      return { ok: false as const, reason: "rate_limited" };
    if (settings)
      await ctx.db.patch(settings._id, {
        seoRunWindowStart: fresh ? now : start,
        seoRunWindowCount: count + 1,
      });

    const runId = crypto.randomUUID();
    const maxUrls = Math.max(1, Math.min(project.maxUrls, 5000));
    await ctx.db.insert("seoRuns", {
      runId,
      projectId,
      origin,
      userId: project.userId,
      workspaceId: project.workspaceId,
      target: project.target,
      scope: project.scope,
      maxUrls,
      status: "queued",
      heartbeatAt: now,
      attempts: 0,
      deadlineAt: now + SEO_RUN_DEADLINE_MS,
      cancelRequested: false,
      workflowVersion: WORKFLOW_VERSION,
      schemaVersion: SCHEMA_VERSION,
      inputHash,
      costBudget: maxUrls,
      costSpent: 0,
      processedCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.seoRuns.dispatchRun, { runId });
    await ctx.db.patch(projectId, {
      lastRunId: runId,
      lastRunAt: now,
      updatedAt: now,
    });
    return { ok: true as const, runId };
  }
}

// ── Dispatch (Convex → Python) ─────────────────────────────────────────────────

/**
 * STATUS-ONLY claim (serializable ⇒ race-free): queued|retry_wait → mint a fresh
 * server-side leaseToken + running. A refusal past deadline/budget FINALIZES the run
 * (never a skip that would wedge it in retry_wait). Returns the dispatch payload, or
 * null when there is nothing to dispatch.
 */
export const claimForDispatch = internalMutation({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const run = await loadRun(ctx, runId);
    if (!run) return null;
    if (isTerminalRun(run.status)) return null;
    if (run.status === "running") return null; // a live worker holds it

    const now = Date.now();
    // Refuse-and-FINALIZE (not skip): cancel/deadline/budget are terminal here.
    if (run.cancelRequested) {
      await finalize(ctx, run, "cancelled", "cancelled");
      return null;
    }
    if (now > run.deadlineAt) {
      await finalize(ctx, run, "expired", "deadline");
      return null;
    }
    if (run.costSpent >= run.costBudget) {
      await finalize(ctx, run, "partial", "budget");
      return null;
    }

    const leaseToken = crypto.randomUUID();
    await ctx.db.patch(run._id, {
      status: "running",
      leaseToken,
      heartbeatAt: now,
      updatedAt: now,
    });
    return {
      runId,
      leaseToken,
      userId: run.userId, // the seo_registry's per-user pool key (owner never trusted from Python)
      target: run.target,
      scope: run.scope,
      maxUrls: run.maxUrls,
      costBudget: run.costBudget,
      costSpent: run.costSpent,
      deadlineAt: run.deadlineAt,
      workflowVersion: run.workflowVersion,
      checkpoint: run.checkpoint ?? null,
      summary: run.summary ?? null,
      // The run's creation time — the worker seeds the report's deterministic
      // generated_at from it so a resume re-emit renders byte-identical bytes.
      createdAt: run.createdAt,
    };
  },
});

export const dispatchRun = internalAction({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const base = process.env.AI_BASE_URL;
    const key = process.env.AI_SERVICE_KEY;
    if (!base || !key) {
      // Unconfigured: leave it for an operator; the reaper will not resume a queued
      // run forever (it expires at deadlineAt).
      return;
    }
    const payload = await ctx.runMutation(internal.seoRuns.claimForDispatch, {
      runId,
    });
    if (!payload) return; // nothing to dispatch (terminal / running / finalized-on-refuse)

    try {
      const res = await fetch(
        `${base.replace(/\/$/, "")}/v1/seo-run-step`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-service-key": key },
          body: JSON.stringify(payload),
        },
      );
      // 409 (worker still holds runId in its Registry from the previous window) is
      // BENIGN-retry; any other non-2xx is a transient failure that must NOT leave the
      // run wedged `running` for a full stall — requeue promptly, bounded by deadline.
      if (res.status === 409 || !res.ok) {
        await ctx.runMutation(internal.seoRuns.markDispatchFailed, { runId });
      }
    } catch {
      await ctx.runMutation(internal.seoRuns.markDispatchFailed, { runId });
    }
  },
});

/**
 * A dispatch POST failed (transient 5xx / network / benign 409). Return the run to
 * retry_wait and reschedule promptly with jittered backoff — do NOT bump attempts
 * (that is reap-only) and do NOT leave it `running`. Bounded by deadline; the reaper
 * is the backstop if the scheduled redispatch is also lost.
 */
export const markDispatchFailed = internalMutation({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const run = await loadRun(ctx, runId);
    if (!run || isTerminalRun(run.status)) return;
    const now = Date.now();
    if (run.cancelRequested)
      return await finalize(ctx, run, "cancelled", "cancelled");
    if (now > run.deadlineAt)
      return await finalize(ctx, run, "expired", "deadline");
    await ctx.db.patch(run._id, {
      status: "retry_wait",
      leaseToken: undefined, // the failed dispatch never reached a worker
      heartbeatAt: now,
      updatedAt: now,
    });
    const delay = DISPATCH_BACKOFF_MS + Math.floor(Math.random() * DISPATCH_JITTER_MS);
    await ctx.scheduler.runAfter(delay, internal.seoRuns.dispatchRun, { runId });
  },
});

// ── Writeback (Python → Convex), all lease-gated ───────────────────────────────

/**
 * Shared lease/terminal guard, run FIRST in every writeback op (before any state
 * change) so a stale worker's late write can neither corrupt state nor reset attempts.
 */
function guardHolder(
  run: Doc<"seoRuns">,
  leaseToken: string,
): { stale: true; cancel: true } | null {
  if (isTerminalRun(run.status)) return { stale: true, cancel: true };
  if (run.leaseToken !== leaseToken) return { stale: true, cancel: true };
  return null;
}

const countsValidator = v.object({
  totalFindings: v.number(),
  passed: v.number(),
  failed: v.number(),
  warnings: v.number(),
  notTested: v.number(),
});

/**
 * op:"seo-run-progress" — record ONE batch's step snapshot + advance the run.
 *
 * The step snapshot is upserted in the SAME transition that marks it `succeeded`, so
 * it always reflects the same crawl as the stored artifact. The run aggregate is then
 * RECOMPUTED from succeeded steps (idempotent). `checkpoint`/`summary` are opaque
 * bounded blobs the worker owns (replace, not append). Returns {cancel} so the worker
 * learns of a cancel within one flush.
 */
export const recordProgress = internalMutation({
  args: {
    runId: v.string(),
    leaseToken: v.string(),
    stepKey: v.string(),
    inputHash: v.string(),
    processedCount: v.number(),
    cost: v.number(),
    findingsCounts: v.optional(countsValidator),
    artifactKeys: v.optional(v.array(v.string())),
    checkpoint: v.optional(v.string()),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const run = await loadRun(ctx, a.runId);
    if (!run) return { stale: true as const, cancel: true as const };
    const bad = guardHolder(run, a.leaseToken);
    if (bad) return bad;

    if (a.checkpoint && a.checkpoint.length > MAX_CHECKPOINT_BYTES)
      return { stale: false as const, cancel: false as const, rejected: "checkpoint_too_large" };
    if (a.summary && a.summary.length > MAX_SUMMARY_BYTES)
      return { stale: false as const, cancel: false as const, rejected: "summary_too_large" };

    const now = Date.now();
    // Idempotent step upsert by (runId, stepKey): the snapshot IS the success mark.
    const existing = await ctx.db
      .query("seoRunSteps")
      .withIndex("by_run_step", (q) =>
        q.eq("runId", a.runId).eq("stepKey", a.stepKey),
      )
      .unique();
    const stepFields = {
      status: "succeeded" as const,
      processedCount: a.processedCount,
      cost: a.cost,
      updatedAt: now,
      ...(a.findingsCounts ? { findingsCounts: a.findingsCounts } : {}),
      ...(a.artifactKeys ? { artifactKeys: a.artifactKeys } : {}),
    };
    if (existing) {
      // Terminal step is idempotent: re-record leaves the same snapshot (no growth).
      await ctx.db.patch(existing._id, stepFields);
    } else {
      await ctx.db.insert("seoRunSteps", {
        runId: a.runId,
        workflowVersion: run.workflowVersion,
        stepKey: a.stepKey,
        inputHash: a.inputHash,
        attempts: 0,
        startedAt: now,
        ...stepFields,
      });
    }

    // Recompute the aggregate from succeeded steps (never additive) and advance.
    const agg = await recomputeAggregate(ctx, a.runId);
    // Forward progress (the frontier advanced) resets the crash-resume attempt cap —
    // strictly here, in the lease-valid branch, so a stale writer cannot defeat it.
    const advanced = agg.processedCount > run.processedCount;
    await ctx.db.patch(run._id, {
      costSpent: agg.costSpent,
      processedCount: agg.processedCount,
      heartbeatAt: now,
      updatedAt: now,
      ...(advanced ? { attempts: 0 } : {}),
      ...(a.checkpoint !== undefined ? { checkpoint: a.checkpoint } : {}),
      ...(a.summary !== undefined ? { summary: a.summary } : {}),
    });
    return { stale: false as const, cancel: run.cancelRequested };
  },
});

/**
 * op:"seo-run-heartbeat" — lease-gated liveness. A falsely-reaped stale worker's
 * heartbeat is REJECTED (mismatched token), so it cannot keep its dead run alive and
 * defeat the reaper (the cross-process double-execution guard on scale-out).
 */
export const recordHeartbeat = internalMutation({
  args: { runId: v.string(), leaseToken: v.string() },
  handler: async (ctx, { runId, leaseToken }) => {
    const run = await loadRun(ctx, runId);
    if (!run) return { stale: true as const, cancel: true as const };
    const bad = guardHolder(run, leaseToken);
    if (bad) return bad;
    await ctx.db.patch(run._id, { heartbeatAt: Date.now() });
    return { stale: false as const, cancel: run.cancelRequested };
  },
});

/**
 * op:"seo-run-park" — the worker's dispatch window ended with work remaining. Park in
 * retry_wait and reschedule (a fresh lease is minted by the next claim). No attempts
 * bump. Lease-gated + terminal-idempotent.
 */
export const parkRun = internalMutation({
  args: {
    runId: v.string(),
    leaseToken: v.string(),
    checkpoint: v.optional(v.string()),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const run = await loadRun(ctx, a.runId);
    if (!run) return { stale: true as const, cancel: true as const };
    const bad = guardHolder(run, a.leaseToken);
    if (bad) return bad;
    if (a.checkpoint && a.checkpoint.length > MAX_CHECKPOINT_BYTES)
      return { stale: false as const, cancel: false as const, rejected: "checkpoint_too_large" };
    const now = Date.now();
    if (run.cancelRequested) {
      await finalize(ctx, run, "cancelled", "cancelled");
      return { stale: true as const, cancel: true as const };
    }
    await ctx.db.patch(run._id, {
      status: "retry_wait",
      leaseToken: undefined, // release the lease; the next claim rotates it
      heartbeatAt: now,
      updatedAt: now,
      ...(a.checkpoint !== undefined ? { checkpoint: a.checkpoint } : {}),
      ...(a.summary !== undefined ? { summary: a.summary } : {}),
    });
    const delay =
      DISPATCH_BACKOFF_MS + Math.floor(Math.random() * DISPATCH_JITTER_MS);
    await ctx.scheduler.runAfter(delay, internal.seoRuns.dispatchRun, {
      runId: a.runId,
    });
    return { stale: false as const, cancel: false as const };
  },
});

/** Shared terminal writer — isTerminal-first idempotent (the loser of a race no-ops). */
async function finalize(
  ctx: MutationCtx,
  run: Doc<"seoRuns">,
  status: "succeeded" | "partial" | "failed" | "cancelled" | "expired",
  errorCode: string | undefined,
): Promise<void> {
  if (isTerminalRun(run.status)) {
    console.warn("seoRuns.finalize_after_terminal", {
      runId: run.runId,
      from: run.status,
      to: status,
    });
    return;
  }
  await ctx.db.patch(run._id, {
    status,
    leaseToken: undefined,
    updatedAt: Date.now(),
    ...(errorCode ? { terminalErrorCode: errorCode } : {}),
  });
}

/**
 * op:"seo-run-finalize" — terminal, lease-gated, cancel-aware. A `succeeded` posted in
 * the same window as a user cancel is COERCED to cancelled/partial (a truncated result
 * is never labelled complete). Re-finalize of a terminal run is a no-op+warn.
 */
export const finalizeRun = internalMutation({
  args: {
    runId: v.string(),
    leaseToken: v.string(),
    status: v.union(
      v.literal("succeeded"),
      v.literal("partial"),
      v.literal("failed"),
    ),
    reportId: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const run = await loadRun(ctx, a.runId);
    if (!run) return { ok: false as const, stale: true as const };
    if (isTerminalRun(run.status)) {
      console.warn("seoRuns.refinalize", { runId: a.runId, status: run.status });
      return { ok: true as const, stale: true as const }; // idempotent no-op
    }
    if (run.leaseToken !== a.leaseToken)
      return { ok: false as const, stale: true as const };

    // Cancel-aware coercion: a cancel requested mid-window wins over a `succeeded`.
    let status = a.status;
    let errorCode = a.errorCode;
    if (run.cancelRequested && status === "succeeded") {
      status = run.processedCount > 0 ? "partial" : "failed";
      errorCode = "cancelled";
    }
    await ctx.db.patch(run._id, {
      status,
      leaseToken: undefined,
      updatedAt: Date.now(),
      ...(a.reportId ? { reportId: a.reportId } : {}),
      ...(errorCode ? { terminalErrorCode: errorCode } : {}),
      ...(a.summary !== undefined && a.summary.length <= MAX_SUMMARY_BYTES
        ? { summary: a.summary }
        : {}),
    });
    // Phase 6: a monitoring run belongs to a project → deterministically diff it against
    // the baseline (LLM-free) and notify only on meaningful changes. Chat runs skip this.
    if (run.projectId) {
      await ctx.scheduler.runAfter(0, internal.seoMonitor.runDiff, {
        runId: a.runId,
      });
    }
    return { ok: true as const, stale: false as const };
  },
});

/**
 * op:"seo-run-report" — write the run's report into the shared seoReports table, owner
 * DERIVED from the run (NOT op:"report"/upsertReport, which resolves owner via a stream
 * that a runId is not). First-committed-wins on (sourceRunId=runId, reportId) so a
 * resume re-emit is a stable no-op. Bounded like the chat report.
 */
const summaryValidator = v.object({
  totalFindings: v.number(),
  passed: v.number(),
  failed: v.number(),
  warnings: v.number(),
  notTested: v.number(),
});
const manifestValidator = v.array(
  v.object({
    artifactId: v.string(),
    format: v.string(),
    mime: v.string(),
    size: v.number(),
    sha256: v.string(),
  }),
);
const MAX_REPORT_BYTES = 700_000;

export const upsertRunReport = internalMutation({
  args: {
    runId: v.string(),
    leaseToken: v.string(),
    reportId: v.string(),
    status: v.string(),
    target: v.string(),
    scope: v.string(),
    methodologyName: v.string(),
    methodologyVersion: v.string(),
    generatedAt: v.string(),
    summary: summaryValidator,
    report: v.string(),
    manifest: manifestValidator,
  },
  handler: async (ctx, a) => {
    if (a.report.length > MAX_REPORT_BYTES)
      return { ok: false as const, reason: "report_too_large" };
    const run = await loadRun(ctx, a.runId);
    if (!run) return { ok: false as const, stale: true as const };
    // Terminal is fine here (report may land at finalize); only the lease is required.
    if (run.leaseToken !== a.leaseToken && !isTerminalRun(run.status))
      return { ok: false as const, stale: true as const };

    const existing = await ctx.db
      .query("seoReports")
      .withIndex("by_report", (q) =>
        q.eq("sourceRunId", a.runId).eq("reportId", a.reportId),
      )
      .unique();
    if (existing) return { ok: true as const, reportId: a.reportId }; // first-committed-wins

    await ctx.db.insert("seoReports", {
      sourceRunId: a.runId, // the run identity (opaque string; getReport is userId-gated)
      reportId: a.reportId,
      // Chat runs link a message/thread; a Phase-6 project run has neither.
      ...(run.inReplyToMessageId
        ? { inReplyToMessageId: run.inReplyToMessageId }
        : {}),
      ...(run.threadId ? { threadId: run.threadId } : {}),
      workspaceId: run.workspaceId,
      userId: run.userId,
      status: a.status,
      target: a.target,
      scope: a.scope,
      methodologyName: a.methodologyName,
      methodologyVersion: a.methodologyVersion,
      generatedAt: a.generatedAt,
      summary: a.summary,
      report: a.report,
      manifest: a.manifest,
      createdAt: Date.now(),
    });
    return { ok: true as const, reportId: a.reportId };
  },
});

// ── Run-owned artifacts (/ai/seo-artifact) ─────────────────────────────────────

/**
 * Store a run's compressed crawl artifact. Owner DERIVED from the run (no stream
 * dependency). Idempotent by (runId, artifactKey): a re-store deletes the dup blob and
 * returns the EXISTING row's contentHash so the caller records the authoritative stored
 * hash (the manifest can never disagree with the bytes). Lease-gated.
 */
export const registerSeoArtifact = internalMutation({
  args: {
    runId: v.string(),
    leaseToken: v.string(),
    stepKey: v.string(),
    artifactKey: v.string(),
    storageId: v.id("_storage"),
    filename: v.string(),
    format: v.string(),
    mime: v.string(),
    size: v.number(),
    rowCount: v.number(),
    contentHash: v.string(),
  },
  handler: async (ctx, a) => {
    const run = await loadRun(ctx, a.runId);
    if (!run) return { ok: false as const, artifactId: null, contentHash: null };
    if (run.leaseToken !== a.leaseToken && !isTerminalRun(run.status))
      return { ok: false as const, artifactId: null, contentHash: null };

    const existing = await ctx.db
      .query("seoArtifacts")
      .withIndex("by_run_key", (q) =>
        q.eq("runId", a.runId).eq("artifactKey", a.artifactKey),
      )
      .unique();
    if (existing) {
      await ctx.storage.delete(a.storageId).catch(() => {});
      return {
        ok: true as const,
        artifactId: existing._id,
        contentHash: existing.contentHash, // authoritative stored hash
      };
    }
    const artifactId = await ctx.db.insert("seoArtifacts", {
      runId: a.runId,
      userId: run.userId,
      workspaceId: run.workspaceId,
      stepKey: a.stepKey,
      storageId: a.storageId,
      artifactKey: a.artifactKey,
      filename: a.filename,
      format: a.format,
      mime: a.mime,
      size: a.size,
      rowCount: a.rowCount,
      contentHash: a.contentHash,
      createdAt: Date.now(),
    });
    return { ok: true as const, artifactId, contentHash: a.contentHash };
  },
});

/** AUTHENTICATED, ownership-enforced download mint (faithful copy of
 *  chatArtifacts.mintDownload — a parity test pins the two together). */
export const mintSeoDownload = mutation({
  args: { artifactId: v.string() },
  handler: async (ctx, { artifactId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");
    const id = ctx.db.normalizeId("seoArtifacts", artifactId);
    const art = id ? await ctx.db.get(id) : null;
    if (!art || art.userId !== userId) throw new ConvexError("Not found");
    const token = crypto.randomUUID() + crypto.randomUUID().slice(0, 8);
    await ctx.db.patch(art._id, {
      downloadToken: token,
      downloadTokenExpiresAt: Date.now() + DOWNLOAD_TTL_MS,
    });
    return { token, filename: art.filename, mime: art.mime };
  },
});

/** INTERNAL — /seo-artifact/file proxy only. Same null for every failure. */
export const resolveSeoDownload = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (!token) return null;
    const art = await ctx.db
      .query("seoArtifacts")
      .withIndex("by_downloadToken", (q) => q.eq("downloadToken", token))
      .unique();
    if (!art || !art.downloadTokenExpiresAt) return null;
    if (art.downloadTokenExpiresAt < Date.now()) return null;
    return { storageId: art.storageId, mime: art.mime, filename: art.filename };
  },
});

// ── Cancellation (every state) ─────────────────────────────────────────────────

/**
 * AUTHENTICATED cancel. queued|retry_wait (no live worker) → cancelled immediately;
 * running → cancelRequested (the worker finalizes on its next flush, ≤ one batch).
 */
export const requestCancel = mutation({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");
    const run = await loadRun(ctx, runId);
    if (!run || run.userId !== userId) throw new ConvexError("Not found");
    if (isTerminalRun(run.status)) return { ok: true };
    const now = Date.now();
    if (run.status === "queued" || run.status === "retry_wait") {
      await ctx.db.patch(run._id, {
        status: "cancelled",
        cancelRequested: true,
        leaseToken: undefined,
        terminalErrorCode: "cancelled",
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(run._id, { cancelRequested: true, updatedAt: now });
    }
    return { ok: true };
  },
});

/** Internal cancel-cascade (thread/message deletion, chat stop). Cancels a live run
 *  so it stops crawling/billing; the artifact GC reclaims its blobs. */
async function cascadeCancel(ctx: MutationCtx, run: Doc<"seoRuns">): Promise<void> {
  if (isTerminalRun(run.status)) return;
  if (run.status === "running") {
    await ctx.db.patch(run._id, { cancelRequested: true, updatedAt: Date.now() });
  } else {
    await finalize(ctx, run, "cancelled", "cancelled");
  }
}

// ── Reaper (all non-terminal states) ───────────────────────────────────────────

async function resumeStalled(ctx: MutationCtx, run: Doc<"seoRuns">): Promise<void> {
  const now = Date.now();
  await ctx.db.patch(run._id, {
    status: "queued",
    attempts: run.attempts + 1, // attempts bump lives ONLY here
    heartbeatAt: now,
    leaseToken: undefined, // rotate: a stale worker's write is now rejected
    updatedAt: now,
    // deadlineAt intentionally UNCHANGED.
  });
  await ctx.scheduler.runAfter(0, internal.seoRuns.dispatchRun, {
    runId: run.runId,
  });
}

export const reapStalledRuns = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - SEO_STALL_MS;
    const stalled: Doc<"seoRuns">[] = [];
    for (const s of ["running", "queued", "retry_wait"] as const) {
      const rows = await ctx.db
        .query("seoRuns")
        .withIndex("by_status_heartbeat", (q) =>
          q.eq("status", s).lt("heartbeatAt", cutoff),
        )
        .take(25);
      stalled.push(...rows);
    }
    let resumed = 0;
    let finalized = 0;
    for (const run of stalled) {
      if (run.cancelRequested) {
        await finalize(ctx, run, "cancelled", "cancelled");
        finalized++;
      } else if (now > run.deadlineAt) {
        await finalize(ctx, run, run.processedCount > 0 ? "partial" : "expired", "deadline");
        finalized++;
      } else if (run.costSpent >= run.costBudget) {
        await finalize(ctx, run, "partial", "budget");
        finalized++;
      } else if (run.attempts >= MAX_RUN_ATTEMPTS) {
        await finalize(ctx, run, run.processedCount > 0 ? "partial" : "failed", "timeout");
        finalized++;
      } else {
        await resumeStalled(ctx, run);
        resumed++;
      }
    }
    return { resumed, finalized };
  },
});

/** Cron: reclaim compressed artifact blobs of ABANDONED terminal runs (a crashed run
 *  never reaches finalize cleanup). Self-bounded per tick. */
export const gcTerminalArtifacts = internalMutation({
  args: {},
  handler: async (ctx) => {
    let reclaimed = 0;
    for (const s of ["failed", "cancelled", "expired"] as const) {
      const runs = await ctx.db
        .query("seoRuns")
        .withIndex("by_status_heartbeat", (q) => q.eq("status", s))
        .take(10);
      for (const run of runs) {
        const arts = await ctx.db
          .query("seoArtifacts")
          .withIndex("by_run", (q) => q.eq("runId", run.runId))
          .take(DELETE_BATCH);
        for (const art of arts) {
          await ctx.storage.delete(art.storageId).catch(() => {});
          await ctx.db.delete(art._id);
          reclaimed++;
        }
      }
    }
    return { reclaimed };
  },
});

// ── Surfacing (reactive, userId-gated) ─────────────────────────────────────────

function publicRun(run: Doc<"seoRuns">) {
  // Only the findings COUNT is surfaced here (a small number the progress card shows),
  // NOT the full bounded findings blob — this query re-fires on every progress write, so
  // returning ~600KB per tick would flood every subscriber. The full report comes from
  // getReport at completion. Never a lease token or storageId.
  let findingsCount = 0;
  if (run.summary) {
    try {
      const parsed = JSON.parse(run.summary) as { findings?: unknown };
      if (Array.isArray(parsed.findings)) findingsCount = parsed.findings.length;
    } catch {
      findingsCount = 0;
    }
  }
  return {
    runId: run.runId,
    status: run.status,
    target: run.target,
    scope: run.scope,
    processedCount: run.processedCount,
    maxUrls: run.maxUrls,
    costSpent: run.costSpent,
    costBudget: run.costBudget,
    cancelRequested: run.cancelRequested,
    reportId: run.reportId ?? null,
    terminalErrorCode: run.terminalErrorCode ?? null,
    findingsCount,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

/** The SeoRunCard's reactive surface. Bounded read (the run row only — the aggregate
 *  is materialised, so this never sums step rows). Returns null (never throws) for
 *  signed-out / missing / not-owner — like stream.active, so a live subscription can
 *  never emit a console.error (the e2e zero-console gate) and it is no existence oracle. */
export const getRun = query({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const run = await loadRun(ctx, runId);
    if (!run || run.userId !== userId) return null;
    return publicRun(run);
  },
});

/** Surfacing fallback: runs a user can still act on even when the seo_run event was
 *  purged (chat Stop deletes the event carrying the runId). userId-gated. */
export const listActiveRuns = query({
  args: { threadId: v.optional(v.string()) },
  handler: async (ctx, { threadId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const out: ReturnType<typeof publicRun>[] = [];
    for (const s of ["queued", "retry_wait", "running"] as const) {
      const rows = await ctx.db
        .query("seoRuns")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", userId).eq("status", s),
        )
        .take(25);
      for (const r of rows) {
        if (threadId && r.threadId !== threadId) continue;
        out.push(publicRun(r));
      }
    }
    return out;
  },
});

// ── Cascade reclamation (thread purge / message delete / chat stop) ─────────────

/** Cancel + delete a bounded batch of runs (and their steps + artifact blobs) for a
 *  thread. Returns the count purged so the thread-purge fan-out can reschedule. */
export async function deleteSeoRunsForThread(
  ctx: MutationCtx,
  threadId: Id<"chatThreads">,
): Promise<number> {
  const runs = await ctx.db
    .query("seoRuns")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .take(SEO_RUN_PURGE_BATCH);
  for (const run of runs) await purgeRun(ctx, run);
  return runs.length;
}

/** Cancel + delete every run tied to one (assistant) message — the regenerate/edit/
 *  stop tail-purge path. */
export async function deleteSeoRunsForMessage(
  ctx: MutationCtx,
  messageId: Id<"chatMessages">,
): Promise<void> {
  const runs = await ctx.db
    .query("seoRuns")
    .withIndex("by_message", (q) => q.eq("inReplyToMessageId", messageId))
    .take(DELETE_BATCH);
  for (const run of runs) await purgeRun(ctx, run);
}

/** Cancel a live run tied to a message WITHOUT deleting it (chat Stop keeps the run
 *  visible via listActiveRuns, but it must stop crawling/billing). */
export async function cancelSeoRunsForMessage(
  ctx: MutationCtx,
  messageId: Id<"chatMessages">,
): Promise<void> {
  const runs = await ctx.db
    .query("seoRuns")
    .withIndex("by_message", (q) => q.eq("inReplyToMessageId", messageId))
    .take(DELETE_BATCH);
  for (const run of runs) await cascadeCancel(ctx, run);
}

async function purgeRun(ctx: MutationCtx, run: Doc<"seoRuns">): Promise<void> {
  await cascadeCancel(ctx, run);
  const arts = await ctx.db
    .query("seoArtifacts")
    .withIndex("by_run", (q) => q.eq("runId", run.runId))
    .collect();
  for (const art of arts) {
    await ctx.storage.delete(art.storageId).catch(() => {});
    await ctx.db.delete(art._id);
  }
  const steps = await ctx.db
    .query("seoRunSteps")
    .withIndex("by_run_step", (q) => q.eq("runId", run.runId))
    .collect();
  for (const st of steps) await ctx.db.delete(st._id);
  // Phase 6: the run's report + its diff. Chat runs also reclaim the report via the
  // message/thread cascade; a project run has neither, so reclaim by runId here.
  const reports = await ctx.db
    .query("seoReports")
    .withIndex("by_report", (q) => q.eq("sourceRunId", run.runId))
    .collect();
  for (const r of reports) await ctx.db.delete(r._id);
  const diffs = await ctx.db
    .query("seoRunDiffs")
    .withIndex("by_run", (q) => q.eq("runId", run.runId))
    .collect();
  for (const d of diffs) await ctx.db.delete(d._id);
  await ctx.db.delete(run._id);
}

/** Phase 6 — cancel + delete a bounded batch of a project's runs (+ steps / artifact
 *  blobs / reports / diffs). Returns the count so the project-delete fan-out reschedules. */
export async function deleteSeoRunsForProject(
  ctx: MutationCtx,
  projectId: Id<"seoProjects">,
): Promise<number> {
  const runs = await ctx.db
    .query("seoRuns")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(SEO_RUN_PURGE_BATCH);
  for (const run of runs) await purgeRun(ctx, run);
  return runs.length;
}

/** Phase 6 — purge runs older than a keep-set for retention (never the baseline). Used by
 *  the retention cron; returns the count purged. `keepRunIds` are always preserved. */
export async function purgeOldProjectRuns(
  ctx: MutationCtx,
  projectId: Id<"seoProjects">,
  keepRunIds: Set<string>,
  olderThan: number,
): Promise<number> {
  const runs = await ctx.db
    .query("seoRuns")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  let purged = 0;
  for (const run of runs) {
    if (keepRunIds.has(run.runId)) continue;
    if (run.createdAt >= olderThan) continue;
    if (!isTerminalRun(run.status)) continue; // never purge an in-flight run
    await purgeRun(ctx, run);
    purged++;
    if (purged >= SEO_RUN_PURGE_BATCH) break;
  }
  return purged;
}
