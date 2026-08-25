import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";

/**
 * Phase 3 — the durable per-execution record (crash-recovery authority).
 *
 * Called only from http.ts (`op:"execution"`), which has verified the ingress
 * secret. Idempotent UPSERT by (streamId, executionId): the write-ahead writes
 * this table and resume READS this table, so "persisted before the side effect"
 * and "readable by resume" are the same fact (no split-brain).
 */

async function loadStream(
  ctx: MutationCtx,
  streamId: string,
): Promise<Doc<"chatStreams"> | null> {
  return await ctx.db
    .query("chatStreams")
    .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
    .unique();
}

function isTerminal(status: string): boolean {
  return status === "done" || status === "error" || status === "aborted";
}

// MIRRORS services/ai/app/models/execution.py `_TRANSITIONS` — keep BOTH in sync.
// An illegal transition is kept + logged, never crashed (defensive).
const LEGAL_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending: new Set(["running", "waiting_approval", "cancelled", "deduped", "failed"]),
  running: new Set(["succeeded", "failed", "timed_out", "indeterminate", "cancelled"]),
  waiting_approval: new Set(["running", "failed", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  timed_out: new Set(),
  indeterminate: new Set(),
  deduped: new Set(),
};

const stateValidator = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("waiting_approval"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("timed_out"),
  v.literal("indeterminate"),
  v.literal("deduped"),
);

export const upsertExecution = internalMutation({
  args: {
    streamId: v.string(),
    executionId: v.string(),
    stepId: v.string(),
    toolCallId: v.string(),
    toolId: v.string(),
    attemptId: v.string(),
    attempt: v.number(),
    actionType: v.string(),
    sideEffect: v.string(),
    state: stateValidator,
    inputHash: v.string(),
    args: v.optional(v.any()),
    resultContent: v.optional(v.string()),
    error: v.optional(v.string()),
    approvalRef: v.optional(v.string()),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const stream = await loadStream(ctx, a.streamId);
    // Write-ahead abort semantics (identical to appendEvent): a dead / parked
    // stream must never accept a fresh side-effecting intent. `persisted:false`
    // makes the executor's dual gate abort a side-effecting call.
    if (!stream)
      return { ok: false, cancel: true, unknown: true, persisted: false };
    if (isTerminal(stream.status))
      return { ok: true, cancel: true, persisted: false };
    if (stream.status === "waiting_approval")
      return { ok: true, cancel: true, persisted: false };

    const now = Date.now();
    const existing = await ctx.db
      .query("toolExecutions")
      .withIndex("by_stream_execution", (q) =>
        q.eq("streamId", a.streamId).eq("executionId", a.executionId),
      )
      .unique();

    if (!existing) {
      await ctx.db.insert("toolExecutions", {
        executionId: a.executionId,
        streamId: a.streamId,
        messageId: stream.messageId,
        threadId: stream.threadId,
        workspaceId: stream.workspaceId,
        userId: stream.userId,
        stepId: a.stepId,
        toolCallId: a.toolCallId,
        toolId: a.toolId,
        attemptId: a.attemptId,
        attempt: a.attempt,
        actionType: a.actionType,
        sideEffect: a.sideEffect,
        state: a.state,
        inputHash: a.inputHash,
        args: a.args,
        resultContent: a.resultContent,
        error: a.error,
        approvalRef: a.approvalRef,
        createdAt: a.createdAt,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        updatedAt: now,
      });
      return { ok: true, cancel: stream.cancelRequested, persisted: true };
    }

    // Idempotent re-record of the same state (e.g. a resume re-record): no write,
    // still durable — `persisted:true` means "the intent IS recorded."
    if (existing.state === a.state) {
      return { ok: true, cancel: stream.cancelRequested, persisted: true };
    }
    // Legal forward transition → patch only the provided fields.
    if (LEGAL_TRANSITIONS[existing.state]?.has(a.state)) {
      await ctx.db.patch(existing._id, {
        state: a.state,
        attempt: a.attempt,
        attemptId: a.attemptId,
        updatedAt: now,
        ...(a.args !== undefined ? { args: a.args } : {}),
        ...(a.resultContent !== undefined
          ? { resultContent: a.resultContent }
          : {}),
        ...(a.error !== undefined ? { error: a.error } : {}),
        ...(a.approvalRef !== undefined ? { approvalRef: a.approvalRef } : {}),
        ...(a.startedAt !== undefined ? { startedAt: a.startedAt } : {}),
        ...(a.endedAt !== undefined ? { endedAt: a.endedAt } : {}),
      });
      return { ok: true, cancel: stream.cancelRequested, persisted: true };
    }
    // Illegal transition (e.g. terminal → anything): keep the row + log. Never
    // crash — a bookkeeping mis-sequence must not fail a live turn.
    console.warn("toolExecutions.illegal_transition", {
      from: existing.state,
      to: a.state,
    });
    return { ok: true, cancel: stream.cancelRequested, persisted: true };
  },
});

/** Delete every execution row for a message. Mirrors deleteEvents — called at
 *  terminal finalize (finishStream / finalizeError / stop); NOT on suspend or
 *  reaper-resume (the rows are the durable checkpoint). */
export async function deleteExecutions(
  ctx: MutationCtx,
  messageId: Id<"chatMessages">,
): Promise<void> {
  const rows = await ctx.db
    .query("toolExecutions")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}
