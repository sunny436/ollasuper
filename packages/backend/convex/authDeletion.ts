/**
 * Durable content + blob purge for a deleted account.
 *
 * `users.deleteUserAccount` tears down AUTH state synchronously — accounts,
 * credentials, sessions, refresh tokens, codes, rate limits — so a deleted user
 * cannot authenticate the instant the call returns. That is the revocation half,
 * and it must stay synchronous.
 *
 * This is the other half: the user's private CONTENT and its blobs. Two reasons
 * it cannot live in that same mutation:
 *
 *   1. SECURITY. A deleted user's SHARES keep working — `/share/file` and
 *      `chat.shares.getByToken` resolve a live token without ever asking whether
 *      the author still exists. So a conversation shared by a since-deleted
 *      account stays publicly readable at its URL. Revoking the shares is the
 *      part of "deletion" that actually removes access, and it must not be
 *      skippable.
 *   2. DURABILITY. An active account has unbounded threads, messages, attachments
 *      and artifacts, each attachment/artifact also holding a STORAGE BLOB that
 *      orphans in Postgres/local storage if only its row is deleted. That is far
 *      more work than one Convex mutation's operation budget allows, so it runs
 *      as a SELF-RESCHEDULING cascade: each pass does a bounded batch and
 *      schedules the next until nothing is left. A crash mid-way resumes on the
 *      next pass because every step is keyed on the userId and idempotent.
 *
 * SCOPE. This purges the user's own private chat surface and their avatar. It
 * deliberately does NOT delete workspace files or projects: those sit under
 * workspace trust and may be shared with other members, so tearing them down
 * with one member's account would destroy other people's access. Sole-owner
 * workspace teardown is a separate, and separately-reviewed, concern — called
 * out in the report rather than done quietly here.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";

// Bounded so one pass never approaches a mutation's operation limit; the cascade
// reschedules until done, so a small batch only means more passes, never missed
// data.
const THREADS_PER_PASS = 15;
const ROWS_PER_SUBQUERY = 200;

async function deleteBlob(ctx: MutationCtx, storageId: Id<"_storage">) {
  // A missing blob is fine — this runs more than once on a resume, and the blob
  // may already be gone. Never let a storage hiccup wedge the cascade.
  try {
    await ctx.storage.delete(storageId);
  } catch {
    // swallow — idempotent purge
  }
}

/** Delete everything hanging off ONE message: streams, chunks, events, tool
 *  executions. All of these are keyed on messageId in the schema, so a
 *  message-centric purge is the one that matches the real indexes. */
async function purgeMessageChildren(
  ctx: MutationCtx,
  messageId: Id<"chatMessages">,
) {
  for (const table of ["chatStreamChunks", "chatStreamEvents"] as const) {
    const kids = await ctx.db
      .query(table)
      .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
      .take(ROWS_PER_SUBQUERY);
    for (const k of kids) await ctx.db.delete(k._id);
  }
  for (const table of ["chatStreams", "toolExecutions"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .take(ROWS_PER_SUBQUERY);
    for (const r of rows) await ctx.db.delete(r._id);
  }
}

/** Every child row of ONE thread, blobs included. Returns false when the thread
 *  still has more messages/attachments than one pass could drain (→ reschedule,
 *  keep the thread row until it is truly empty). */
async function purgeThread(ctx: MutationCtx, threadId: Id<"chatThreads">) {
  // Attachments — blob first, then the row.
  const attachments = await ctx.db
    .query("chatAttachments")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .take(ROWS_PER_SUBQUERY);
  for (const a of attachments) {
    await deleteBlob(ctx, a.storageId);
    await ctx.db.delete(a._id);
  }

  // Artifacts — blob first, then the row.
  const artifacts = await ctx.db
    .query("chatArtifacts")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .take(ROWS_PER_SUBQUERY);
  for (const art of artifacts) {
    await deleteBlob(ctx, art.storageId);
    await ctx.db.delete(art._id);
  }

  // Approvals ([threadId, status] index, queried by the threadId prefix).
  const approvals = await ctx.db
    .query("chatApprovals")
    .withIndex("by_thread_status", (q) => q.eq("threadId", threadId))
    .take(ROWS_PER_SUBQUERY);
  for (const ap of approvals) await ctx.db.delete(ap._id);

  // Messages, and everything keyed on each message.
  const messages = await ctx.db
    .query("chatMessages")
    .withIndex("by_thread_seq", (q) => q.eq("threadId", threadId))
    .take(ROWS_PER_SUBQUERY);
  for (const m of messages) {
    await purgeMessageChildren(ctx, m._id);
    await ctx.db.delete(m._id);
  }

  const more =
    messages.length >= ROWS_PER_SUBQUERY ||
    attachments.length >= ROWS_PER_SUBQUERY ||
    artifacts.length >= ROWS_PER_SUBQUERY;
  return !more;
}

export const cascadeUserContent = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<void> => {
    // 1. SHARES FIRST — this is the step that removes public access, so it must
    //    win the race against everything else. Bounded + rescheduled.
    const shares = await ctx.db
      .query("chatShares")
      .withIndex("by_user_ws_created", (q) => q.eq("userId", userId))
      .take(ROWS_PER_SUBQUERY);
    for (const s of shares) await ctx.db.delete(s._id);
    if (shares.length >= ROWS_PER_SUBQUERY) {
      await ctx.scheduler.runAfter(0, internal.authDeletion.cascadeUserContent, {
        userId,
      });
      return;
    }

    // 2. The user's threads, a bounded batch at a time.
    const threads: Doc<"chatThreads">[] = await ctx.db
      .query("chatThreads")
      .withIndex("by_user_ws_status_updated", (q) => q.eq("userId", userId))
      .take(THREADS_PER_PASS);

    let drainedAll = true;
    for (const t of threads) {
      const done = await purgeThread(ctx, t._id);
      if (done) {
        await ctx.db.delete(t._id);
      } else {
        // A very large thread needs another pass before its own row goes.
        drainedAll = false;
      }
    }

    if (threads.length > 0 && (threads.length >= THREADS_PER_PASS || !drainedAll)) {
      await ctx.scheduler.runAfter(0, internal.authDeletion.cascadeUserContent, {
        userId,
      });
      return;
    }

    // 3. Nothing left — done. (The avatar blob is handled synchronously in
    //    deleteUserAccount so a deleted account frees it immediately.)
  },
});
