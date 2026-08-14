import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { getUserIdOrNull, requireMessageAccess, requireUserId } from "./authz";
import { buildHistory } from "./messages";

/**
 * A stream is considered dead if the Python service has not sent a delta or a
 * heartbeat within this window. Python heartbeats every 5s, so 90s is ~18
 * missed beats — comfortably past a slow model warm-up or a brief GC pause.
 */
const STALL_MS = 90_000;

/** Upper bound on chunk rows the tail query will read. Compaction keeps ~24. */
const MAX_RESIDENT_CHUNKS = 64;

/**
 * THE hot subscription. This is the only query that re-fires while a reply is
 * being generated — the paginated message list deliberately excludes in-flight
 * rows, so it stays stable and does not re-send 50 documents per token.
 *
 * Returns null once the stream reaches a terminal state, which lets the client
 * drop the subscription and fall back to the settled message list.
 */
export const active = query({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return null;
    const tid = ctx.db.normalizeId("chatThreads", threadId);
    if (!tid) return null;

    const thread = await ctx.db.get(tid);
    if (!thread || thread.userId !== userId) return null;
    if (!thread.streamingMessageId) return null;

    const message = await ctx.db.get(thread.streamingMessageId);
    if (!message) return null;

    const stream = await ctx.db
      .query("chatStreams")
      .withIndex("by_message", (q) =>
        q.eq("messageId", message._id as Id<"chatMessages">),
      )
      .unique();
    if (!stream) return null;

    const chunks = await ctx.db
      .query("chatStreamChunks")
      .withIndex("by_message_seq", (q) =>
        q.eq("messageId", message._id).gt("seq", stream.committedSeq),
      )
      .take(MAX_RESIDENT_CHUNKS);

    return {
      messageId: message._id,
      seq: message.seq,
      status: stream.status,
      cancelRequested: stream.cancelRequested,
      model: message.model ?? thread.model,
      // Client renders committedText + chunks joined in seq order.
      committedText: stream.committedText,
      chunks: chunks.map((c) => ({ seq: c.seq, text: c.text })),
      startedAt: stream.startedAt,
    };
  },
});

/**
 * Stop generating.
 *
 * This finalizes the message immediately and durably, rather than waiting for
 * Python to acknowledge — the UI must stop the moment the user asks, whatever
 * the inference service is doing. Python learns about it from the `cancel` flag
 * on its next ingress response (≤600ms) and unwinds its own task.
 */
export const stop = mutation({
  args: { messageId: v.id("chatMessages") },
  handler: async (ctx, { messageId }) => {
    const userId = await requireUserId(ctx);
    const { thread } = await requireMessageAccess(ctx, userId, messageId);

    const stream = await ctx.db
      .query("chatStreams")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .unique();
    if (!stream) return;
    if (stream.status === "done" || stream.status === "aborted") return;

    const chunks = await ctx.db
      .query("chatStreamChunks")
      .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
      .collect();
    chunks.sort((a, b) => a.seq - b.seq);
    const partial =
      stream.committedText +
      chunks
        .filter((c) => c.seq > stream.committedSeq)
        .map((c) => c.text)
        .join("");

    const now = Date.now();
    await ctx.db.patch(stream._id, {
      status: "aborted",
      cancelRequested: true,
      endedAt: now,
    });
    for (const c of chunks) await ctx.db.delete(c._id);
    await ctx.db.patch(messageId, {
      content: partial,
      status: "aborted",
      updatedAt: now,
    });
    await ctx.db.patch(thread._id, {
      streamingMessageId: undefined,
      lastMessageAt: now,
      updatedAt: now,
    });
  },
});

/** Everything the Python service needs for one generation, in one read. */
export const dispatchPayload = internalQuery({
  args: { streamId: v.string() },
  handler: async (ctx, { streamId }) => {
    const stream = await ctx.db
      .query("chatStreams")
      .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
      .unique();
    if (!stream) return null;
    const thread = await ctx.db.get(stream.threadId);
    const message = await ctx.db.get(stream.messageId);
    if (!thread || !message) return null;

    const settings = await ctx.db
      .query("chatSettings")
      .withIndex("by_user_workspace", (q) =>
        q.eq("userId", stream.userId).eq("workspaceId", stream.workspaceId),
      )
      .unique();

    const history = await buildHistory(ctx, stream.threadId, message.seq);

    return {
      streamId,
      threadId: stream.threadId,
      messageId: stream.messageId,
      userId: stream.userId,
      workspaceId: stream.workspaceId,
      model: message.model ?? thread.model,
      systemPrompt: thread.systemPrompt ?? settings?.systemPrompt ?? null,
      customInstructionsAbout: settings?.customInstructionsAbout ?? null,
      customInstructionsStyle: settings?.customInstructionsStyle ?? null,
      summary: thread.summary ?? null,
      summaryThroughSeq: thread.summaryThroughSeq ?? 0,
      history,
      titleNeeded: thread.titleSource === "auto",
    };
  },
});

/**
 * Hand the turn to the Python inference plane.
 *
 * Mirrors jobs.processJob exactly: fire-and-forget POST, any non-2xx is
 * terminal, and failure is reported back through the normal finalize path so
 * the message never hangs in "pending".
 */
export const dispatch = internalAction({
  args: { streamId: v.string() },
  handler: async (ctx, { streamId }) => {
    const base = process.env.AI_BASE_URL;
    const key = process.env.AI_SERVICE_KEY;
    if (!base || !key) {
      await ctx.runMutation(internal.chat.ingest.failStream, {
        streamId,
        error: "Chat is not configured (AI_BASE_URL / AI_SERVICE_KEY unset)",
        errorCode: "not_configured",
      });
      return;
    }

    const payload = await ctx.runQuery(internal.chat.stream.dispatchPayload, {
      streamId,
    });
    if (!payload) return; // stream vanished (thread deleted mid-dispatch)

    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/v1/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-service-key": key,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        await ctx.runMutation(internal.chat.ingest.failStream, {
          streamId,
          error: `Inference service responded ${res.status}`,
          errorCode: "dispatch_failed",
        });
      }
    } catch (e) {
      await ctx.runMutation(internal.chat.ingest.failStream, {
        streamId,
        error: e instanceof Error ? e.message : "Inference service unreachable",
        errorCode: "dispatch_unreachable",
      });
    }
  },
});

/**
 * Cron: finalize streams whose worker died.
 *
 * Without this, a SIGKILLed Python process leaves a message spinning forever —
 * no in-process `finally:` runs in that case, and systemd restarts it with an
 * empty task registry.
 */
export const reapStalled = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - STALL_MS;
    const stalled = await ctx.db
      .query("chatStreams")
      .withIndex("by_status_heartbeat", (q) =>
        q.eq("status", "running").lt("heartbeatAt", cutoff),
      )
      .take(25);

    // Also catch streams that never started — a dispatch that never landed.
    const neverStarted = await ctx.db
      .query("chatStreams")
      .withIndex("by_status_heartbeat", (q) =>
        q.eq("status", "queued").lt("heartbeatAt", cutoff),
      )
      .take(25);

    for (const s of [...stalled, ...neverStarted]) {
      await ctx.runMutation(internal.chat.ingest.failStream, {
        streamId: s.streamId,
        error: "The response timed out",
        errorCode: "timeout",
      });
    }
    return stalled.length + neverStarted.length;
  },
});

/** Guard used by the ingress: unknown or terminal streams write nothing. */
export function isTerminal(status: string): boolean {
  return status === "done" || status === "error" || status === "aborted";
}

export { STALL_MS };
