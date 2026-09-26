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
import { blobReferenced, deleteBlobIfUnreferenced } from "./blobOwnership";

// Bounded so one pass never approaches a mutation's operation limit; the cascade
// reschedules until done, so a small batch only means more passes, never missed
// data.
const THREADS_PER_PASS = 15;
const ROWS_PER_SUBQUERY = 200;

async function deleteBlob(ctx: MutationCtx, storageId: Id<"_storage">) {
  // Called AFTER the owning row is gone, in the same transaction. Bytes another
  // row still references (a pre-existing alias) are left alone — deletion must
  // never reach through one owner's row into another's file (audit F-01). A
  // missing blob is fine (a resumed pass); a REAL delete failure is not
  // swallowed any more: it aborts this pass, so the row survives and the next
  // pass or `reconcileOrphans` retries it (audit F-12 — swallowing it deleted
  // the only handle on bytes that were still stored).
  await deleteBlobIfUnreferenced(ctx, storageId);
}

/** Delete everything hanging off ONE message: streams, chunks, events, tool
 *  executions. All of these are keyed on messageId in the schema, so a
 *  message-centric purge is the one that matches the real indexes. */
async function purgeMessageChildren(
  ctx: MutationCtx,
  messageId: Id<"chatMessages">,
): Promise<boolean> {
  // Returns whether every child is gone. The parent message is the ONLY handle
  // on these rows, so deleting it with children still attached orphaned them
  // for good (audit F-12) — it now waits for a pass that drains them all.
  let drained = true;
  for (const table of ["chatStreamChunks", "chatStreamEvents"] as const) {
    const kids = await ctx.db
      .query(table)
      .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
      .take(ROWS_PER_SUBQUERY);
    for (const k of kids) await ctx.db.delete(k._id);
    if (kids.length >= ROWS_PER_SUBQUERY) drained = false;
  }
  for (const table of ["chatStreams", "toolExecutions"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .take(ROWS_PER_SUBQUERY);
    for (const r of rows) await ctx.db.delete(r._id);
    if (rows.length >= ROWS_PER_SUBQUERY) drained = false;
  }
  return drained;
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
    await ctx.db.delete(a._id);
    await deleteBlob(ctx, a.storageId);
  }

  // Artifacts — row, then the blob.
  const artifacts = await ctx.db
    .query("chatArtifacts")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .take(ROWS_PER_SUBQUERY);
  for (const art of artifacts) {
    await ctx.db.delete(art._id);
    await deleteBlob(ctx, art.storageId);
  }

  // Conversation state + artifacts are thread-scoped and were never purged.
  const convState = await ctx.db
    .query("conversationState")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .take(ROWS_PER_SUBQUERY);
  for (const r of convState) await ctx.db.delete(r._id);
  const convArtifacts = await ctx.db
    .query("conversationArtifacts")
    .withIndex("by_thread_seq", (q) => q.eq("threadId", threadId))
    .take(ROWS_PER_SUBQUERY);
  for (const r of convArtifacts) await ctx.db.delete(r._id);

  // Approvals ([threadId, status] index, queried by the threadId prefix).
  const approvals = await ctx.db
    .query("chatApprovals")
    .withIndex("by_thread_status", (q) => q.eq("threadId", threadId))
    .take(ROWS_PER_SUBQUERY);
  for (const ap of approvals) await ctx.db.delete(ap._id);

  // Messages, and everything keyed on each message. A message whose children
  // did not all fit in this pass keeps its row until a later pass drains them.
  const messages = await ctx.db
    .query("chatMessages")
    .withIndex("by_thread_seq", (q) => q.eq("threadId", threadId))
    .take(ROWS_PER_SUBQUERY);
  let childrenPending = false;
  for (const m of messages) {
    if (await purgeMessageChildren(ctx, m._id)) {
      await ctx.db.delete(m._id);
    } else {
      childrenPending = true;
    }
  }

  // EVERY capped collection counts: the thread row is the handle for all of
  // them, so it may go only once each one came back short (audit F-12).
  const more =
    childrenPending ||
    messages.length >= ROWS_PER_SUBQUERY ||
    attachments.length >= ROWS_PER_SUBQUERY ||
    artifacts.length >= ROWS_PER_SUBQUERY ||
    convState.length >= ROWS_PER_SUBQUERY ||
    convArtifacts.length >= ROWS_PER_SUBQUERY ||
    approvals.length >= ROWS_PER_SUBQUERY;
  return !more;
}


