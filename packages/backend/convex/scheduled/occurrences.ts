import { v } from "convex/values";
import { consumeWindow } from "../quotas";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { notify } from "../notifications";
import { DEFAULT_MODEL } from "../chat/authz";
import { ownerEntitlementFailure } from "./authz";
import { enqueueDelivery } from "./delivery";
import { canTransition, isTerminal, occurrenceKey } from "./schedule";

/**
 * The durable occurrence state machine (Phase 1).
 *
 * Reached ONLY from http.ts `/ai/ingress` (which has already verified
 * AI_INGRESS_SECRET) and from the crons.ts reaper. Nothing here is public.
 *
 * Every op is idempotent and lease-guarded, and every op answers with the house
 * `{ok, stale, cancel, unknown}` envelope rather than a 404, so a transient
 * Convex blip is retried by the Python client instead of being treated as
 * "gone" (the same contract chat/ingest.ts uses).
 */

/** A holder must prove liveness at least this often or the reaper takes over. */
export const LEASE_TTL_MS = 300_000;
/** Dispatch attempts per occurrence. NOT DBOS step retries — see finalize(). */
export const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30_000;
/** Bound on one claim pass's index scan. */
const CANDIDATE_SCAN = 200;

function backoffMs(attempts: number): number {
  // 30s, 60s, 120s … bounded by MAX_ATTEMPTS anyway.
  return RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
}

async function loadByKey(
  ctx: QueryCtx,
  key: string,
): Promise<Doc<"scheduledTaskOccurrences"> | null> {
  return await ctx.db
    .query("scheduledTaskOccurrences")
    .withIndex("by_occurrence_key", (q) => q.eq("occurrenceKey", key))
    .unique();
}

type OccurrencePatch = Partial<Doc<"scheduledTaskOccurrences">>;

/**
 * Guarded transition. An illegal transition is REFUSED and reported, never
 * applied — mirroring chat/executions.ts, which keeps its state machine honest
 * across the same TS/Python boundary.
 */
async function transition(
  ctx: MutationCtx,
  occ: Doc<"scheduledTaskOccurrences">,
  next: Doc<"scheduledTaskOccurrences">["status"],
  patch: OccurrencePatch = {},
): Promise<boolean> {
  const now = Date.now();
  if (occ.status === next) {
    await ctx.db.patch(occ._id, { ...patch, updatedAt: now });
    return true;
  }
  if (!canTransition(occ.status, next)) return false;
  await ctx.db.patch(occ._id, { ...patch, status: next, updatedAt: now });
  return true;
}

/** Occurrences that have not reached a terminal state yet. */
async function openForTask(
  ctx: QueryCtx,
  taskId: Id<"scheduledTasks">,
): Promise<Doc<"scheduledTaskOccurrences">[]> {
  const rows = await ctx.db
    .query("scheduledTaskOccurrences")
    .withIndex("by_task_scheduled", (q) => q.eq("taskId", taskId))
    .order("desc")
    .take(500);
  return rows.filter((o) => !isTerminal(o.status));
}

/**
 * Pause: already-created work is SUPPRESSED, never discarded. A `running`
 * occurrence is deliberately left alone — killing a half-finished execution is
 * more destructive than letting it complete, and pause is about future work.
 */
export async function holdOpenForTask(
  ctx: MutationCtx,
  taskId: Id<"scheduledTasks">,
): Promise<number> {
  let held = 0;
  for (const occ of await openForTask(ctx, taskId)) {
    if (occ.status === "queued" || occ.status === "retrying") {
      if (await transition(ctx, occ, "held", { leaseToken: undefined })) held++;
    }
  }
  return held;
}

/** Resume: held work becomes runnable again. It was never lost. */
export async function releaseHeldForTask(
  ctx: MutationCtx,
  taskId: Id<"scheduledTasks">,
): Promise<number> {
  let released = 0;
  for (const occ of await openForTask(ctx, taskId)) {
    if (occ.status === "held") {
      if (await transition(ctx, occ, "queued", { nextAttemptAt: undefined })) {
        released++;
      }
    }
  }
  return released;
}

