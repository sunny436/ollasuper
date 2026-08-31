import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { assertAllowedModel, DEFAULT_MODEL } from "../chat/authz";
import { startAssistantTurn } from "../chat/messages";
import { isTerminal as isStreamTerminal } from "../chat/stream";
import { recordUsage } from "../usage";
import { ownerEntitlementFailure } from "./authz";
import { isTerminal as isOccurrenceTerminal } from "./schedule";

/**
 * Phase 2 — the bridge from a durable occurrence to a real AI turn.
 *
 * There is deliberately NO second execution path here. This module creates a
 * chat turn and hands it to `startAssistantTurn`, the same function `send`,
 * `regenerate`, `retry` and `editUserMessage` use, which schedules
 * `chat.stream.dispatch` -> POST /v1/generate. Everything downstream — the
 * LangGraph runner, the orchestrator, skills, tool policy, the Ollagraph
 * adapter, artifacts, the typed event log, the stall reaper and crash-resume —
 * is inherited unchanged.
 *
 * Reached only from http.ts `/ai/ingress` (AI_INGRESS_SECRET verified) and
 * lease-guarded on every op, exactly like the Phase 1 occurrence mutations.
 */

async function loadOccurrence(
  ctx: QueryCtx,
  key: string,
): Promise<Doc<"scheduledTaskOccurrences"> | null> {
  return await ctx.db
    .query("scheduledTaskOccurrences")
    .withIndex("by_occurrence_key", (q) => q.eq("occurrenceKey", key))
    .unique();
}

async function loadStream(
  ctx: QueryCtx,
  streamId: string,
): Promise<Doc<"chatStreams"> | null> {
  return await ctx.db
    .query("chatStreams")
    .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
    .unique();
}

type Guarded =
  | { ok: false; reason: Record<string, unknown> }
  | { ok: true; occurrence: Doc<"scheduledTaskOccurrences"> };

/** The shared lease/terminal/cancel gate every op below starts with. */
async function guard(
  ctx: QueryCtx,
  occurrenceKey: string,
  leaseToken: string,
): Promise<Guarded> {
  const occurrence = await loadOccurrence(ctx, occurrenceKey);
  if (!occurrence) {
    return { ok: false, reason: { ok: false, unknown: true, cancel: true } };
  }
  if (occurrence.leaseToken !== leaseToken) {
    return { ok: false, reason: { ok: false, stale: true, cancel: true } };
  }
  if (isOccurrenceTerminal(occurrence.status)) {
    return { ok: false, reason: { ok: false, stale: true, cancel: true } };
  }
  return { ok: true, occurrence };
}

/**
 * The dedicated execution thread for one task.
 *
 * SELF-HEALING on purpose: nothing stops the owner trashing this thread, and
 * `purgeTrashed` hard-deletes a trashed thread after the retention TTL. Rather
 * than guarding four more chat mutations, a missing or no-longer-`scheduled`
 * thread is simply replaced here.
 *
 * `titleSource: "user"` is load-bearing — it makes dispatchPayload's
 * `titleNeeded` false, so the auto-titler never renames a scheduled thread
 * away from its task title.
 */
