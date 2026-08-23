import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  type QueryCtx,
  query,
} from "../_generated/server";
import { loadMemoriesForDispatch } from "../memories";
import { userHasReadyFiles } from "../userFiles";
import { resolvedApprovalsForStream } from "./approvals";
import { getUserIdOrNull, requireMessageAccess, requireUserId } from "./authz";
import { buildHistory } from "./messages";
import { contextWindowFor } from "./models";

/**
 * A stream is considered dead if the Python service has not sent a delta or a
 * heartbeat within this window. Python heartbeats every 5s, so 90s is ~18
 * missed beats — comfortably past a slow model warm-up or a brief GC pause.
 */
const STALL_MS = 90_000;
// Phase 7: how many times the reaper re-dispatches a crashed turn before giving
// up (mirrors userFiles MAX_ATTEMPTS). Bounds a crash-loop.
const MAX_RESUME_ATTEMPTS = 3;

/** Upper bound on chunk rows the tail query will read. Compaction keeps ~24. */
const MAX_RESIDENT_CHUNKS = 64;
// Typed events are low-volume (not per-token); a generous cap is plenty.
const MAX_RESIDENT_EVENTS = 256;

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

    // Typed events (Phase 3) — read only when this generation has any, so a
    // normal text turn pays for zero extra work. Low-volume, so return all rows
    // (no compaction/watermark like text).
    const events = stream.hasEvents
      ? (
          await ctx.db
            .query("chatStreamEvents")
            .withIndex("by_message_seq", (q) => q.eq("messageId", message._id))
            .take(MAX_RESIDENT_EVENTS)
        )
          .sort((a, b) => a.seq - b.seq)
          .map((e) => ({
            eventId: e.eventId,
            seq: e.seq,
            type: e.type,
            v: e.v,
            ts: e.ts,
            textOffset: e.textOffset,
            payload: e.payload,
          }))
      : [];

    // Phase 8: the pending approval (if the turn is parked) rides this same hot
    // subscription so the dialog appears + survives refresh with no extra query.
    const pendingApproval =
      stream.status === "waiting_approval"
        ? await ctx.db
            .query("chatApprovals")
            .withIndex("by_thread_status", (q) =>
              q.eq("threadId", tid).eq("status", "pending"),
            )
            .first()
        : null;

    return {
      messageId: message._id,
      seq: message.seq,
      status: stream.status,
      cancelRequested: stream.cancelRequested,
      model: message.model ?? thread.model,
      events,
      // Sent so the Python plane can size its context budget and clamp
      // max_tokens for small-context models -- 4095-token models exist, and a
      // fixed 8192-token output request is an immediate provider 400. 0 means
      // "unknown", and Python keeps its own conservative default.
      contextWindow: await contextWindowFor(ctx, message.model ?? thread.model),
      // Client renders committedText + chunks joined in seq order.
      committedText: stream.committedText,
      chunks: chunks.map((c) => ({ seq: c.seq, text: c.text })),
      startedAt: stream.startedAt,
      pendingApproval: pendingApproval
        ? {
            _id: pendingApproval._id,
            approvalId: pendingApproval.approvalId,
            toolName: pendingApproval.toolName,
            reason: pendingApproval.reason,
            expiresAt: pendingApproval.expiresAt,
          }
        : null,
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
    // Purge live event rows too (aborted turns keep no folded events).
    const events = await ctx.db
      .query("chatStreamEvents")
      .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
      .collect();
    for (const e of events) await ctx.db.delete(e._id);
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

    // Phase 8: stopping a parked turn cancels its pending approval so it can
    // never be resolved-into a dead stream.
    const approvals = await ctx.db
      .query("chatApprovals")
      .withIndex("by_stream_approval", (q) => q.eq("streamId", stream.streamId))
      .collect();
    for (const ap of approvals) {
      if (ap.status === "pending")
        await ctx.db.patch(ap._id, { status: "cancelled", resolvedAt: now });
    }
  },
});

/** Everything the Python service needs for one generation, in one read. */
/**
 * Phase 7 resume checkpoint: reconstruct the already-completed tool steps from
 * the LIVE typed-event log (still present while status is running) so the
 * resumed run does NOT re-execute side-effecting tools. Pairs each successful
 * TOOL_CALL with its TOOL_RESULT by call_id; the durable idempotency key is the
 * `tool_id` in the payload (the model's tool_call id is not resume-stable).
 * Returns the completed steps + the next event seq so the resumed run's new
 * events don't collide with these survivors on the (messageId, seq) probe.
 */