/**
 * Delete: a soft-deleted task must stop executing. Anything not yet started is
 * cancelled outright; a running occurrence gets `cancelRequested`, which the
 * worker observes on its next heartbeat — Convex cannot push to Python, which
 * is exactly how the chat stop button works.
 */
export async function cancelOpenForTask(
  ctx: MutationCtx,
  taskId: Id<"scheduledTasks">,
  reason: string,
): Promise<void> {
  const now = Date.now();
  for (const occ of await openForTask(ctx, taskId)) {
    if (occ.status === "running") {
      await ctx.db.patch(occ._id, { cancelRequested: true, updatedAt: now });
      continue;
    }
    await transition(ctx, occ, "cancelled", {
      cancelRequested: true,
      finishedAt: now,
      terminalReason: reason,
      leaseToken: undefined,
    });
  }
}

// ── ingress op: sched-list ───────────────────────────────────────────────────
/**
 * The scheduler's work list. Returns SCHEDULE data only — never the task's
 * prompt or title. That keeps AI_INGRESS_SECRET's blast radius equal to the
 * existing stream-scoped ops instead of making it a cross-user read capability
 * over everyone's standing prompts.
 */
export const listSchedulable = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const cap = Math.min(Math.max(limit ?? 100, 1), 500);
    const active = await ctx.db
      .query("scheduledTasks")
      .withIndex("by_status_cursor", (q) => q.eq("status", "active"))
      .order("asc")
      .take(cap);
    // Paused tasks are still materialised — up to their pausedAt — so an
    // occurrence that came due BEFORE the pause is not lost. Nothing after
    // pausedAt is ever enumerated, which is what makes suppression exact.
    const paused = await ctx.db
      .query("scheduledTasks")
      .withIndex("by_status_cursor", (q) => q.eq("status", "paused"))
      .order("asc")
      .take(cap);
    const rows = [...active, ...paused]
      .sort((a, b) => a.cursorAt - b.cursorAt)
      .slice(0, cap);
    return {
      truncated: active.length >= cap || paused.length >= cap,
      tasks: rows.map((t) => ({
        taskId: t._id,
        status: t.status,
        spec: t.spec,
        cursorAt: t.cursorAt,
        pausedAt: t.pausedAt ?? null,
        revision: t.revision,
      })),
    };
  },
});

// ── ingress op: sched-materialize ────────────────────────────────────────────
/**
 * Turn computed instants into durable rows, then advance the cursor.
 *
 * `fromCursor` is a COMPARE-AND-SWAP: if the task's cursor moved since the
 * caller read it, nothing is written. Without this two overlapping ticks could
 * both advance the cursor and permanently skip the occurrences in between —
 * silent loss, the one thing this system may never do.
 */
