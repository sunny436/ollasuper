import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { requireMember } from "../orgs";

/**
 * Authorization for the Scheduled Tasks plane.
 *
 * Scheduled tasks inherit CHAT's trust model, not the workspace one. A
 * scheduled task carries a user's standing prompt — "summarise my inbox",
 * "review my portfolio" — which is exactly as private as a conversation. A
 * legitimate same-workspace peer must be refused.
 *
 * Every non-owner therefore gets "Not found", never "Forbidden", so the error
 * can never be an existence oracle for someone else's taskId. This file is a
 * deliberate mirror of chat/authz.ts; it lives separately from orgs.ts for the
 * same import-cycle reason.
 */

/** The userId is always derived from the session, never accepted as an argument. */
export async function requireUserId(ctx: QueryCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not authenticated");
  return userId;
}

/**
 * Ownership is checked BEFORE workspace membership, deliberately — see
 * chat/authz.ts:requireThreadAccess. The requireMember call is unreachable for
 * outsiders; it exists to catch an owner who has since been removed from the
 * workspace, and only ever throws "Forbidden" for that case.
 *
 * A soft-deleted task is "Not found" to everyone, including its owner.
 */
export async function requireTaskAccess(
  ctx: QueryCtx,
  userId: Id<"users">,
  taskId: Id<"scheduledTasks">,
): Promise<Doc<"scheduledTasks">> {
  const task = await ctx.db.get(taskId);
  if (!task || task.userId !== userId || task.status === "deleted") {
    throw new ConvexError("Not found");
  }
  await requireMember(ctx, userId, task.workspaceId);
  return task;
}

export async function requireOccurrenceAccess(
  ctx: QueryCtx,
  userId: Id<"users">,
  occurrenceId: Id<"scheduledTaskOccurrences">,
): Promise<{
  occurrence: Doc<"scheduledTaskOccurrences">;
  task: Doc<"scheduledTasks">;
}> {
  const occurrence = await ctx.db.get(occurrenceId);
  if (!occurrence || occurrence.userId !== userId) {
    throw new ConvexError("Not found");
  }
  // Re-derive from the task — never trust the denormalised userId alone.
  const task = await requireTaskAccess(ctx, userId, occurrence.taskId);
  return { occurrence, task };
}

/**
 * Server-side entitlement re-check, used by the scheduler at claim time.
 *
 * A task is created by an entitled user, but it then runs unattended for
 * months. If the owner is later suspended or removed from the workspace,
 * nothing in orgs.removeMember or the account-status flow knows about
 * scheduled tasks — so without this the task would keep executing on their
 * behalf indefinitely. Returns a reason string when NOT entitled, else null.
 *
 * Deliberately checked once per occurrence (at claim) rather than per tick.
 */
export async function ownerEntitlementFailure(
  ctx: QueryCtx,
  task: Doc<"scheduledTasks">,
): Promise<string | null> {
  const user = await ctx.db.get(task.userId);
  if (!user) return "owner_missing";
  if (user.accountStatus && user.accountStatus !== "active") {
    return "owner_not_active";
  }
  const membership = await ctx.db
    .query("members")
    .withIndex("by_user_workspace", (q) =>
      q.eq("userId", task.userId).eq("workspaceId", task.workspaceId),
    )
    .unique();
  if (!membership) return "owner_not_member";
  return null;
}