async function collectCompletedTools(
  ctx: QueryCtx,
  messageId: Id<"chatMessages">,
) {
  const rows = await ctx.db
    .query("chatStreamEvents")
    .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
    .collect();
  let maxSeq = -1;
  const calls = new Map<string, { toolId: string; args: unknown }>();
  const results = new Map<string, string>();
  for (const e of rows) {
    if (e.seq > maxSeq) maxSeq = e.seq;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(e.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const cid = body.call_id;
    if (typeof cid !== "string") continue;
    if (e.type === "TOOL_CALL" && typeof body.tool_id === "string") {
      calls.set(cid, { toolId: body.tool_id, args: body.arguments ?? {} });
    } else if (e.type === "TOOL_RESULT" && body.status === "success") {
      const content =
        typeof body.content === "string"
          ? body.content
          : JSON.stringify(body.result ?? {});
      results.set(cid, content.slice(0, 16000));
    }
  }
  const completedTools: {
    toolId: string;
    args: unknown;
    resultContent: string;
  }[] = [];
  for (const [cid, call] of calls) {
    const resultContent = results.get(cid);
    if (resultContent !== undefined) {
      completedTools.push({ toolId: call.toolId, args: call.args, resultContent });
    }
  }
  return { completedTools, eventSeqBaseline: maxSeq + 1 };
}

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
    // Cheap existence check so the inference plane only pays the RAG embedding +
    // pgvector round-trip for users who actually have knowledge-base files.
    const ragFileCount = (await userHasReadyFiles(ctx, stream.userId)) ? 1 : 0;

    // Phase 6: memory is on unless the user explicitly turned it off. When on,
    // pre-load the bounded, scope-correct active set so the agent's search_memory
    // tool can rank it in-Python (no mid-generation round-trip).
    const memoryEnabled = settings?.memoryEnabled !== false;
    const memories = memoryEnabled
      ? await loadMemoriesForDispatch(ctx, stream.userId, stream.workspaceId)
      : [];

    // Reconstruct completed tool steps on a crash-resume (attempts > 0) OR an
    // approval-resume (attempts stays 0, but events survived). Decoupled from
    // `attempt` and mirrored in the Python runner (`if req.completedTools`) so
    // the resumed run's events baseline past the survivors instead of colliding
    // on (messageId, seq). A FIRST dispatch always has hasEvents=false (Python
    // hasn't emitted yet), so this is a no-op there.
    const attempt = stream.attempts ?? 0;
    const resume =
      attempt > 0 || (stream.hasEvents ?? false)
        ? await collectCompletedTools(ctx, stream.messageId)
        : { completedTools: [], eventSeqBaseline: 0 };
    // Phase 8: resolved approval decisions (+token) so the resumed run executes
    // an approved tool / injects a rejection. Empty on a normal turn.
    const approvals = await resolvedApprovalsForStream(ctx, streamId);

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
      ragFileCount,
      memoryEnabled,
      memories,
      // Phase 7 durable resume.
      attempt,
      deadlineAt: stream.deadlineAt ?? 0,
      completedTools: resume.completedTools,
      eventSeqBaseline: resume.eventSeqBaseline,
      // Phase 8 durable approval decisions.
      approvals,
    };
  },
});

/**
 * Is this storageId reachable from this stream's thread?
 *
 * /ai/file used to take a bare storageId, which made the ingress secret a key
 * to EVERY blob in the deployment — the workspace files plane, every user's
 * private chat attachments, avatars. That undid the whole
 * "storageId is never exposed" discipline in chat/attachments.ts and broke the
 * capability model the rest of the ingress is built on.
 *
 * Now the route must present a streamId as well, and the blob must belong to an
 * attachment on that stream's own thread.
 */
