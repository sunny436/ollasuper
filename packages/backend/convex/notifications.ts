import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";

const MAX_TITLE = 120;
const MAX_BODY = 500;

/**
 * Dependency-free helper to emit an in-app notification to a user.
 *
 * `link` (Phase 3) carries an IDEMPOTENCY key plus a deep-link target. When
 * `dedupeKey` is supplied the insert is skipped if a row already exists for
 * (userId, dedupeKey) — and because Convex mutations are serialisable, that
 * lookup joins the transaction's read set, so two concurrent callers cannot
 * both pass the check: the loser conflicts, re-runs, and sees the row. This is
 * what makes a DBOS replay / dispatch retry / duplicate finalize produce ONE
 * notification rather than three.
 *
 * Title and body are hard-clamped so an unexpectedly large error string can
 * never push the document over a Convex limit — which, inside the finalize
 * transaction, would abort the occurrence's terminal transition.
 */
export async function notify(
  ctx: MutationCtx,
  userId: Id<"users">,
  type: string,
  title: string,
  body?: string,
  link?: {
    dedupeKey?: string;
    taskId?: Id<"scheduledTasks">;
    occurrenceKey?: string;
  },
): Promise<boolean> {
  if (link?.dedupeKey) {
    const existing = await ctx.db
      .query("notifications")
      .withIndex("by_user_dedupe", (q) =>
        q.eq("userId", userId).eq("dedupeKey", link.dedupeKey),
      )
      .first();
    if (existing) return false;
  }
  await ctx.db.insert("notifications", {
    userId,
    type,
    title: title.slice(0, MAX_TITLE),
    body: body?.slice(0, MAX_BODY),
    read: false,
    createdAt: Date.now(),
    dedupeKey: link?.dedupeKey,
    taskId: link?.taskId,
    occurrenceKey: link?.occurrenceKey,
  });
  return true;
}

export const myNotifications = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(20);
  },
});

export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return 0;
    // Indexed + capped: the bell only distinguishes 0..9 and "9+", so reading at
    // most 10 unread rows is enough — O(10) instead of O(all notifications).
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_user_read", (q) => q.eq("userId", userId).eq("read", false))
      .take(10);
    return rows.length;
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return;
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("read"), false))
      .collect();
    for (const n of unread) await ctx.db.patch(n._id, { read: true });
  },
});
