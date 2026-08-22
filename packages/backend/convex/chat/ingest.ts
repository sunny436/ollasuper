import { type Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { recordUsage } from "../usage";
import { eventObject } from "./events";

/**
 * Server-to-server ingress mutations. Called only from http.ts, which has
 * already verified AI_INGRESS_SECRET.
 *
 * Every entry point resolves the stream by its `streamId` capability. A leaked
 * ingress secret is therefore still not enough to write into an arbitrary
 * thread — the caller must also hold a streamId that Convex minted.
 */

/** Fold chunks into committedText every N seqs, bounding resident rows. */
const COMPACT_EVERY = 24;

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
): Promise<string> {
  const chunks = await ctx.db
    .query("chatStreamChunks")
    .withIndex("by_message_seq", (q) =>
      q.eq("messageId", messageId).gt("seq", afterSeq),
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
  return events;
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
    };
    if (stream.status === "queued") patch.status = "running";

    // Periodic compaction keeps the resident chunk count (and therefore the
    // hot tail query's read cost) bounded.
    if (maxSeq >= stream.committedSeq + COMPACT_EVERY) {
      const text = await residentText(
        ctx,
        stream.messageId,
        stream.committedSeq,
      );
      const toDelete = await ctx.db
        .query("chatStreamChunks")
        .withIndex("by_message_seq", (q) =>
          q.eq("messageId", stream.messageId).lte("seq", maxSeq),
        )
        .collect();
      for (const c of toDelete) await ctx.db.delete(c._id);
      patch.committedText = (stream.committedText + text).slice(
        0,
        MAX_MESSAGE_CHARS,
      );
      patch.committedSeq = maxSeq;
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
    if (!stream) return { ok: false, cancel: true, unknown: true };
    if (isTerminal(stream.status)) return { ok: true, cancel: true };

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

    const patch: {
      hasEvents: true;
      heartbeatAt: number;
      status?: "running";
    } = { hasEvents: true, heartbeatAt: now };
    if (stream.status === "queued") patch.status = "running";
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
  },
  handler: async (ctx, args) => {
    const stream = await loadStream(ctx, args.streamId);
    if (!stream) return { ok: false, unknown: true };
    // Idempotent, and never resurrects a message the user already stopped.
    if (isTerminal(stream.status)) return { ok: true, alreadyFinal: true };

    const now = Date.now();
    await deleteChunks(ctx, stream.messageId);
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

    return { ok: true };
  },
});

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
  },
  handler: async (ctx, args) => {
    const stream = await loadStream(ctx, args.streamId);
    if (!stream) return { ok: false, unknown: true };
    if (isTerminal(stream.status)) return { ok: true, alreadyFinal: true };

    const partial =
      args.text ??
      stream.committedText +
        (await residentText(ctx, stream.messageId, stream.committedSeq));

    const now = Date.now();
    await deleteChunks(ctx, stream.messageId);
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