async function ensureThread(
  ctx: MutationCtx,
  task: Doc<"scheduledTasks">,
): Promise<Doc<"chatThreads">> {
  const existing = task.executionThreadId
    ? await ctx.db.get(task.executionThreadId)
    : null;
  if (existing && existing.status === "scheduled") return existing;

  const now = Date.now();
  const threadId = await ctx.db.insert("chatThreads", {
    workspaceId: task.workspaceId,
    userId: task.userId,
    title: task.title,
    titleSource: "user",
    // NOT "active": the status is what excludes this thread from threads.list,
    // listPinned and both search paths, all of which pin an equality on status.
    status: "scheduled",
    scheduledTaskId: task._id,
    pinned: false,
    model: DEFAULT_MODEL,
    nextSeq: 0,
    messageCount: 0,
    tokensIn: 0,
    tokensOut: 0,
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(task._id, {
    executionThreadId: threadId,
    updatedAt: now,
  });
  const created = await ctx.db.get(threadId);
  if (!created) throw new Error("thread insert vanished");
  return created;
}

// ── ingress op: sched-start-run ──────────────────────────────────────────────
/**
 * Start (or resume, or retry) the AI turn for one occurrence.
 *
 * Three paths, and picking the right one is the whole correctness story:
 *
 *  RESUME  the occurrence already has a live stream (a DBOS-recovered workflow
 *          re-entering execute). Start nothing; just report it so the caller
 *          resumes polling. This is what makes replay safe.
 *  RETRY   the previous stream is terminal. REUSE the assistant messageId and
 *          seed `attempts` > 0. toolExecutions and chatStreamEvents are keyed
 *          by_message, so this is what makes dispatchPayload set
 *          `doResume` and replay completed + indeterminate tools instead of
 *          RE-EXECUTING them. Creating a fresh message here would silently run
 *          every side-effecting tool a second time.
 *  START   first attempt: a user message carrying the PINNED REVISION prompt,
 *          then a fresh assistant turn.
 */
export const startRun = internalMutation({
  args: {
    occurrenceKey: v.string(),
    leaseToken: v.string(),
    deadlineMs: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const g = await guard(ctx, a.occurrenceKey, a.leaseToken);
    if (!g.ok) return g.reason;
    const occ = g.occurrence;
    if (occ.cancelRequested) return { ok: true, cancel: true };

    const task = await ctx.db.get(occ.taskId);
    if (!task || task.status === "deleted") {
      return { ok: false, unknown: true, cancel: true };
    }

    // Defence in depth. `claim` already checked, but a suspension between claim
    // and start must never execute under stale authorization.
    const entitlement = await ownerEntitlementFailure(ctx, task);
    if (entitlement) {
      return { ok: false, entitlement, cancel: true };
    }

    // The occurrence executes the revision it was CREATED under — never the
    // task's current prompt.
    const revision = await ctx.db.get(occ.revisionId);
    if (!revision) {
      return { ok: false, invalidReason: "revision_missing", cancel: true };
    }

    const now = Date.now();

    // ── RESUME ───────────────────────────────────────────────────────────────
    if (occ.streamId) {
      const stream = await loadStream(ctx, occ.streamId);
      if (stream && !isStreamTerminal(stream.status)) {
        return {
          ok: true,
          resumed: true,
          streamId: occ.streamId,
          messageId: occ.messageId ?? null,
        };
      }
    }

    const thread = await ensureThread(ctx, task);
    // Another turn is mid-flight on this thread and it is not ours. Phase 1
    // serialisation makes this near-impossible; treat it as transient rather
    // than starting a second concurrent turn.
    if (
      thread.streamingMessageId &&
      thread.streamingMessageId !== occ.messageId
    ) {
      return { ok: false, busy: true };
    }

    const model = await assertAllowedModel(ctx, thread.model);

    // ── RETRY ────────────────────────────────────────────────────────────────
    const previous = occ.messageId ? await ctx.db.get(occ.messageId) : null;
    if (previous) {
      const { streamId } = await startAssistantTurn(ctx, thread, occ.userId, {
        seq: previous.seq,
        model,
        reuseMessageId: previous._id,
        deadlineMs: a.deadlineMs,
        // > 0 => dispatchPayload sets doResume => completed/indeterminate tools
        // are replayed, NOT re-executed.
        attempts: Math.max(1, occ.attempts),
      });
      await ctx.db.patch(occ._id, {
        threadId: thread._id,
        streamId,
        updatedAt: now,
      });
      return {
        ok: true,
        retried: true,
        streamId,
        messageId: previous._id,
        attempt: Math.max(1, occ.attempts),
      };
    }

    // ── START ────────────────────────────────────────────────────────────────
    const userSeq = thread.nextSeq;
    const assistantSeq = userSeq + 1;
    await ctx.db.insert("chatMessages", {
      threadId: thread._id,
      workspaceId: thread.workspaceId,
      userId: occ.userId,
      role: "user",
      seq: userSeq,
      content: revision.prompt,
      status: "complete",
      // The occurrence key doubles as the send-idempotency marker, mirroring
      // how `send` uses the browser's clientId.
      clientId: occ.occurrenceKey,
      variantCount: 1,
      activeVariantIndex: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(thread._id, {
      nextSeq: assistantSeq + 1,
      messageCount: thread.messageCount + 2,
      lastMessageAt: now,
      model,
      updatedAt: now,
    });

    const { assistantMessageId, streamId } = await startAssistantTurn(
      ctx,
      { ...thread, model },
      occ.userId,
      {
        seq: assistantSeq,
        model,
        variantIndex: 0,
        deadlineMs: a.deadlineMs,
        attempts: 0,
      },
    );

    await ctx.db.patch(occ._id, {
      threadId: thread._id,
      messageId: assistantMessageId,
      streamId,
      updatedAt: now,
    });
    // Usage IS recorded (a scheduled run really does consume). The `counters`
    // bump is deliberately NOT called: that feeds a user-visible conversation
    // count, and these messages live in a hidden thread.
    await recordUsage(ctx, thread.workspaceId, "chat.messages");
    return { ok: true, started: true, streamId, messageId: assistantMessageId };
  },
});

// ── ingress op: sched-run-status ─────────────────────────────────────────────
/**
 * Poll one occurrence's turn. Returns the stream AND message view because
 * `failStream` records the terminal error on the message while the stream
 * carries the lifecycle state.
 */
export const runStatus = internalMutation({
  args: { occurrenceKey: v.string(), leaseToken: v.string() },
  handler: async (ctx, a) => {
    const g = await guard(ctx, a.occurrenceKey, a.leaseToken);
    if (!g.ok) return g.reason;
    const occ = g.occurrence;
    if (!occ.streamId) return { ok: true, missing: true };

    const stream = await loadStream(ctx, occ.streamId);
    if (!stream) return { ok: true, missing: true };
    const message = occ.messageId ? await ctx.db.get(occ.messageId) : null;

    return {
      ok: true,
      streamStatus: stream.status,
      terminal: isStreamTerminal(stream.status),
      cancelRequested: occ.cancelRequested || stream.cancelRequested,
      messageStatus: message?.status ?? null,
      errorCode: message?.errorCode ?? null,
      error: message?.error ?? null,
      textLength: message?.content.length ?? 0,
    };
  },
});

// ── ingress op: sched-cancel-run ─────────────────────────────────────────────
/**
 * Ask the running turn to stop.
 *
 * Convex cannot push to Python, so this sets the same durable flag the Stop
 * button uses: every ingress response (delta / heartbeat / event) carries
 * `{cancel: stream.cancelRequested}`, so the worker sees it within one flush.
 * If the worker is already dead, chat's own stall reaper finalizes it.
 */
export const cancelRun = internalMutation({
  args: { occurrenceKey: v.string(), leaseToken: v.string() },
  handler: async (ctx, a) => {
    const occ = await loadOccurrence(ctx, a.occurrenceKey);
    if (!occ) return { ok: false, unknown: true };
    if (occ.leaseToken !== a.leaseToken) return { ok: false, stale: true };
    if (!occ.streamId) return { ok: true, requested: false };

    const stream = await loadStream(ctx, occ.streamId);
    if (!stream || isStreamTerminal(stream.status)) {
      return { ok: true, requested: false };
    }
    // chatStreams has no updatedAt — the flag alone is the signal.
    await ctx.db.patch(stream._id, { cancelRequested: true });
    return { ok: true, requested: true };
  },
});

/** Cascade helper — used by tests and by any future account-deletion path. */
export async function executionThreadIdsForUser(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Id<"chatThreads">[]> {
  const tasks = await ctx.db
    .query("scheduledTasks")
    .withIndex("by_user_updated", (q) => q.eq("userId", userId))
    .take(500);
  return tasks
    .map((t) => t.executionThreadId)
    .filter((id): id is Id<"chatThreads"> => id !== undefined);
}