export const attachmentInStream = internalQuery({
  args: { streamId: v.string(), storageId: v.string() },
  handler: async (ctx, { streamId, storageId }) => {
    const stream = await ctx.db
      .query("chatStreams")
      .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
      .unique();
    if (!stream) return null;

    // db.system.normalizeId, not db.normalizeId: _storage is a system table and
    // the plain accessor throws rather than returning null, which would make
    // every /ai/file request a 500 and silently break all attachments.
    const sid = ctx.db.system.normalizeId("_storage", storageId);
    if (!sid) return null;

    const attachment = await ctx.db
      .query("chatAttachments")
      .withIndex("by_storage", (q) => q.eq("storageId", sid))
      .first();
    if (!attachment) return null;

    // Must belong to the same user AND the same thread as the stream.
    if (attachment.userId !== stream.userId) return null;
    if (attachment.threadId && attachment.threadId !== stream.threadId) {
      return null;
    }
    return { storageId: sid };
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
 * Phase 7: RE-dispatch a resumed turn. Unlike `dispatch`, this NEVER failStreams
 * on a non-2xx — a `409` means the worker is alive (its Registry rejected the
 * duplicate, so the original run is still converging), and any transient 5xx /
 * unreachable is retried by the next reaper tick within the `attempts` budget.
 * failStreaming here would kill a live or recoverable turn. The stream already
 * got a fresh heartbeat window from `resumeStalledStream`.
 */
export const redispatch = internalAction({
  args: { streamId: v.string() },
  handler: async (ctx, { streamId }) => {
    const base = process.env.AI_BASE_URL;
    const key = process.env.AI_SERVICE_KEY;
    if (!base || !key) return; // unconfigured: the next tick / an operator retries
    const payload = await ctx.runQuery(internal.chat.stream.dispatchPayload, {
      streamId,
    });
    if (!payload) return; // stream vanished
    try {
      await fetch(`${base.replace(/\/$/, "")}/v1/generate`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-service-key": key },
        body: JSON.stringify(payload),
      });
      // 2xx → resumed. 409 → worker alive (benign). Other non-2xx → the reaper
      // retries within attempts. In all cases: do NOT finalize here.
    } catch {
      // Unreachable inference plane: the next reaper tick retries.
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
/**
 * Phase 7: RESUME a crashed turn instead of failing it. Resets the visible text
 * (it regenerates) but PRESERVES the typed events — they are the checkpoint the
 * resumed run rebuilds completed tools from — bumps `attempts` + `heartbeatAt`
 * (a fresh liveness window so we don't self-re-reap), and re-dispatches. Never
 * touches the thread/streamingMessageId so the browser keeps its subscription.
 */
async function resumeStalledStream(ctx: MutationCtx, s: Doc<"chatStreams">) {
  const now = Date.now();
  await ctx.db.patch(s._id, {
    attempts: (s.attempts ?? 0) + 1,
    heartbeatAt: now,
    committedText: "",
    committedSeq: -1,
    chunkSeq: -1,
  });
  // The resumed run re-streams fresh text from delta seq 0, so drop the resident
  // chunks. Events are intentionally left in place (the durable checkpoint).
  const chunks = await ctx.db
    .query("chatStreamChunks")
    .withIndex("by_message_seq", (q) => q.eq("messageId", s.messageId))
    .collect();
  for (const c of chunks) await ctx.db.delete(c._id);
  await ctx.scheduler.runAfter(0, internal.chat.stream.redispatch, {
    streamId: s.streamId,
  });
}

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

    let resumed = 0;
    let failed = 0;
    const now = Date.now();
    for (const s of [...stalled, ...neverStarted]) {
      if (s.cancelRequested) {
        // The user asked to stop — never resume; finalize as the terminal fail.
        await ctx.runMutation(internal.chat.ingest.failStream, {
          streamId: s.streamId,
          error: "Cancelled",
          errorCode: "cancelled",
        });
        failed++;
      } else if (s.deadlineAt != null && now > s.deadlineAt) {
        await ctx.runMutation(internal.chat.ingest.failStream, {
          streamId: s.streamId,
          error: "The response exceeded the time limit",
          errorCode: "deadline",
        });
        failed++;
      } else if ((s.attempts ?? 0) >= MAX_RESUME_ATTEMPTS) {
        await ctx.runMutation(internal.chat.ingest.failStream, {
          streamId: s.streamId,
          error: "The response timed out",
          errorCode: "timeout",
        });
        failed++;
      } else {
        await resumeStalledStream(ctx, s);
        resumed++;
      }
    }
    return { resumed, failed };
  },
});

/** Guard used by the ingress: unknown or terminal streams write nothing. */
export function isTerminal(status: string): boolean {
  return status === "done" || status === "error" || status === "aborted";
}

export { STALL_MS };
