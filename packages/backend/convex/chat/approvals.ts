import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
  internalMutation,
  mutation,
  type MutationCtx,
  type QueryCtx,
  query,
} from "../_generated/server";
import { audit } from "../auditLog";
import { getUserIdOrNull, requireThreadAccess, requireUserId } from "./authz";
import { eventObject } from "./events";
import { finalizeError } from "./ingest";

/**
 * Phase 8 — durable tool-approval round-trip.
 *
 * A HIGH_IMPACT tool that needs approval parks a `chatApprovals` row and flips
 * its stream to `waiting_approval` (invisible to the stall reaper). The user
 * resolves it here; the expiry reaper fails it after the TTL. The approval TOKEN
 * (minted server-side on approve) is the ONLY execute capability — absent /
 * expired / rejected NEVER executes the tool. Reuses the Phase-7 durable
 * substrate: the event log is the checkpoint, `redispatch` re-runs the turn.
 */

// Mirror of AGENT_TOTAL_DEADLINE_MS in chat/messages.ts. A fresh execution
// deadline on resume: the human deliberation window is NOT part of the tool's
// execution budget, so the original (possibly already-passed) deadlineAt must
// not immediately re-fail the resumed turn.
const AGENT_TOTAL_DEADLINE_MS = 300_000;

async function loadStreamById(ctx: MutationCtx | QueryCtx, streamId: string) {
  return await ctx.db
    .query("chatStreams")
    .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
    .unique();
}

/**
 * Ingress `op:"approval"`: park an approval + suspend the stream. Idempotent by
 * (streamId, approvalId) — a re-emitted request on resume upserts the SAME row.
 * If the row is already resolved (a live run learning of a prior decision), the
 * decision (+token) is handed back so the run can act inline without suspending.
 */
export const requestApproval = internalMutation({
  args: {
    streamId: v.string(),
    approvalId: v.string(),
    toolId: v.string(),
    toolName: v.string(),
    argsKey: v.string(),
    reason: v.string(),
    ttlMs: v.number(),
    event: eventObject,
  },
  handler: async (ctx, a) => {
    const stream = await loadStreamById(ctx, a.streamId);
    if (!stream) return { ok: false, unknown: true };
    // Never park onto a stopped/finished turn.
    if (
      stream.status === "done" ||
      stream.status === "error" ||
      stream.status === "aborted" ||
      stream.cancelRequested
    ) {
      return { ok: true, cancel: true, terminal: true };
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("chatApprovals")
      .withIndex("by_stream_approval", (q) =>
        q.eq("streamId", a.streamId).eq("approvalId", a.approvalId),
      )
      .unique();
    if (existing) {
      // Duplicate request (resume re-emit): one row, never two.
      if (existing.status === "pending") return { ok: true, decision: "pending" };
      // Already resolved → hand the decision to the live run.
      return { ok: true, decision: existing.status, token: existing.token ?? null };
    }

    // Insert the APPROVAL_REQUEST event (idempotent on (messageId, seq)) so the
    // existing chip/dialog renders.
    const dup = await ctx.db
      .query("chatStreamEvents")
      .withIndex("by_message_seq", (q) =>
        q.eq("messageId", stream.messageId).eq("seq", a.event.seq),
      )
      .unique();
    if (!dup) {
      await ctx.db.insert("chatStreamEvents", {
        messageId: stream.messageId,
        streamId: a.streamId,
        ...a.event,
      });
    }

    await ctx.db.insert("chatApprovals", {
      approvalId: a.approvalId,
      streamId: a.streamId,
      messageId: stream.messageId,
      threadId: stream.threadId,
      workspaceId: stream.workspaceId,
      userId: stream.userId,
      toolId: a.toolId,
      toolName: a.toolName,
      argsKey: a.argsKey,
      reason: a.reason,
      status: "pending",
      createdAt: now,
      expiresAt: now + a.ttlMs,
    });

    // Suspend the stream — only from a live state.
    if (stream.status === "running" || stream.status === "queued") {
      await ctx.db.patch(stream._id, {
        status: "waiting_approval",
        hasEvents: true,
        heartbeatAt: now,
      });
    }
    await audit(ctx, stream.workspaceId, stream.userId, "agent.approval_requested", {
      toolName: a.toolName,
    });
    return { ok: true, decision: "pending" };
  },
});

/**
 * The user's decision. Owner-only (a non-owner gets "Not found", never an
 * existence oracle). Idempotent on a non-pending row. Mints the execute token on
 * approve, requeues the stream with a FRESH deadline, and re-dispatches through
 * the Phase-7 `redispatch` (which threads the decision back to Python).
 */
export const resolve = mutation({
  args: {
    approvalId: v.id("chatApprovals"),
    decision: v.union(v.literal("approve"), v.literal("reject")),
  },
  handler: async (ctx, { approvalId, decision }) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db.get(approvalId);
    if (!row) throw new ConvexError("Not found");
    await requireThreadAccess(ctx, userId, row.threadId); // owner-only
    if (row.status !== "pending") return { status: row.status };

    const stream = await loadStreamById(ctx, row.streamId);
    const now = Date.now();
    if (!stream || stream.status !== "waiting_approval") {
      // The turn moved on (stopped / terminal) while the dialog was open.
      await ctx.db.patch(approvalId, {
        status: "cancelled",
        resolvedAt: now,
        resolvedBy: userId,
      });
      return { status: "cancelled" };
    }

    const approved = decision === "approve";
    const token = approved ? crypto.randomUUID() : undefined;
    await ctx.db.patch(approvalId, {
      status: approved ? "approved" : "rejected",
      resolvedAt: now,
      resolvedBy: userId,
      token,
    });
    await ctx.db.patch(stream._id, {
      status: "queued",
      heartbeatAt: now,
      attempts: 0,
      deadlineAt: now + AGENT_TOTAL_DEADLINE_MS,
    });
    await audit(
      ctx,
      row.workspaceId,
      userId,
      approved ? "agent.approval_approved" : "agent.approval_rejected",
      { toolName: row.toolName },
    );
    await ctx.scheduler.runAfter(0, internal.chat.stream.redispatch, {
      streamId: row.streamId,
    });
    return { status: approved ? "approved" : "rejected" };
  },
});

