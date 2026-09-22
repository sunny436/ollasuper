import { type Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { audit } from "../auditLog";
import { notify } from "../notifications";
import { recordUsage } from "../usage";
import { eventObject, stripForDisplay } from "./events";
import { deleteExecutions } from "./executions";

/**
 * Server-to-server ingress mutations. Called only from http.ts, which has
 * already verified AI_INGRESS_SECRET.
 *
 * Every entry point resolves the stream by its `streamId` capability. A leaked
 * ingress secret is therefore still not enough to write into an arbitrary
 * thread — the caller must also hold a streamId that Convex minted.
 */

/**
 * Fold chunks into committedText every N seqs, bounding resident rows.
 *
 * The resident window is what every stream.active push carries, so it is the
 * per-push payload: 24 seqs of 96–512-char batches was 12–24 KB per push, i.e.
 * most of a typical answer re-sent with every flush. 12 keeps it at 4–16
 * chunks (measured 2–5 KB) and costs one extra compaction per 24 flushes.
 */
const COMPACT_EVERY = 12;
/**
 * The newest chunks stay resident through a compaction. A subscriber receives
 * one push per flush, so a chunk that lived in COMPACT_LAG consecutive pushes
 * has been seen; compacting the chunk that arrived in the SAME mutation used
 * to remove it before any subscriber saw it, which forced every client to
 * fetch the whole committed prefix (stream.committed) at every compaction.
 */
const COMPACT_LAG = 4;

/** Convex documents cap at 1MB; stop well short of it. */
const MAX_MESSAGE_CHARS = 400_000;

/**
 * Server-side bounds on one delta batch.
 *
 * The Python writer self-limits, but the server must not trust the client for
 * its own write bound: without these, one request could insert thousands of
 * chatStreamChunks rows (each an indexed probe plus an insert) and push them
 * all into the viewer's live subscription.
 */
const MAX_DELTAS_PER_BATCH = 64;
const MAX_DELTA_CHARS = 16_000;
/** Server-side bounds on one typed-event batch (Phase 3). */
const MAX_EVENTS_PER_BATCH = 64;
const MAX_EVENT_PAYLOAD_CHARS = 100_000;
/**
 * The total-execution deadline (mirror of AGENT_TOTAL_DEADLINE_MS in
 * chat/messages.ts) is a NO-PROGRESS watchdog, not a wall-clock cap. Any forward
 * progress rolls it: a tool event (`appendEvent`) OR streamed text (`appendDeltas`).
 *
 * Tool events alone were not enough. The final long-form answer of a tool-heavy
 * turn — the slowest phase, and the one that produces the deliverable — emits
 * tokens and NO tool events, and it runs exactly when the step budget is spent so
 * no further tool event is even possible. That left the most valuable phase under
 * a deadline frozen at the last tool call, which is what killed it.
 */
const AGENT_TOTAL_DEADLINE_MS = 300_000;
const TOOL_EVENT_TYPES = new Set(["TOOL_CALL", "TOOL_RESULT", "TOOL_PROGRESS"]);
/**
 * Terminals where the completed tool work is still VALID and re-running it would
 * be pure waste — the turn ran out of time, it did not produce a wrong answer.
 * `finalizeError` preserves the toolExecutions checkpoint for these so `retry`
 * resumes from it. Deliberately narrow: a cancel or an expired approval is a
 * decision, not a timeout, and still retires the checkpoint.
 */
const RESUMABLE_ERROR_CODES = new Set([
  "deadline",
  "deadline_exceeded",
  "timeout",
  "provider_timeout",
]);
/**
 * `appendEvent` was the single largest source of Convex OCC write-conflicts (68/68
 * observed in 24h, retried at 47-77ms each) because it patched this stream row on
 * EVERY call — and its victims included `upsertExecution`, the write-ahead gate a
 * side-effecting tool must clear before it may fire. `heartbeatAt` has its own
 * dedicated 5s beat, so refreshing it here is redundant unless it has genuinely
 * aged; this bound keeps a 6x margin under the reaper's STALL_MS (90s).
 */
const HEARTBEAT_COALESCE_MS = 15_000;
/**
 * A single delta with seq 1e9 would trigger compaction, set committedSeq to
 * 1e9, and then silently drop every legitimate delta that followed via the
 * `d.seq <= committedSeq` guard. Bound how far ahead a seq may jump.
 */
const MAX_SEQ_LOOKAHEAD = 1024;

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

/** Concatenate the resident (uncompacted) chunks in seq order. */
async function residentText(
  ctx: MutationCtx,
  messageId: Id<"chatMessages">,
  afterSeq: number,
  upToSeq?: number,
): Promise<string> {
  const chunks = await ctx.db
    .query("chatStreamChunks")
    .withIndex("by_message_seq", (q) =>
      upToSeq === undefined
        ? q.eq("messageId", messageId).gt("seq", afterSeq)
        : q.eq("messageId", messageId).gt("seq", afterSeq).lte("seq", upToSeq),
    )
    .collect();
  chunks.sort((a, b) => a.seq - b.seq);
  return chunks.map((c) => c.text).join("");
}

async function deleteChunks(ctx: MutationCtx, messageId: Id<"chatMessages">) {
  const chunks = await ctx.db
    .query("chatStreamChunks")
    .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
    .collect();
  for (const c of chunks) await ctx.db.delete(c._id);
}

/** Typed event = the eventObject validator's inferred shape (the persisted
 *  fields, minus the internal messageId/streamId/_id). */
type StoredEvent = Infer<typeof eventObject>;

async function deleteEvents(ctx: MutationCtx, messageId: Id<"chatMessages">) {
  const rows = await ctx.db
    .query("chatStreamEvents")
    .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}

/**
 * Phase 4 hygiene: retire this stream's approval rows at a terminal finalize, so
 * an unresolved `pending` row (e.g. the model didn't re-emit a deferred sibling
 * under all-or-pause) leaves no orphan. NOT load-bearing — the UI reads the
 * pending approval only from `stream.active` (gated on `waiting_approval`), and
 * `reapExpired` self-heals it after the TTL — but it keeps the table clean.
 * Called ONLY after the `waiting_approval` early-return, so a live park survives.
 */
async function deleteApprovals(ctx: MutationCtx, streamId: string) {
  const rows = await ctx.db
    .query("chatApprovals")
    .withIndex("by_stream_approval", (q) => q.eq("streamId", streamId))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}

/** Read live event rows in seq order, stripped to the persisted shape. */
async function collectEvents(
  ctx: MutationCtx,
  messageId: Id<"chatMessages">,
): Promise<StoredEvent[]> {
  const rows = await ctx.db
    .query("chatStreamEvents")
    .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
    .collect();
  rows.sort((a, b) => a.seq - b.seq);
  return rows.map((r) => ({
    eventId: r.eventId,
    seq: r.seq,
    type: r.type,
    v: r.v,
    ts: r.ts,
    textOffset: r.textOffset,
    payload: r.payload,
  }));
}

/** Synthesize the terminal FINAL/ERROR envelope appended at finalize. */
function terminalEvent(
  type: "FINAL" | "ERROR",
  seq: number,
  payload: Record<string, unknown>,
): StoredEvent {
  return {
    eventId: crypto.randomUUID(),
    seq,
    type,
    v: 1,
    ts: Date.now(),
    payload: JSON.stringify(payload),
  };
}

/**
 * Fold the live event rows for a generation into the persisted array + a
 * terminal envelope, then delete the rows. Returns `undefined` when the stream
 * emitted no structured events, so a pure-text turn writes no `events` field and
 * renders exactly as before. Gate the call on `stream.hasEvents`.
 */
async function foldEvents(
  ctx: MutationCtx,
  messageId: Id<"chatMessages">,
  terminal: StoredEvent,
): Promise<StoredEvent[]> {
  const events = await collectEvents(ctx, messageId);
  const nextSeq = (events.at(-1)?.seq ?? -1) + 1;
  events.push({ ...terminal, seq: nextSeq });
  await deleteEvents(ctx, messageId);
  // The folded copy is display-only (resume reads the live rows, which are
  // gone after this) — drop the model-context blocks here, at the source.
  return events.map(stripForDisplay);
}

/**
 * Append a batch of token deltas.
 *
 * Returns `cancel` so the Python writer learns about a stop request on a
 * response it is already receiving — no polling, no extra round trip, and it
 * works regardless of which worker process handles the request.
 */
export const appendDeltas = internalMutation({
  args: {
    streamId: v.string(),
    deltas: v.array(v.object({ seq: v.number(), text: v.string() })),
  },
  handler: async (ctx, { streamId, deltas }) => {
    const stream = await loadStream(ctx, streamId);
    // Unknown stream: write nothing. 404 is signalled by `ok: false`.
    if (!stream) return { ok: false, cancel: true, unknown: true };
    // Late delta racing a finalize or an abort: write nothing, tell it to stop.
    if (isTerminal(stream.status)) return { ok: true, cancel: true };
    // Parked awaiting approval: unwind any stray/duplicate run cleanly (no run
    // may be alive while an approval is parked).
    if (stream.status === "waiting_approval") return { ok: true, cancel: true };

    const now = Date.now();
    let maxSeq = stream.chunkSeq;

    for (const d of deltas.slice(0, MAX_DELTAS_PER_BATCH)) {
      // Already compacted away — this is a retry of an old batch.
      if (d.seq <= stream.committedSeq) continue;
      // Reject nonsense seqs rather than letting one poison committedSeq.
      if (
        !Number.isInteger(d.seq) ||
        d.seq < 0 ||
        d.seq > stream.chunkSeq + MAX_SEQ_LOOKAHEAD
      ) {
        continue;
      }
      if (d.text.length > MAX_DELTA_CHARS) continue;
      // Indexed uniqueness probe: makes an HTTP retry idempotent. O(1).
      const existing = await ctx.db
        .query("chatStreamChunks")
        .withIndex("by_message_seq", (q) =>
          q.eq("messageId", stream.messageId).eq("seq", d.seq),
        )
        .unique();
      if (existing) continue;
      await ctx.db.insert("chatStreamChunks", {
        messageId: stream.messageId,
        streamId,
        seq: d.seq,
        // Out-of-order arrivals are fine: the read path orders by seq, so a
        // late seq-2 landing after seq-3 slots into place on the next push.
        text: d.text,
      });
      if (d.seq > maxSeq) maxSeq = d.seq;
    }

    const patch: Partial<Doc<"chatStreams">> = {
      chunkSeq: maxSeq,
      heartbeatAt: now,
      // Streamed text IS forward progress. Without this, a turn that has spent its
      // step budget can no longer emit a tool event, so its deadline freezes at the
      // last tool call and the final answer is killed mid-generation.
      deadlineAt: Math.max(stream.deadlineAt ?? 0, now + AGENT_TOTAL_DEADLINE_MS),
    };
    if (stream.status === "queued") patch.status = "running";

    // Periodic compaction keeps the resident chunk count (and therefore the
    // hot tail query's read cost) bounded.
    const upTo = maxSeq - COMPACT_LAG;
    if (
      maxSeq >= stream.committedSeq + COMPACT_EVERY &&
      upTo > stream.committedSeq
    ) {
      const text = await residentText(
        ctx,
        stream.messageId,
        stream.committedSeq,
        upTo,
      );
      const toDelete = await ctx.db
        .query("chatStreamChunks")
        .withIndex("by_message_seq", (q) =>
          q.eq("messageId", stream.messageId).lte("seq", upTo),
        )
        .collect();
      for (const c of toDelete) await ctx.db.delete(c._id);
      patch.committedText = (stream.committedText + text).slice(
        0,
        MAX_MESSAGE_CHARS,
      );
      patch.committedSeq = upTo;
    }

    await ctx.db.patch(stream._id, patch);

    if (stream.status === "queued") {
      await ctx.db.patch(stream.messageId, {
        status: "streaming",
        updatedAt: now,
      });
    }
    return { ok: true, cancel: stream.cancelRequested };
  },
});

/** Keeps the stall reaper at bay while the model thinks or a tool runs. */
export const heartbeat = internalMutation({
  args: { streamId: v.string() },
  handler: async (ctx, { streamId }) => {
    const stream = await loadStream(ctx, streamId);
    if (!stream) return { ok: false, cancel: true, unknown: true };
    if (isTerminal(stream.status)) return { ok: true, cancel: true };
    if (stream.status === "waiting_approval") return { ok: true, cancel: true };
    await ctx.db.patch(stream._id, {
      heartbeatAt: Date.now(),
      ...(stream.status === "queued" ? { status: "running" as const } : {}),
    });
    return { ok: true, cancel: stream.cancelRequested };
  },
});

/**
 * Append typed events (Phase 3). Low-volume STRUCTURED events only — text stays
 * on appendDeltas, so the high-volume path is untouched. Idempotent by the
 * (messageId, seq) uniqueness probe (mirrors appendDeltas). Sets `hasEvents` so
 * the finalize fold + the stream.active events read activate. Returns `cancel`
 * like appendDeltas so the writer learns of a stop on a response in flight.
 */
export const appendEvent = internalMutation({
  args: {
    streamId: v.string(),
    events: v.array(eventObject),
  },
  handler: async (ctx, { streamId, events }) => {
    const stream = await loadStream(ctx, streamId);
    // Phase 2: `persisted` is the write-ahead signal — TRUE only when the event
    // row is actually durable. The three early-returns below do NOT insert, so a
    // side-effecting TOOL_CALL that gets one of them must ABORT (a stopped or
    // finalized stream must not fire a fresh side effect).
    if (!stream) return { ok: false, cancel: true, unknown: true, persisted: false };
    if (isTerminal(stream.status))
      return { ok: true, cancel: true, persisted: false };
    if (stream.status === "waiting_approval")
      return { ok: true, cancel: true, persisted: false };

    const now = Date.now();
    for (const e of events.slice(0, MAX_EVENTS_PER_BATCH)) {
      if (e.payload.length > MAX_EVENT_PAYLOAD_CHARS) continue;
      if (!Number.isInteger(e.seq) || e.seq < 0) continue;
      // Indexed uniqueness probe: an HTTP retry is idempotent (like deltas).
      const existing = await ctx.db
        .query("chatStreamEvents")
        .withIndex("by_message_seq", (q) =>
          q.eq("messageId", stream.messageId).eq("seq", e.seq),
        )
        .unique();
      if (existing) continue;
      await ctx.db.insert("chatStreamEvents", {
        messageId: stream.messageId,
        streamId,
        ...e,
      });
    }

    // Write the hot stream row ONLY when a field genuinely changes. Every write
    // here is an OCC conflict opportunity against upsertExecution / heartbeat /
    // appendDeltas, which all touch this same document (see HEARTBEAT_COALESCE_MS).
    const patch: {
      hasEvents?: true;
      heartbeatAt?: number;
      status?: "running";
      deadlineAt?: number;
    } = {};
    if (!stream.hasEvents) patch.hasEvents = true;
    if (now - stream.heartbeatAt >= HEARTBEAT_COALESCE_MS) patch.heartbeatAt = now;
    if (stream.status === "queued") patch.status = "running";
    // Roll the total-execution deadline forward on tool activity so a legitimately
    // long tool/skill turn is not failed by the reaper (nor instant-failed when it
    // resumes past the original deadline). `appendDeltas` rolls it for streamed
    // text; between them, any forward progress keeps the turn alive.
    if (events.some((e) => TOOL_EVENT_TYPES.has(e.type))) {
      const rolled = now + AGENT_TOTAL_DEADLINE_MS;
      if (rolled > (stream.deadlineAt ?? 0)) patch.deadlineAt = rolled;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(stream._id, patch);
    if (stream.status === "queued") {
      await ctx.db.patch(stream.messageId, {
        status: "streaming",
        updatedAt: now,
      });
    }
    return { ok: true, cancel: stream.cancelRequested, persisted: true };
  },
});

/**
 * Terminal success.
 *
 * `text` is authoritative and overwrites whatever the deltas accumulated, so a
 * dropped or duplicated delta can smear the live rendering but can never
 * corrupt the stored message.
 */
export const finishStream = internalMutation({
  args: {
    streamId: v.string(),
    text: v.string(),
    finishReason: v.optional(v.string()),
    reasoning: v.optional(v.string()),
    tokensIn: v.optional(v.number()),
    tokensOut: v.optional(v.number()),
    costUsd: v.optional(v.number()),
    firstTokenMs: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    // THE MODEL THAT ACTUALLY RAN, reported by the Python plane.
    //
    // Before the Master Model Router the model was decided in Convex before
    // dispatch, so `chatMessages.model` was true by construction. It is now a
    // pre-dispatch FALLBACK that routing may move off, so without this the
    // stored value would be a plausible lie — the worst kind for debugging,
    // because nothing would look wrong. Optional, so an older Python build
    // simply leaves the pre-dispatch value in place.
    model: v.optional(v.string()),
    // Structured, e.g. "simple:412t" / "heavy:9100t" / "all_filtered".
    routedReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const stream = await loadStream(ctx, args.streamId);
    if (!stream) return { ok: false, unknown: true };
    // Idempotent, and never resurrects a message the user already stopped.
    if (isTerminal(stream.status)) return { ok: true, alreadyFinal: true };
    // Late finalize onto a parked approval → drop it (see finalizeError).
    if (stream.status === "waiting_approval")
      return { ok: true, suspended: true };

    const now = Date.now();
    await deleteChunks(ctx, stream.messageId);
    // Phase 3: the durable execution records are the recovery checkpoint; a terminal
    // finalize retires them (mirrors deleteEvents). Suspend returned above, so a
    // parked WAITING_APPROVAL row survives for the approval resume.
    await deleteExecutions(ctx, stream.messageId);
    await deleteApprovals(ctx, stream.streamId); // Phase 4: retire any orphan approvals
    // Fold typed events into the message ONLY when the generation emitted any
    // (the "second write"). A pure text turn writes no `events` field → renders
    // exactly as before. The seq arg is a placeholder; foldEvents assigns it.
    const events = stream.hasEvents
      ? await foldEvents(
          ctx,
          stream.messageId,
          terminalEvent("FINAL", 0, {
            finishReason: args.finishReason ?? null,
          }),
        )
      : undefined;
    await ctx.db.patch(stream._id, {
      status: "done",
      committedText: "",
      endedAt: now,
    });
    await ctx.db.patch(stream.messageId, {
      content: args.text.slice(0, MAX_MESSAGE_CHARS),
      status: "complete",
      finishReason: args.finishReason,
      reasoning: args.reasoning?.slice(0, 50_000),
      tokensIn: args.tokensIn,
      tokensOut: args.tokensOut,
      costUsd: args.costUsd,
      firstTokenMs: args.firstTokenMs,
      latencyMs: args.latencyMs,
      // Spread, never a bare assignment: Convex `patch` DELETES a field set to
      // undefined, so an older Python build reporting no model would WIPE the
      // pre-dispatch value instead of leaving it alone.
      ...(args.model ? { model: args.model } : {}),
      ...(args.routedReason ? { routedReason: args.routedReason } : {}),
      ...(events ? { events } : {}),
      updatedAt: now,
    });

    const thread = await ctx.db.get(stream.threadId);
    if (thread) {
      await ctx.db.patch(thread._id, {
        streamingMessageId: undefined,
        tokensIn: thread.tokensIn + (args.tokensIn ?? 0),
        tokensOut: thread.tokensOut + (args.tokensOut ?? 0),
        lastMessageAt: now,
        updatedAt: now,
      });
    }

    // Only a LONG turn is worth announcing — a normal reply lands while the
    // user is watching it, and notifying there is pure noise. The window is
    // measured from the stream row's creation, so it includes any time spent
    // queued behind the concurrency limits; a genuinely short generation that
    // waited a long time can therefore qualify, which is acceptable for a
    // "this took a while, here it is" nudge.
    if (now - stream.startedAt >= LONG_RUN_MS) {
      await notifyTurn(
        ctx,
        stream,
        thread,
        "chat.turn_done",
        thread?.title ? `“${thread.title}” is ready` : "Your reply is ready",
        "A long-running response finished.",
      );
    }
    if (args.tokensOut) {
      await recordUsage(
        ctx,
        stream.workspaceId,
        "chat.tokensOut",
        args.tokensOut,
      );
    }

    // Auto-title: fire the separate, non-blocking title task ONCE, on the first
    // assistant turn's success only. seq === 1 is the exactly-once key —
    // regenerate allocates a new seq, and error/abort go through failStream, not
    // here. Skip if the user already renamed the thread. This scheduled action
    // never blocks or affects the response the user just received. Gated on
    // AI_BASE_URL so we do not schedule a task the plane could never service
    // when the inference plane is unconfigured (generate would no-op anyway).
    const finishedMsg = await ctx.db.get(stream.messageId);
    if (
      finishedMsg?.seq === 1 &&
      thread?.titleSource === "auto" &&
      process.env.AI_BASE_URL
    ) {
      await ctx.scheduler.runAfter(0, internal.chat.title.generate, {
        streamId: args.streamId,
      });
    }

    // Phase 8: audit an AGENT execution (only turns that emitted typed events —
    // pure text chat leaves hasEvents unset). Ids/counts only, never payloads or
    // content, so no secret/CoT leaks into the trail.
    if (stream.hasEvents) {
      await audit(ctx, stream.workspaceId, stream.userId, "agent.execution", {
        model: finishedMsg?.model ?? null,
        tokensOut: args.tokensOut ?? null,
        latencyMs: args.latencyMs ?? null,
        toolCount: events?.filter((e) => e.type === "TOOL_CALL").length ?? 0,
      });
    }

    return { ok: true };
  },
});

/**
 * A turn only deserves a notification when the user was not there to see it.
 *
 * Two rules keep this from becoming noise, and both are load-bearing:
 *
 *  - A SCHEDULED thread is skipped. Scheduled execution reuses this exact chat
 *    path (`scheduled/execution.ts` → `startAssistantTurn`), so without this
 *    check every scheduled run would be announced twice: once here and once by
 *    `notifyRunFinished`, which is the one that honours the task's
 *    notifyOnSuccess/notifyOnFailure preferences. `status: "scheduled"` is a
 *    distinct thread status precisely so scheduled threads fall out of chat
 *    surfaces like this one.
 *  - A turn the USER ended, or one already reported by a more specific
 *    notification, is skipped by error code (see the call site).
 *
 * Never throws: this runs inside a terminal transition, and an aborted
 * transition would hand the turn back to the reaper — turning a notification
 * bug into a re-execution bug.
 */
const LONG_RUN_MS = 2 * 60_000;

async function notifyTurn(
  ctx: MutationCtx,
  stream: Doc<"chatStreams">,
  thread: Doc<"chatThreads"> | null,
  type: "chat.turn_failed" | "chat.turn_done",
  title: string,
  body: string,
): Promise<void> {
  try {
    if (!thread || thread.status === "scheduled") return;
    await notify(ctx, stream.userId, type, title, body, {
      // The stream is the logical turn, so a redispatch, a reaper re-entry and
      // a duplicate finalize all collapse to one notification.
      dedupeKey: `stream:${stream.streamId}`,
      threadId: stream.threadId,
    });
  } catch (e) {
    console.error("chat turn notification failed", e);
  }
}

/**
 * The terminal-error write, WITHOUT the ingress guards. Keeps partial text and
 * folds a terminal ERROR event. Shared by the ingress `failStream` (which guards
 * first) and the approval expiry/cancel paths, which DELIBERATELY terminate a
 * `waiting_approval` stream — routing them through the guarded `failStream`
 * (which no-ops on `waiting_approval`, see below) would make expiry unable to
 * ever end a parked turn.
 */
export async function finalizeError(
  ctx: MutationCtx,
  stream: Doc<"chatStreams">,
  args: {
    error: string;
    errorCode?: string;
    text?: string;
    // Which model failed. Load-bearing for the router: health is learned from
    // failures, so a failure that does not name its model teaches nothing.
    model?: string;
    routedReason?: string;
  },
): Promise<void> {
  const partial =
    args.text ??
    stream.committedText +
      (await residentText(ctx, stream.messageId, stream.committedSeq));

  const now = Date.now();
  await deleteChunks(ctx, stream.messageId);
  // KEEP the durable execution checkpoint when the turn died of running out of
  // TIME rather than of being wrong. Those rows are the record of tool work that
  // was already paid for; deleting them meant a retry re-ran every call from zero
  // and hit the same wall, so a long research turn could burn its work twice and
  // still deliver nothing. `retry` seeds `attempts` so the next dispatch replays
  // them instead. Every other terminal still retires the checkpoint, so this does
  // not become unbounded retention.
  if (!RESUMABLE_ERROR_CODES.has(args.errorCode ?? "")) {
    await deleteExecutions(ctx, stream.messageId);
  }
  // NB: deliberately do NOT deleteApprovals here — finalizeError is the expiry /
  // error terminal, where the "expired"/"rejected" row is a kept audit record
  // (reapExpired asserts it survives). Orphan cleanup rides finishStream only.
  const events = stream.hasEvents
    ? await foldEvents(
        ctx,
        stream.messageId,
        terminalEvent("ERROR", 0, {
          code: args.errorCode ?? "error",
          message: args.error.slice(0, 500),
        }),
      )
    : undefined;
  await ctx.db.patch(stream._id, {
    status: "error",
    committedText: "",
    endedAt: now,
  });
  await ctx.db.patch(stream.messageId, {
    content: partial.slice(0, MAX_MESSAGE_CHARS),
    status: "error",
    // Record the model even on failure: the router learns health from
    // failures, and a failure that does not name its model teaches nothing.
    ...(args.model ? { model: args.model } : {}),
    ...(args.routedReason ? { routedReason: args.routedReason } : {}),
    error: args.error.slice(0, 500),
    errorCode: args.errorCode?.slice(0, 64),
    ...(events ? { events } : {}),
    updatedAt: now,
  });
  const thread = await ctx.db.get(stream.threadId);
  if (thread) {
    await ctx.db.patch(thread._id, {
      streamingMessageId: undefined,
      updatedAt: now,
    });
  }

  // A turn that died on its own is worth telling the user about; two cases are
  // NOT, because the user already knows or a better notification covers it:
  //   cancelled        — the user pressed stop (reapStalled also finalises a
  //                      stopped turn through here with this code).
  //   approval_expired — chat/approvals.ts raises `approval.expired`, which
  //                      says what actually happened. This path is how expiry
  //                      terminates the parked turn, so without the skip an
  //                      expired approval would notify twice.
  if (args.errorCode !== "cancelled" && args.errorCode !== "approval_expired") {
    await notifyTurn(
      ctx,
      stream,
      thread,
      "chat.turn_failed",
      thread?.title ? `“${thread.title}” didn't finish` : "A chat reply failed",
      "The response stopped before it was complete. Open the conversation to try again.",
    );
  }

  // Phase 8: audit a failed AGENT execution (agent turns only). errorCode only.
  if (stream.hasEvents) {
    await audit(
      ctx,
      stream.workspaceId,
      stream.userId,
      "agent.execution_failed",
      { errorCode: args.errorCode ?? null },
    );
  }
}

/**
 * Terminal failure. Keeps whatever partial text was produced so the user does
 * not lose a half-written answer to a transient provider error.
 */
export const failStream = internalMutation({
  args: {
    streamId: v.string(),
    error: v.string(),
    errorCode: v.optional(v.string()),
    text: v.optional(v.string()),
    model: v.optional(v.string()),
    routedReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const stream = await loadStream(ctx, args.streamId);
    if (!stream) return { ok: false, unknown: true };
    if (isTerminal(stream.status)) return { ok: true, alreadyFinal: true };
    // A late finalize from a crashed/duplicate run must NOT destroy a parked
    // approval (that would delete the folded APPROVAL_REQUEST + silently fail
    // the turn). Drop it; expiry/cancel terminate a parked stream via
    // finalizeError, not through this guarded path.
    if (stream.status === "waiting_approval")
      return { ok: true, suspended: true };
    await finalizeError(ctx, stream, args);
    return { ok: true };
  },
});

const GENERIC_TITLES = new Set([
  "new chat",
  "chat",
  "conversation",
  "untitled",
  "discussion",
]);

/**
 * Validate + normalize a model-generated title before it is ever persisted —
 * we never blindly trust LLM output. Strips newlines / markdown / emoji /
 * surrounding quotes, collapses whitespace, hard-caps at 5 words, and rejects
 * generic non-titles. Returns null to skip (keep the existing title).
 */
function normalizeTitle(raw: string): string | null {
  let t = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/[*_`~#>|]/g, "")
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}]/gu,
      "",
    )
    .replace(/FE0F/g, "")
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  const words = t.split(" ");
  if (words.length > 5) t = words.slice(0, 5).join(" ");
  if (GENERIC_TITLES.has(t.toLowerCase())) return null;
  return t.slice(0, 120);
}

/** Model-generated conversation title. Never overwrites a user-set title, and
 *  deliberately does NOT bump updatedAt (so the sidebar text updates in place
 *  without reordering). */
export const setTitle = internalMutation({
  args: { streamId: v.string(), title: v.string() },
  handler: async (ctx, { streamId, title }) => {
    const stream = await loadStream(ctx, streamId);
    if (!stream) return { ok: false };
    const thread = await ctx.db.get(stream.threadId);
    if (!thread || thread.titleSource === "user") return { ok: true };
    const clean = normalizeTitle(title);
    if (!clean) return { ok: true };
    await ctx.db.patch(thread._id, { title: clean, titleSource: "auto" });
    return { ok: true };
  },
});

/** Rolling conversation summary, produced out-of-band after a turn completes. */
export const setSummary = internalMutation({
  args: {
    streamId: v.string(),
    summary: v.string(),
    throughSeq: v.number(),
  },
  handler: async (ctx, { streamId, summary, throughSeq }) => {
    const stream = await loadStream(ctx, streamId);
    if (!stream) return { ok: false };
    const thread = await ctx.db.get(stream.threadId);
    if (!thread) return { ok: false };
    // Monotonic: a late summary for older messages must not clobber a newer one.
    if ((thread.summaryThroughSeq ?? 0) >= throughSeq) return { ok: true };
    await ctx.db.patch(thread._id, {
      summary: summary.slice(0, 8000),
      summaryThroughSeq: throughSeq,
    });
    return { ok: true };
  },
});

/**
 * Composer follow-up chips for a completed turn.
 *
 * The ordering key is derived HERE rather than accepted from the caller: it is
 * the assistant message's own seq, which rises across turns, so the inference
 * plane cannot get it wrong and no seq crosses the wire.
 *
 * Called with an EMPTY array on a turn that warrants no suggestions, and that
 * is load-bearing — writing nothing would leave the previous turn's chips
 * standing after a trivial turn.
 */
export const setSuggestions = internalMutation({
  args: {
    streamId: v.string(),
    suggestions: v.array(v.string()),
  },
  handler: async (ctx, { streamId, suggestions }) => {
    const stream = await loadStream(ctx, streamId);
    if (!stream) return { ok: false };
    const thread = await ctx.db.get(stream.threadId);
    if (!thread) return { ok: false };
    const message = await ctx.db.get(stream.messageId);
    if (!message) return { ok: false };
    // Monotonic, and `>=` NOT `>`: a late duplicate for the SAME turn has to
    // lose to the result already stored. With `>` a slow call from turn 1 could
    // land after turn 2 finished and overwrite it.
    if ((thread.suggestionsForSeq ?? -1) >= message.seq) return { ok: true };
    await ctx.db.patch(thread._id, {
      suggestions: suggestions.slice(0, 3).map((s) => s.slice(0, 60)),
      suggestionsForSeq: message.seq,
    });
    return { ok: true };
  },
});