export const materialize = internalMutation({
  args: {
    // v.string() + normalizeId, never v.id(): Python echoes back an id that may
    // have been deleted between the list and the materialise. A v.id() would
    // raise ArgumentValidationError (a 500 on the ingress) instead of the
    // orderly {unknown:true} this contract promises. Same rule as threadId.
    taskId: v.string(),
    fromCursor: v.number(),
    toCursor: v.number(),
    scheduledFor: v.array(v.number()),
    nextRunAt: v.optional(v.number()),
    // Set when Python cannot resolve the spec at all (e.g. an IANA zone this
    // build's tzdata does not know). The cursor is NOT advanced in that case.
    invalidReason: v.optional(v.string()),
    // Phase 3 "End repeat": the enumerator can produce nothing further, so the
    // task closes itself. Never sent for a chunked pass, which still has
    // instants to emit.
    scheduleEnded: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    const taskId = ctx.db.normalizeId("scheduledTasks", a.taskId);
    if (!taskId) return { ok: true, unknown: true, created: 0 };
    const task = await ctx.db.get(taskId);
    if (!task || task.status === "deleted" || task.status === "completed") {
      return { ok: true, unknown: true, created: 0 };
    }
    const now = Date.now();
    if (a.invalidReason) {
      await ctx.db.patch(taskId, {
        invalidReason: a.invalidReason,
        updatedAt: now,
      });
      return { ok: true, invalid: true, created: 0 };
    }
    if (task.cursorAt !== a.fromCursor) {
      return { ok: true, stale: true, created: 0 };
    }

    let created = 0;
    for (const scheduledFor of a.scheduledFor) {
      const key = occurrenceKey(taskId, "scheduled", scheduledFor);
      if (await loadByKey(ctx, key)) continue; // idempotent re-materialise
      if (!task.currentRevisionId) continue; // unreachable; create() sets it
      await ctx.db.insert("scheduledTaskOccurrences", {
        occurrenceKey: key,
        taskId,
        userId: task.userId,
        workspaceId: task.workspaceId,
        revisionId: task.currentRevisionId,
        revision: task.revision,
        scheduledFor,
        kind: "scheduled",
        // Born HELD when the task is paused: durable, visible, and not run.
        status: task.status === "paused" ? "held" : "queued",
        attempts: 0,
        cancelRequested: false,
        createdAt: now,
        updatedAt: now,
      });
      created++;
    }

    await ctx.db.patch(taskId, {
      cursorAt: a.toCursor,
      nextRunAt: a.nextRunAt,
      invalidReason: undefined,
      updatedAt: now,
    });

    // "End repeat" reached. Reuses the SAME completion shape as a finished
    // one-time task rather than adding a lifecycle state — and only once every
    // occurrence it already owed has reached a terminal state, so work created
    // before the end date still runs.
    if (a.scheduleEnded && task.status === "active") {
      const open = await openForTask(ctx, taskId);
      if (open.length === 0) {
        await ctx.db.patch(taskId, {
          status: "completed",
          terminalReason: "schedule_ended",
          nextRunAt: undefined,
          updatedAt: now,
        });
      }
    }
    return { ok: true, created };
  },
});

/**
 * Phase 4: the scheduled-execution budget.
 *
 * A FOURTH fixed window on the same `chatSettings` row that already carries the
 * chat, SEO-run and parse windows — same shape, same index, one more read on a
 * path that was already loading nothing.
 *
 * Deliberately separate from `rateWindow*`. Unattended work must not be able to
 * spend a user's interactive allowance (they would find chat throttled by a
 * background job they had forgotten about), and an exhausted scheduled window
 * must not block chat either. Before this, scheduled runs consumed NO budget at
 * all: execution.ts calls startAssistantTurn directly and so never reached
 * chat's assertCanGenerate.
 *
 * Returns false when the window is spent; the caller leaves the occurrence
 * queued rather than failing it.
 */
export const SCHED_RUNS_PER_HOUR = 60;
const SCHED_WINDOW_MS = 60 * 60 * 1000;

async function underScheduledRateLimit(
  ctx: MutationCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
): Promise<boolean> {
  // Per USER, not per workspace — see convex/quotas.ts. Unattended work still
  // gets its own budget so it can never spend the interactive allowance.
  void workspaceId;
  const res = await consumeWindow(
    ctx,
    userId,
    "schedRun",
    SCHED_RUNS_PER_HOUR,
    SCHED_WINDOW_MS,
  );
  return res.ok;
}

// ── ingress op: sched-claim ──────────────────────────────────────────────────
/**
 * Hand out at most one occurrence per task, oldest first.
 *
 * This mutation — not DBOS — is the AUTHORITY for same-task serialisation:
 * Convex mutations are serialisable, so "does this task already have a running
 * occurrence?" cannot race. DBOS's partitioned queue is defence in depth.
 *
 * Anything not claimed because of capacity stays QUEUED. Nothing is ever
 * skipped or dropped for being busy.
 */