/**
 * One bounded pass over the non-chat, user-owned tables. Returns true when it
 * did work (→ the caller reschedules), false when everything is already gone.
 */
async function sweepAccountTables(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  let did = false;

  // API KEYS FIRST — they are live credentials. Revoke before delete so an
  // interrupted sweep cannot leave a usable key behind.
  const keys = await ctx.db
    .query("apiKeys")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(ROWS_PER_SUBQUERY);
  for (const k of keys) {
    if (!k.revoked) await ctx.db.patch(k._id, { revoked: true });
    await ctx.db.delete(k._id);
    did = true;
  }

  // userFiles carry a storage blob.
  const uploads = await ctx.db
    .query("userFiles")
    .withIndex("by_user_ws_created", (q) => q.eq("userId", userId))
    .take(ROWS_PER_SUBQUERY);
  for (const f of uploads) {
    // THE CONVEX ROW AND ITS BLOB ARE ONLY HALF THE FILE. The extracted text
    // and its embeddings live in the PYTHON plane's Postgres, keyed by the
    // `ingestId` capability. `userFiles.remove` purges them; account deletion
    // did NOT, so a deleted user's documents survived in the knowledge DB
    // with a dangling user_id. Same scheduled action, same capability.
    await ctx.scheduler.runAfter(0, internal.userFiles.purge, {
      ingestId: f.ingestId,
    });
    await ctx.db.delete(f._id);
    if (f.storageId) await deleteBlob(ctx, f.storageId);
    did = true;
  }

  // Chat attachments by OWNER. The thread cascade above only reaches
  // attachments bound to a thread; an upload registered with no threadId
  // (attached in the composer, never sent) was reachable by nothing and
  // survived the account with its blob (audit F-12).
  const orphanUploads = await ctx.db
    .query("chatAttachments")
    .withIndex("by_user_ws_created", (q) => q.eq("userId", userId))
    .take(ROWS_PER_SUBQUERY);
  for (const a of orphanUploads) {
    await ctx.db.delete(a._id);
    await deleteBlob(ctx, a.storageId);
    did = true;
  }

  // Projects and their file edges.
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_user_ws_status_updated", (q) => q.eq("userId", userId))
    .take(50);
  for (const pr of projects) {
    const edges = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) => q.eq("projectId", pr._id))
      .take(ROWS_PER_SUBQUERY);
    for (const e of edges) await ctx.db.delete(e._id);
    if (edges.length < ROWS_PER_SUBQUERY) await ctx.db.delete(pr._id);
    did = true;
  }

  // Scheduled tasks: revisions + occurrences, then the task (stops future runs).
  const tasks = await ctx.db
    .query("scheduledTasks")
    .withIndex("by_user_updated", (q) => q.eq("userId", userId))
    .take(25);
  for (const t of tasks) {
    const revs = await ctx.db
      .query("scheduledTaskRevisions")
      .withIndex("by_task_revision", (q) => q.eq("taskId", t._id))
      .take(ROWS_PER_SUBQUERY);
    for (const r of revs) await ctx.db.delete(r._id);
    const occs = await ctx.db
      .query("scheduledTaskOccurrences")
      .withIndex("by_task_scheduled", (q) => q.eq("taskId", t._id))
      .take(ROWS_PER_SUBQUERY);
    for (const o of occs) await ctx.db.delete(o._id);
    if (revs.length < ROWS_PER_SUBQUERY && occs.length < ROWS_PER_SUBQUERY) {
      await ctx.db.delete(t._id);
    }
    did = true;
  }

  // Flat user-scoped tables.
  const notifications = await ctx.db
    .query("notifications")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(ROWS_PER_SUBQUERY);
  for (const n of notifications) {
    await ctx.db.delete(n._id);
    did = true;
  }
  const settings = await ctx.db
    .query("chatSettings")
    .withIndex("by_user_workspace", (q) => q.eq("userId", userId))
    .take(ROWS_PER_SUBQUERY);
  for (const c of settings) {
    await ctx.db.delete(c._id);
    did = true;
  }
  const quotas = await ctx.db
    .query("userQuotas")
    .withIndex("by_user_kind", (q) => q.eq("userId", userId))
    .take(ROWS_PER_SUBQUERY);
  for (const q0 of quotas) {
    await ctx.db.delete(q0._id);
    did = true;
  }

  // MCP CONNECTOR STATE — the stored OAuth tokens are live credentials for the
  // user's third-party accounts (Gmail, Slack, GitHub …). Credential rows go
  // FIRST, by user, so an interrupted sweep cannot leave ciphertext behind that
  // still names a connection; then the connections. Remote revocation is not
  // attempted here: the deletion cascade runs with no session to act through,
  // and a token the plane can no longer read is a token OllaSuper can no
  // longer use, which is the property the account owner is owed (audit H-03).
  const credentials = await ctx.db
    .query("mcpCredentials")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(ROWS_PER_SUBQUERY);
  for (const c of credentials) {
    await ctx.db.delete(c._id);
    did = true;
  }
  const connections = await ctx.db
    .query("mcpConnections")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(ROWS_PER_SUBQUERY);
  for (const c of connections) {
    await ctx.db.delete(c._id);
    did = true;
  }
  const codes = await ctx.db
    .query("accountDeletionCodes")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(ROWS_PER_SUBQUERY);
  for (const c of codes) {
    await ctx.db.delete(c._id);
    did = true;
  }

  // Membership rows. The WORKSPACE itself is only removed when this user was its
  // sole member — a workspace shared with others is refused up front in
  // deleteCurrentUserAccount, so reaching here with one is not possible.
  const memberships = await ctx.db
    .query("members")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(25);
  for (const m of memberships) {
    const others = await ctx.db
      .query("members")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", m.workspaceId))
      .take(2);
    const sole = others.filter((o) => o.userId !== userId).length === 0;
    const ws = sole ? await ctx.db.get(m.workspaceId) : null;
    if (!ws || ws.ownerId !== userId) {
      // Not this user's workspace to tear down: only their membership goes.
      await ctx.db.delete(m._id);
      did = true;
      continue;
    }
    // DRAIN BEFORE PARENT (audit F-12). This used to delete at most 200 files
    // and 200 invites and then the workspace AND this membership row
    // unconditionally — and the membership row was the only handle a later
    // pass had on the workspace, so everything past 200 survived forever,
    // including invites that could recreate membership against the missing
    // workspace. Now: mark it deleting (it grants nothing from here on),
    // revoke grants first, and keep the membership row until both collections
    // come back empty.
    if (ws.deletingAt === undefined) {
      await ctx.db.patch(ws._id, { deletingAt: Date.now() });
    }
    const invites = await ctx.db
      .query("invites")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", ws._id))
      .take(ROWS_PER_SUBQUERY);
    for (const i of invites) await ctx.db.delete(i._id);
    const files = await ctx.db
      .query("files")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", ws._id))
      .take(ROWS_PER_SUBQUERY);
    for (const f of files) {
      await ctx.db.delete(f._id);
      await deleteBlob(ctx, f.storageId);
    }
    if (invites.length < ROWS_PER_SUBQUERY && files.length < ROWS_PER_SUBQUERY) {
      await ctx.db.delete(ws._id);
      await ctx.db.delete(m._id);
    }
    did = true;
  }

  return did;
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

    // 3. ACCOUNT-SCOPED SWEEP. Everything above is chat; these are the other
    //    user-owned tables. Policy per resource, not blanket cascade:
    //      * apiKeys      -> revoke THEN delete (a live credential must die first,
    //                        so a crash mid-sweep still leaves it unusable)
    //      * userFiles    -> row + storage blob
    //      * projects/projectFiles/scheduledTasks(+revisions/occurrences)/
    //        notifications/chatSettings/userQuotas/accountDeletionCodes -> delete
    //      * auditLogs    -> RETAINED: they are the WORKSPACE's compliance record
    //                        and belong to the other members, not to this user
    //      * authEvents   -> RETAINED: security history, cron-purged at 90 days
    const swept = await sweepAccountTables(ctx, userId);
    if (swept) {
      await ctx.scheduler.runAfter(0, internal.authDeletion.cascadeUserContent, {
        userId,
      });
      return;
    }
    // 4. Nothing left — done. (The avatar blob is handled synchronously in
    //    deleteUserAccount so a deleted account frees it immediately.)
  },
});

