import { activeUserId } from "./accountState";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";

const MAX_TITLE = 120;
const MAX_BODY = 500;
/** One page of the notification centre. */
const PAGE_SIZE = 20;
/**
 * Ceiling on a single markAllRead. A user's history is never pruned — there is
 * no retention cron for this table — so an unbounded collect() grows without
 * limit. Reading at most this many per call keeps the mutation bounded; the UI
 * simply calls it again while a full page comes back.
 */
const MARK_ALL_LIMIT = 200;

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
    occurrenceId?: Id<"scheduledTaskOccurrences">;
    threadId?: Id<"chatThreads">;
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
    occurrenceId: link?.occurrenceId,
    threadId: link?.threadId,
  });
  return true;
}

export const myNotifications = query({
  args: {
    /**
     * Cursor: return rows strictly older than this `createdAt`. Absent = the
     * newest page. Optional so the existing call site keeps working unchanged.
     */
    before: v.optional(v.number()),
  },
  handler: async (ctx, { before }) => {
    const userId = await activeUserId(ctx);
    if (!userId) return { page: [], nextCursor: null };
    // The cursor is applied INSIDE the query, not to the result: filtering a
    // fixed newest-N slice afterwards would make every page after the first
    // come back empty.
    const base = ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId));
    const rows = await (
      before === undefined
        ? base
        : base.filter((q) => q.lt(q.field("createdAt"), before))
    )
      .order("desc")
      // One extra row is the "is there more?" probe — cheaper and more accurate
      // than comparing the page length to the page size.
      .take(PAGE_SIZE + 1);
    const page = rows.slice(0, PAGE_SIZE);
    const nextCursor =
      rows.length > PAGE_SIZE
        ? (page[page.length - 1]?.createdAt ?? null)
        : null;
    return { page, nextCursor };
  },
});

export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const userId = await activeUserId(ctx);
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

/**
 * Mark ONE notification read, by its owner.
 *
 * The id comes from the browser, so ownership is re-derived from the
 * authenticated context and compared before the patch — a notificationId is
 * otherwise a cross-user write primitive. A foreign or missing id is a silent
 * no-op rather than a throw: the id is not an existence oracle for someone
 * else's row, the same rule chat/authz.ts follows for threads.
 */
export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const userId = await activeUserId(ctx);
    if (!userId) return;
    const row = await ctx.db.get(notificationId);
    if (!row || row.userId !== userId || row.read) return;
    await ctx.db.patch(notificationId, { read: true });
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await activeUserId(ctx);
    if (!userId) return { remaining: false };
    // by_user_read, not by_user + filter: the index is exact, so this reads only
    // unread rows instead of scanning the user's whole history.
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_read", (q) => q.eq("userId", userId).eq("read", false))
      .take(MARK_ALL_LIMIT);
    for (const n of unread) await ctx.db.patch(n._id, { read: true });
    // Tells the caller to go again rather than silently leaving rows unread.
    return { remaining: unread.length === MARK_ALL_LIMIT };
  },
});
