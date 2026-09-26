import { v } from "convex/values";
import { activeUserId } from "./accountState";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, query } from "./_generated/server";
import { audit } from "./auditLog";
import { hasWorkspaceAccess } from "./orgs";

/**
 * Phase 7 — the durable, owner-scoped SEO MUTATION ledger.
 *
 * `recordResult` is the ONLY writer, called from `http.ts` (`op:"seo-mutation-result"`,
 * ingress-secret-verified) at EXECUTE time — after the Python `SeoWriteAdapter` has run the
 * approved write through its before→write→verify→rollback wrapper. Owner/workspace/thread ids
 * are DERIVED from the stream (never client-sent), exactly like `chat/executions.ts`. Idempotent
 * by `approvalId` (a site change is authorized by exactly one single-use approval). Every write
 * is audited. Reads are user-trust owner-scoped (a non-owner gets "Not found", never an oracle).
 */

// Defensive ceiling on each bounded-JSON blob (the Python emitter already bounds these; this
// is a second guard so a mis-sized before/after snapshot can never bloat a row).
const MAX_JSON = 24_000;

function bound(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s.length > MAX_JSON ? `${s.slice(0, MAX_JSON)}…(truncated)` : s;
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

const actionValidator = v.union(
  v.literal("update_metadata"),
  v.literal("update_structured_data"),
  v.literal("propose_redirect"),
  v.literal("update_content"),
);
const statusValidator = v.union(
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("verification_failed"),
  v.literal("precondition_failed"),
  v.literal("rolled_back"),
  v.literal("rollback_failed"),
);
const rollbackValidator = v.union(
  v.literal("none"),
  v.literal("not_needed"),
  v.literal("succeeded"),
  v.literal("failed"),
);

/**
 * Ingress `op:"seo-mutation-result"`: record the outcome of ONE approved SEO write. Idempotent
 * by `approvalId` — a resume re-emit updates the SAME row (never a second write in the ledger).
 * Owner is DERIVED from the stream; a dead/unknown stream is rejected (no orphan rows).
 */
export const recordResult = internalMutation({
  args: {
    streamId: v.string(),
    approvalId: v.string(),
    executionId: v.optional(v.string()),
    toolId: v.string(),
    action: actionValidator,
    target: v.string(),
    provider: v.string(),
    argsHash: v.string(),
    reversibility: v.union(v.literal("reversible"), v.literal("irreversible")),
    estimatedCost: v.optional(v.string()),
    status: statusValidator,
    before: v.optional(v.string()),
    after: v.optional(v.string()),
    verification: v.optional(v.string()),
    rollbackStatus: rollbackValidator,
  },
  handler: async (ctx, a) => {
    const stream = await loadStream(ctx, a.streamId);
    if (!stream) return { ok: false, unknown: true };

    const now = Date.now();
    const existing = await ctx.db
      .query("seoMutations")
      .withIndex("by_approval", (q) => q.eq("approvalId", a.approvalId))
      .unique();

    const fields = {
      executionId: a.executionId,
      toolId: a.toolId,
      action: a.action,
      target: a.target,
      provider: a.provider,
      argsHash: a.argsHash,
      reversibility: a.reversibility,
      estimatedCost: bound(a.estimatedCost),
      status: a.status,
      before: bound(a.before),
      after: bound(a.after),
      verification: bound(a.verification),
      rollbackStatus: a.rollbackStatus,
      updatedAt: now,
    };

    if (existing) {
      // Idempotent re-emit on resume: update in place, never insert a duplicate.
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("seoMutations", {
        approvalId: a.approvalId,
        // Owner + context DERIVED from the stream — never client-sent.
        userId: stream.userId,
        workspaceId: stream.workspaceId,
        streamId: a.streamId,
        threadId: stream.threadId,
        messageId: stream.messageId,
        createdAt: now,
        ...fields,
      });
    }
    // Audit every recorded outcome (workspace-level "a mutation happened"; the detailed
    // before/after stays in the user-scoped row above, which co-members cannot read).
    await audit(ctx, stream.workspaceId, stream.userId, "seo.mutation_recorded", {
      action: a.action,
      target: a.target,
      provider: a.provider,
      status: a.status,
      rollbackStatus: a.rollbackStatus,
      approvalId: a.approvalId,
    });
    return { ok: true, cancel: stream.cancelRequested };
  },
});

function publicRow(r: Doc<"seoMutations">) {
  // Never leak internal handles; expose the auditable result shape (spec point 8).
  return {
    _id: r._id,
    action: r.action,
    target: r.target,
    provider: r.provider,
    reversibility: r.reversibility,
    status: r.status,
    rollbackStatus: r.rollbackStatus,
    before: r.before ?? null,
    after: r.after ?? null,
    verification: r.verification ?? null,
    estimatedCost: r.estimatedCost ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** The caller's own SEO mutation history (auditable trail). User-trust owner-scoped. */
export const listMyMutations = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const userId = await activeUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("seoMutations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(Math.min(Math.max(1, limit ?? 50), 200));
    // Owner AND current member of the row's workspace (audit F-08).
    const entitled = new Map<string, boolean>();
    const visible: typeof rows = [];
    for (const r of rows) {
      let ok = entitled.get(r.workspaceId);
      if (ok === undefined) {
        ok = await hasWorkspaceAccess(ctx, userId, r.workspaceId);
        entitled.set(r.workspaceId, ok);
      }
      if (ok) visible.push(r);
    }
    return visible.map(publicRow);
  },
});

/** One mutation record. Non-owner → "Not found" (never an existence oracle). */
export const getMutation = query({
  args: { mutationId: v.id("seoMutations") },
  handler: async (ctx, { mutationId }) => {
    const userId = await activeUserId(ctx);
    if (!userId) throw new Error("Not found");
    const row = await ctx.db.get(mutationId);
    if (!row || row.userId !== userId) throw new Error("Not found");
    if (!(await hasWorkspaceAccess(ctx, userId, row.workspaceId))) {
      throw new Error("Not found");
    }
    return publicRow(row);
  },
});

/** Cascade helper — delete every mutation row for a user (called from users.deleteUserAccount). */
export async function deleteMutationsForUser(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const rows = await ctx.db
    .query("seoMutations")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}

/** Cascade helper — delete every mutation row for a thread (called from the chat thread purge). */
export async function deleteMutationsForThread(
  ctx: MutationCtx,
  threadId: Id<"chatThreads">,
): Promise<void> {
  const rows = await ctx.db
    .query("seoMutations")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}