/**
 * RECONCILE rows left behind by account-deletion sweeps that ran before the
 * drain-before-parent fix (audit F-12). Correcting future cleanup does not
 * remove what earlier passes already stranded: files and invites pointing at a
 * workspace that no longer exists, memberships of a missing workspace, and
 * uploads/knowledge files whose owner is gone.
 *
 * Operator-run, ONE TABLE AND ONE PAGE PER CALL, and a dry run unless
 * `apply: true` — a destructive sweep whose target set is computed at call
 * time must be reviewable first. Feed `continueCursor` back until `isDone`.
 */
export const reconcileOrphans = internalMutation({
  args: {
    table: v.union(
      v.literal("files"),
      v.literal("invites"),
      v.literal("members"),
      v.literal("chatAttachments"),
      v.literal("userFiles"),
    ),
    apply: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { table, apply, cursor }) => {
    const opts = { numItems: ROWS_PER_SUBQUERY, cursor: cursor ?? null };
    const orphans: string[] = [];
    let page: { isDone: boolean; continueCursor: string };
    if (table === "files") {
      const res = await ctx.db.query("files").paginate(opts);
      for (const f of res.page) {
        if ((await ctx.db.get(f.workspaceId)) !== null) continue;
        orphans.push(f._id);
        if (apply) {
          await ctx.db.delete(f._id);
          await deleteBlob(ctx, f.storageId);
        }
      }
      page = res;
    } else if (table === "invites") {
      const res = await ctx.db.query("invites").paginate(opts);
      for (const i of res.page) {
        if ((await ctx.db.get(i.workspaceId)) !== null) continue;
        orphans.push(i._id);
        if (apply) await ctx.db.delete(i._id);
      }
      page = res;
    } else if (table === "members") {
      const res = await ctx.db.query("members").paginate(opts);
      for (const m of res.page) {
        if ((await ctx.db.get(m.workspaceId)) !== null) continue;
        orphans.push(m._id);
        if (apply) await ctx.db.delete(m._id);
      }
      page = res;
    } else if (table === "chatAttachments") {
      const res = await ctx.db.query("chatAttachments").paginate(opts);
      for (const a of res.page) {
        if ((await ctx.db.get(a.userId)) !== null) continue;
        orphans.push(a._id);
        if (apply) {
          await ctx.db.delete(a._id);
          await deleteBlob(ctx, a.storageId);
        }
      }
      page = res;
    } else {
      const res = await ctx.db.query("userFiles").paginate(opts);
      for (const f of res.page) {
        if ((await ctx.db.get(f.userId)) !== null) continue;
        orphans.push(f._id);
        if (apply) {
          await ctx.scheduler.runAfter(0, internal.userFiles.purge, {
            ingestId: f.ingestId,
          });
          await ctx.db.delete(f._id);
          if (f.storageId) await deleteBlob(ctx, f.storageId);
        }
      }
      page = res;
    }
    return {
      table,
      apply: !!apply,
      orphans,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** Bytes younger than this are never swept: an upload intent lives one hour,
 *  so a blob uploaded moments ago and not yet registered is still legitimate. */
const ORPHAN_BLOB_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_BLOB_PAGE = 100;

/** Storage ids held inside a share's frozen snapshot JSON (the /share/file
 *  proxy serves them) — the one reference `blobReferenced` cannot see by index.
 *  Every share that is not revoked counts, expired or not: conservative. */
async function sharedBlobIds(ctx: MutationCtx): Promise<Set<string>> {
  const ids = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
    } else if (node && typeof node === "object") {
      for (const [k, val] of Object.entries(node)) {
        if (k === "storageId" && typeof val === "string") ids.add(val);
        else walk(val);
      }
    }
  };
  for (const s of await ctx.db.query("chatShares").collect()) {
    if (s.revokedAt !== undefined) continue;
    try {
      walk(JSON.parse(s.snapshot));
    } catch {
      // An unparsable snapshot serves nothing; it references nothing.
    }
  }
  return ids;
}

type OrphanBlob = {
  storageId: Id<"_storage">;
  size: number;
  contentType: string | null;
  createdAt: number;
};

/** One page of `_storage`: the blobs older than `cutoff` that nothing references. */
async function findOrphanBlobs(
  ctx: MutationCtx,
  cursor: string | null,
  cutoff: number,
) {
  const shared = await sharedBlobIds(ctx);
  const res = await ctx.db.system
    .query("_storage")
    .paginate({ numItems: ORPHAN_BLOB_PAGE, cursor });
  const orphans: OrphanBlob[] = [];
  for (const b of res.page) {
    if (b._creationTime > cutoff) continue;
    if (shared.has(b._id)) continue;
    if (await blobReferenced(ctx, b._id)) continue;
    orphans.push({
      storageId: b._id,
      size: b.size,
      contentType: b.contentType ?? null,
      createdAt: b._creationTime,
    });
  }
  return { res, orphans };
}

/**
 * RECONCILE stored BYTES that no row references (audit F-01/F-12). The row-level
 * `reconcileOrphans` above cannot see these: they are what earlier deletion
 * passes left once they had dropped the only row pointing at them — plus a
 * replaced or reset avatar before that was fixed, and uploads that were never
 * registered.
 *
 * "Referenced" is exactly `blobReferenced` (files, userFiles, chatAttachments,
 * chatArtifacts, users.imageId) plus every storageId inside a non-revoked share
 * snapshot. blobInventory.test.ts fails if a new place starts holding storage
 * ids without being added to that list — a sweep is only as safe as its
 * inventory. Anything younger than a day is skipped.
 *
 * Operator-run, one page per call, a dry run unless `apply: true`. Feed
 * `continueCursor` back until `isDone`.
 */
export const reconcileOrphanBlobs = internalMutation({
  args: {
    apply: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    minAgeMs: v.optional(v.number()),
  },
  handler: async (ctx, { apply, cursor, minAgeMs }) => {
    const cutoff = Date.now() - Math.max(minAgeMs ?? ORPHAN_BLOB_MIN_AGE_MS, 0);
    const { res, orphans } = await findOrphanBlobs(ctx, cursor ?? null, cutoff);
    let bytes = 0;
    for (const o of orphans) {
      bytes += o.size;
      if (apply) await ctx.storage.delete(o.storageId);
    }
    return {
      apply: !!apply,
      scanned: res.page.length,
      orphans,
      bytes,
      isDone: res.isDone,
      continueCursor: res.continueCursor,
    };
  },
});

/**
 * AUTOMATIC cleanup of uploaded files nothing uses (crons.ts, daily) — so
 * reclaiming them no longer depends on an operator remembering to.
 *
 * Bounded twice. Each page is its own transaction (one page, then the next is
 * scheduled), so no run grows past a mutation's limits. And a whole sweep
 * deletes at most SWEEP_MAX_DELETIONS: a page that would cross it deletes
 * NOTHING and the sweep stops, loudly. Real abandonment trickles in; hundreds
 * at once means the reference inventory has missed a holder, and stopping is
 * the only safe answer to that. Retry-safe: every deletion is re-derived from
 * the current state inside the transaction that performs it, so a failed or
 * repeated page — or tomorrow's run starting over — can only find less.
 */
const SWEEP_MAX_DELETIONS = 500;
const SWEEP_MAX_PAGES = 400;
/** A composer chip lives in page memory only, so an attachment still unsent
 *  after a week belongs to a tab that is long gone and can never be sent. */
const UNSENT_ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UNSENT_ATTACHMENT_PAGE = 100;
const SWEEP_PAGE_DELAY_MS = 1000;

const sweepArgs = {
  cursor: v.optional(v.union(v.string(), v.null())),
  deleted: v.optional(v.number()),
  pages: v.optional(v.number()),
  // Tests only; the crons pass none of these.
  minAgeMs: v.optional(v.number()),
  maxDeletions: v.optional(v.number()),
};

export const sweepOrphanBlobs = internalMutation({
  args: sweepArgs,
  handler: async (ctx, args) => {
    const max = args.maxDeletions ?? SWEEP_MAX_DELETIONS;
    const deleted = args.deleted ?? 0;
    const pages = (args.pages ?? 0) + 1;
    const cutoff = Date.now() - Math.max(args.minAgeMs ?? ORPHAN_BLOB_MIN_AGE_MS, 0);
    const { res, orphans } = await findOrphanBlobs(ctx, args.cursor ?? null, cutoff);
    if (deleted + orphans.length > max) {
      console.error(
        `orphan blob sweep STOPPED: ${deleted + orphans.length} deletions would exceed ${max}; check blobReferenced's inventory before running reconcileOrphanBlobs by hand`,
      );
      return { deleted, stopped: true };
    }
    for (const o of orphans) await ctx.storage.delete(o.storageId);
    const total = deleted + orphans.length;
    if (!res.isDone && pages < SWEEP_MAX_PAGES) {
      await ctx.scheduler.runAfter(SWEEP_PAGE_DELAY_MS, internal.authDeletion.sweepOrphanBlobs, {
        ...args,
        cursor: res.continueCursor,
        deleted: total,
        pages,
      });
    } else if (total > 0) {
      console.log(`orphan blob sweep: deleted ${total} unreferenced blob(s) over ${pages} page(s)`);
    }
    return { deleted: total, stopped: false };
  },
});

/**
 * Attachments registered from the composer and never sent (the tab closed, or
 * the page reloaded, with chips still in it). They are unreachable — `send`
 * takes ids only from chips in page memory — yet hold a row and a blob forever:
 * no thread purge reaches a row with no messageId, and none with no threadId.
 * The account-knowledge copy (userFiles) is deliberate and is left alone.
 */
export const sweepUnsentAttachments = internalMutation({
  args: sweepArgs,
  handler: async (ctx, args) => {
    const max = args.maxDeletions ?? SWEEP_MAX_DELETIONS;
    const deleted = args.deleted ?? 0;
    const pages = (args.pages ?? 0) + 1;
    const cutoff = Date.now() - Math.max(args.minAgeMs ?? UNSENT_ATTACHMENT_TTL_MS, 0);
    // Oldest first within the unsent set, so the first young row ends the pass.
    const res = await ctx.db
      .query("chatAttachments")
      .withIndex("by_message", (q) => q.eq("messageId", undefined))
      .paginate({ numItems: UNSENT_ATTACHMENT_PAGE, cursor: args.cursor ?? null });
    const stale = res.page.filter((a) => a.createdAt <= cutoff);
    if (deleted + stale.length > max) {
      console.error(
        `unsent attachment sweep STOPPED: ${deleted + stale.length} deletions would exceed ${max}`,
      );
      return { deleted, stopped: true };
    }
    for (const a of stale) {
      await ctx.db.delete(a._id);
      await deleteBlobIfUnreferenced(ctx, a.storageId);
    }
    const total = deleted + stale.length;
    const reachedYoung = stale.length < res.page.length;
    if (!res.isDone && !reachedYoung && pages < SWEEP_MAX_PAGES) {
      await ctx.scheduler.runAfter(
        SWEEP_PAGE_DELAY_MS,
        internal.authDeletion.sweepUnsentAttachments,
        { ...args, cursor: res.continueCursor, deleted: total, pages },
      );
    } else if (total > 0) {
      console.log(`unsent attachment sweep: deleted ${total} attachment(s)`);
    }
    return { deleted: total, stopped: false };
  },
});