/** The pending approval for a thread, for the dialog. Owner-scoped. */
export const pending = query({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return null;
    const tid = ctx.db.normalizeId("chatThreads", threadId);
    if (!tid) return null;
    const thread = await ctx.db.get(tid);
    if (!thread || thread.userId !== userId) return null;
    const row = await ctx.db
      .query("chatApprovals")
      .withIndex("by_thread_status", (q) =>
        q.eq("threadId", tid).eq("status", "pending"),
      )
      .first();
    if (!row) return null;
    return {
      _id: row._id,
      approvalId: row.approvalId,
      toolName: row.toolName,
      reason: row.reason,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  },
});

/** Cron: expire pending approvals past their TTL and terminate the parked turn. */
export const reapExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("chatApprovals")
      .withIndex("by_status_expiresAt", (q) =>
        q.eq("status", "pending").lt("expiresAt", now),
      )
      .take(25);
    let expired = 0;
    for (const a of due) {
      await ctx.db.patch(a._id, { status: "expired", resolvedAt: now });
      const stream = await loadStreamById(ctx, a.streamId);
      // Expiry TERMINATES (the tool must NOT run). finalizeError, not the
      // guarded failStream (which no-ops on waiting_approval).
      if (stream && stream.status === "waiting_approval") {
        await finalizeError(ctx, stream as Doc<"chatStreams">, {
          error: "The approval request expired",
          errorCode: "approval_expired",
        });
      }
      expired++;
    }
    return { expired };
  },
});

/**
 * Resolved approvals for a stream, threaded into the dispatch payload so the
 * resumed Python run learns each decision (+token). Read-only; QueryCtx.
 */
export async function resolvedApprovalsForStream(
  ctx: QueryCtx,
  streamId: string,
) {
  const rows = await ctx.db
    .query("chatApprovals")
    .withIndex("by_stream_approval", (q) => q.eq("streamId", streamId))
    .collect();
  return rows
    .filter((r) => r.status !== "pending" && r.status !== "cancelled")
    .map((r) => ({
      approvalId: r.approvalId,
      toolId: r.toolId,
      argsKey: r.argsKey,
      decision: r.status as "approved" | "rejected" | "expired",
      token: r.token ?? null,
    }));
}
