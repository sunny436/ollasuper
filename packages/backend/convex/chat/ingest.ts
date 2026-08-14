import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { recordUsage } from "../usage";

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

    for (const d of deltas) {
      // Already compacted away — this is a retry of an old batch.
      if (d.seq <= stream.committedSeq) continue;
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

/** Model-generated conversation title. Never overwrites a user-set title. */
export const setTitle = internalMutation({
  args: { streamId: v.string(), title: v.string() },
  handler: async (ctx, { streamId, title }) => {
    const stream = await loadStream(ctx, streamId);
    if (!stream) return { ok: false };
    const thread = await ctx.db.get(stream.threadId);
    if (!thread || thread.titleSource === "user") return { ok: true };
    const clean = title.replace(/\s+/g, " ").trim().slice(0, 120);
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

/** Extracted document text (PDF/DOCX), cached so re-sends don't re-parse. */
export const setAttachmentText = internalMutation({
  args: {
    attachmentId: v.id("chatAttachments"),
    text: v.optional(v.string()),
    status: v.union(v.literal("ready"), v.literal("error")),
  },
  handler: async (ctx, { attachmentId, text, status }) => {
    const a = await ctx.db.get(attachmentId);
    if (!a) return { ok: false };
    await ctx.db.patch(attachmentId, {
      extractedText: text?.slice(0, 200_000),
      status,
    });
    return { ok: true };
  },
});