export const claim = internalMutation({
  args: { limit: v.number(), maxPerUser: v.number() },
  handler: async (ctx, a) => {
    const now = Date.now();
    const limit = Math.min(Math.max(a.limit, 1), 50);
    const maxPerUser = Math.max(a.maxPerUser, 1);

    const queued = await ctx.db
      .query("scheduledTaskOccurrences")
      .withIndex("by_status_scheduled", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(CANDIDATE_SCAN);
    const retrying = await ctx.db
      .query("scheduledTaskOccurrences")
      .withIndex("by_status_scheduled", (q) => q.eq("status", "retrying"))
      .order("asc")
      .take(CANDIDATE_SCAN);

    const candidates = [
      ...queued,
      ...retrying.filter((o) => (o.nextAttemptAt ?? 0) <= now),
    ].sort((x, y) => x.scheduledFor - y.scheduledFor);

    const claims: Array<{
      occurrenceKey: string;
      taskId: Id<"scheduledTasks">;
      revision: number;
      scheduledFor: number;
      kind: string;
      attempts: number;
      leaseToken: string;
    }> = [];
    const busyTasks = new Set<string>();
    const runningPerUser = new Map<string, number>();

    for (const occ of candidates) {
      if (claims.length >= limit) break;
      if (busyTasks.has(occ.taskId)) continue;

      if (occ.cancelRequested) {
        await transition(ctx, occ, "cancelled", {
          finishedAt: now,
          terminalReason: "cancelled_before_start",
          leaseToken: undefined,
        });
        continue;
      }

      const task = await ctx.db.get(occ.taskId);
      if (!task || task.status === "deleted") {
        await transition(ctx, occ, "cancelled", {
          finishedAt: now,
          terminalReason: "task_deleted",
          leaseToken: undefined,
        });
        continue;
      }
      if (task.status === "paused") {
        await transition(ctx, occ, "held", { leaseToken: undefined });
        continue;
      }

      // The owner may have been suspended or removed from the workspace since
      // this task was created. Nothing in orgs/account-status knows about
      // scheduled work, so this is the only place that check can happen.
      const failure = await ownerEntitlementFailure(ctx, task);
      if (failure) {
        await transition(ctx, occ, "cancelled", {
          finishedAt: now,
          terminalReason: failure,
          leaseToken: undefined,
        });
        await ctx.db.patch(task._id, {
          status: "paused",
          pausedAt: now,
          invalidReason: failure,
          updatedAt: now,
        });
        busyTasks.add(occ.taskId);
        continue;
      }

      // Same-task serialisation: one running occurrence per task, ever.
      const running = await ctx.db
        .query("scheduledTaskOccurrences")
        .withIndex("by_task_status_scheduled", (q) =>
          q.eq("taskId", occ.taskId).eq("status", "running"),
        )
        .first();
      if (running) {
        busyTasks.add(occ.taskId); // stays QUEUED — never skipped
        continue;
      }

      // Per-user capacity. Over the cap the occurrence stays QUEUED too.
      let userRunning = runningPerUser.get(occ.userId);
      if (userRunning === undefined) {
        const rows = await ctx.db
          .query("scheduledTaskOccurrences")
          .withIndex("by_user_status", (q) =>
            q.eq("userId", occ.userId).eq("status", "running"),
          )
          .take(maxPerUser + 1);
        userRunning = rows.length;
      }
      if (userRunning >= maxPerUser) {
        runningPerUser.set(occ.userId, userRunning);
        continue;
      }

      // Phase 4 scheduled-execution budget. Enforced HERE rather than in
      // startRun, and that placement is the whole point: over the window the
      // occurrence is simply not claimed, so it stays `queued`, keeps its place
      // in schedule order, and is picked up when the window rolls. Enforcing it
      // at start would have to fail the turn, which would burn one of the three
      // MAX_ATTEMPTS on a limit the user did not cause.
      //
      // Queue and delay. Never fail, never skip, never drop.
      if (!(await underScheduledRateLimit(ctx, occ.userId, occ.workspaceId))) {
        continue;
      }

      const leaseToken = crypto.randomUUID();
      const ok = await transition(ctx, occ, "running", {
        leaseToken,
        claimedAt: now,
        startedAt: now,
        heartbeatAt: now,
        nextAttemptAt: undefined,
      });
      if (!ok) continue;

      busyTasks.add(occ.taskId);
      runningPerUser.set(occ.userId, userRunning + 1);
      claims.push({
        occurrenceKey: occ.occurrenceKey,
        taskId: occ.taskId,
        revision: occ.revision,
        scheduledFor: occ.scheduledFor,
        kind: occ.kind,
        attempts: occ.attempts,
        leaseToken,
      });
    }

    return { ok: true, claims };
  },
});

// ── ingress op: sched-verify ─────────────────────────────────────────────────
/**
 * The workflow's first step, before ANY side effect.
 *
 * This is what makes a stale DBOS system database harmless: after restoring an
 * old dump, DBOS may recover workflows for occurrences Convex already finished.
 * They all land here, fail the lease/terminal check, and exit without
 * executing. Convex is the ledger; DBOS is only the engine.
 */
export const verify = internalMutation({
  args: {
    occurrenceKey: v.string(),
    leaseToken: v.string(),
    workflowId: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const occ = await loadByKey(ctx, a.occurrenceKey);
    if (!occ) return { ok: false, unknown: true, cancel: true };
    if (occ.leaseToken !== a.leaseToken) {
      return { ok: false, stale: true, cancel: true };
    }
    if (isTerminal(occ.status)) {
      return { ok: false, stale: true, cancel: true };
    }
    if (occ.cancelRequested) return { ok: true, cancel: true };
    const now = Date.now();
    await ctx.db.patch(occ._id, {
      workflowId: a.workflowId ?? occ.workflowId,
      heartbeatAt: now,
      updatedAt: now,
    });
    return {
      ok: true,
      cancel: false,
      revision: occ.revision,
      scheduledFor: occ.scheduledFor,
      attempts: occ.attempts,
    };
  },
});

// ── ingress op: sched-heartbeat ──────────────────────────────────────────────
export const heartbeat = internalMutation({
  args: { occurrenceKey: v.string(), leaseToken: v.string() },
  handler: async (ctx, a) => {
    const occ = await loadByKey(ctx, a.occurrenceKey);
    if (!occ) return { ok: false, unknown: true, cancel: true };
    if (occ.leaseToken !== a.leaseToken) {
      return { ok: false, stale: true, cancel: true };
    }
    if (isTerminal(occ.status)) return { ok: false, stale: true, cancel: true };
    const now = Date.now();
    await ctx.db.patch(occ._id, { heartbeatAt: now, updatedAt: now });
    return { ok: true, cancel: occ.cancelRequested };
  },
});

// ── ingress op: sched-finalize ───────────────────────────────────────────────
/**
 * Terminal completion, idempotent by construction.
 *
 * A duplicate finalize (retry, double callback, recovered workflow) finds the
 * row already terminal and changes nothing. A finalize from a worker whose
 * lease was rotated away is refused, so a zombie cannot mark a newer execution
 * succeeded.
 *
 * `retryable` converts a failure into another DISPATCH attempt of the SAME
 * occurrence — never a new occurrence. Transient errors inside one attempt are
 * DBOS step retries and never reach here.
 */
export const finalize = internalMutation({
  args: {
    occurrenceKey: v.string(),
    leaseToken: v.string(),
    outcome: v.union(
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    errorCode: v.optional(v.string()),
    retryable: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    const occ = await loadByKey(ctx, a.occurrenceKey);
    if (!occ) return { ok: false, unknown: true };
    // Idempotent duplicate completion: checked BEFORE the lease, because a
    // recovered workflow legitimately has no lease any more.
    if (isTerminal(occ.status)) {
      return { ok: true, alreadyTerminal: true, status: occ.status };
    }
    if (occ.leaseToken !== a.leaseToken) return { ok: false, stale: true };

    const now = Date.now();
    const attempts = occ.attempts + 1;

    if (a.outcome === "failed" && a.retryable && attempts < MAX_ATTEMPTS) {
      await transition(ctx, occ, "retrying", {
        attempts,
        errorCode: a.errorCode,
        leaseToken: undefined,
        nextAttemptAt: now + backoffMs(attempts),
      });
      return { ok: true, status: "retrying", attempts };
    }

    await transition(ctx, occ, a.outcome, {
      attempts,
      errorCode: a.errorCode,
      finishedAt: now,
      leaseToken: undefined,
      nextAttemptAt: undefined,
    });
    await finishTaskIfDone(ctx, occ.taskId, now);
    // Reached only on the transition that actually made this occurrence
    // terminal — the `isTerminal` guard above already returned for a replay, so
    // a duplicate finalize never gets here at all.
    await onOccurrenceTerminal(
      ctx,
      { ...occ, errorCode: a.errorCode ?? occ.errorCode },
      a.outcome,
    );
    return { ok: true, status: a.outcome, attempts };
  },
});

/**
 * Tell the owner their scheduled run finished. Phase 3.
 *
 * WRAPPED IN try/catch ON PURPOSE, and this is load-bearing rather than
 * defensive habit: this runs INSIDE the finalize transaction. A throw here — a
 * bug, an oversized document, a schema slip — would abort the whole mutation,
 * the occurrence would never reach a terminal state, the reaper would requeue
 * it, and a notification defect would silently become a RE-EXECUTION defect.
 * A lost notification is acceptable; a lost finalize is not.
 *
 * Idempotency is `dedupeKey = occurrenceKey` — the LOGICAL occurrence, so all
 * three dispatch attempts of one run collapse to a single notification.
 */
/**
 * Everything that must happen when an occurrence reaches a terminal state, in
 * ONE place.
 *
 * There are two sites that end a run that actually executed — `finalize` and
 * `reapStalled` — and Phase 3 wired notifications into both by hand. Phase 4
 * adds delivery, and hooking only `finalize` would silently mean a run whose
 * worker died notifies but never emails. So both now call this, and the two can
 * no longer drift apart.
 *
 * Deliberately NOT called from the claim-time cancellations
 * (`cancelled_before_start`, `task_deleted`, entitlement) or from
 * `cancelOpenForTask`: those occurrences never ran. There is no result to
 * report, and the user already caused the cancellation by pausing or deleting.
 */
async function onOccurrenceTerminal(
  ctx: MutationCtx,
  occ: Doc<"scheduledTaskOccurrences">,
  outcome: "succeeded" | "failed" | "cancelled",
): Promise<void> {
  await notifyRunFinished(ctx, occ, outcome);
  try {
    await enqueueDelivery(ctx, occ, outcome);
  } catch (e) {
    // Same trade as the notification above, and for the same reason: this runs
    // inside the terminal transition's transaction, so letting it throw would
    // abort the transition, leave the occurrence non-terminal, and hand it back
    // to the reaper — turning a delivery bug into a RE-EXECUTION bug. An
    // un-emailed report is recoverable; a re-billed model turn is not.
    console.error("scheduled delivery enqueue failed", e);
  }
}

/**
 * A failure reason a person can act on.
 *
 * This used to emit `Reason: ${occ.errorCode}` verbatim, so users were shown
 * "Reason: worker_lost_after_send" and "Reason: approval_expired" — internal
 * vocabulary that says nothing about what to do next. Codes are matched from
 * the values actually produced by the scheduler, the dispatcher and the Python
 * worker; anything unrecognised falls back to a plain sentence rather than
 * leaking the raw code.
 */
function failureSentence(code?: string): string {
  switch (code) {
    case "timeout":
    case "deadline":
      return "The run took too long and was stopped.";
    case "stalled":
    case "worker_lost_after_send":
      return "The run stopped responding before it finished.";
    case "dispatch_failed":
    case "dispatch_unreachable":
    case "provider_unreachable":
    case "provider_error":
      return "The AI service could not be reached. The next run will try again.";
    case "approval_expired":
      return "The run needed your approval and the request expired.";
    case "thread_busy":
      return "Another run for this task was still going, so this one was skipped.";
    case "payload_unavailable":
    case "stream_missing":
    case "stale":
      return "The run could not be resumed after an interruption.";
    default:
      return "The run didn't finish. Open it to see what happened.";
  }
}

async function notifyRunFinished(
  ctx: MutationCtx,
  occ: Doc<"scheduledTaskOccurrences">,
  outcome: "succeeded" | "failed" | "cancelled",
): Promise<void> {
  try {
    const task = await ctx.db.get(occ.taskId);
    if (!task) return;
    // Absent means ENABLED, so tasks created before Phase 3 notify by default
    // and need no migration. Cancellations follow the failure preference.
    const wanted =
      outcome === "succeeded"
        ? task.notifyOnSuccess !== false
        : task.notifyOnFailure !== false;
    if (!wanted) return;

    const label =
      outcome === "succeeded"
        ? "completed"
        : outcome === "failed"
          ? "failed"
          : "was cancelled";
    await notify(
      ctx,
      occ.userId,
      `scheduled.${outcome}`,
      `${task.title} ${label}`,
      outcome === "failed" ? failureSentence(occ.errorCode) : undefined,
      {
        dedupeKey: occ.occurrenceKey,
        taskId: occ.taskId,
        occurrenceKey: occ.occurrenceKey,
        // The occurrence itself, so the notification opens the RUN and not just
        // the task. Occurrences are never deleted, so this cannot dangle.
        occurrenceId: occ._id,
      },
    );
  } catch (e) {
    console.error("scheduled notification failed", e);
  }
}

/**
 * A one-time task is COMPLETED once its single occurrence stops being open —
 * and only then, so a retry does not prematurely close the task.
 */
async function finishTaskIfDone(
  ctx: MutationCtx,
  taskId: Id<"scheduledTasks">,
  now: number,
): Promise<void> {
  const task = await ctx.db.get(taskId);
  if (!task || task.status === "deleted") return;
  await ctx.db.patch(taskId, { lastRunAt: now, updatedAt: now });
  if (task.spec.kind !== "once" || task.status !== "active") return;
  const open = await openForTask(ctx, taskId);
  if (open.length === 0) {
    await ctx.db.patch(taskId, { status: "completed", updatedAt: now });
  }
}

// ── cron: reap stalled occurrences ───────────────────────────────────────────
/**
 * The backstop for a scheduler process that died without DBOS recovering it.
 *
 * Rotating the lease away is what makes a zombie harmless: its later writes are
 * refused as stale, so it cannot corrupt the newer attempt. Mirrors
 * chat/stream.ts:reapStalled.
 */
export const reapStalled = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - LEASE_TTL_MS;
    const stalled = await ctx.db
      .query("scheduledTaskOccurrences")
      .withIndex("by_status_heartbeat", (q) =>
        q.eq("status", "running").lt("heartbeatAt", cutoff),
      )
      .take(50);

    let requeued = 0;
    let closed = 0;
    for (const occ of stalled) {
      const attempts = occ.attempts + 1;
      if (occ.cancelRequested || attempts >= MAX_ATTEMPTS) {
        await transition(
          ctx,
          occ,
          occ.cancelRequested ? "cancelled" : "failed",
          {
            attempts,
            errorCode: occ.cancelRequested ? undefined : "stalled",
            finishedAt: now,
            terminalReason: occ.cancelRequested ? "cancelled" : "stalled",
            leaseToken: undefined,
          },
        );
        await finishTaskIfDone(ctx, occ.taskId, now);
        await onOccurrenceTerminal(
          ctx,
          { ...occ, errorCode: occ.cancelRequested ? undefined : "stalled" },
          occ.cancelRequested ? "cancelled" : "failed",
        );
        closed++;
        continue;
      }
      await transition(ctx, occ, "retrying", {
        attempts,
        // Rotating the lease away is the whole point — the old holder can no
        // longer advance this row.
        leaseToken: undefined,
        errorCode: "stalled",
        nextAttemptAt: now + backoffMs(attempts),
      });
      requeued++;
    }
    return { requeued, closed };
  },
});
