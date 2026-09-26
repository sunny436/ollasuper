import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

/**
 * Blob PROVENANCE — who may register, and who may delete, a stored blob.
 *
 * THE HOLE THIS CLOSES (audit F-01). A storage id is not bound to its uploader:
 * `generateUploadUrl` hands out an anonymous upload slot, and every storage URL
 * the app mints for a browser carries the id in its path. So a user who had ever
 * been handed a URL for someone else's blob could register that id as their
 * own file (`files.saveFile` checked only the destination workspace) and then
 * delete the shared bytes, or — via `userFiles.saveFile`'s duplicate path —
 * have them deleted outright before any ownership check ran.
 *
 * Two independent rules, both enforced here so every registration path shares
 * one definition:
 *
 *   1. INTENT. Every upload URL issued records an intent for the calling user.
 *      A blob can be claimed only against one of the caller's own unconsumed
 *      intents whose window contains the blob's creation. Any id a thief could
 *      have learned from a URL belongs to a blob created BEFORE the thief's
 *      intent, so it never matches.
 *   2. UNREFERENCED. A blob already referenced by any row, in any table, is
 *      not claimable — whoever registered it first owns it.
 *
 * And the deletion half: bytes are deleted only when NO row references them
 * any more, so an alias (a row created before this module existed) can never be
 * used to destroy bytes another row still points at.
 */

/** Convex upload URLs are valid for an hour; the intent lives as long. */
const INTENT_TTL_MS = 60 * 60 * 1000;
/** Bounded bookkeeping per user: the oldest open intents are dropped beyond it. */
const MAX_OPEN_INTENTS = 64;

/** Record an upload intent for `userId`. Call from every generateUploadUrl. */
export async function issueUploadIntent(
  ctx: MutationCtx,
  userId: Id<"users">,
  workspaceId?: Id<"workspaces">,
): Promise<void> {
  const now = Date.now();
  // Prune intents that can no longer match any blob (expired a full TTL ago,
  // so a slow upload that finished just before expiry can still be claimed).
  const stale = await ctx.db
    .query("uploadIntents")
    .withIndex("by_user_expires", (q) =>
      q.eq("userId", userId).lt("expiresAt", now - INTENT_TTL_MS),
    )
    .take(MAX_OPEN_INTENTS);
  for (const row of stale) await ctx.db.delete(row._id);

  const open = await ctx.db
    .query("uploadIntents")
    .withIndex("by_user_expires", (q) =>
      q.eq("userId", userId).gte("expiresAt", now - INTENT_TTL_MS),
    )
    .take(MAX_OPEN_INTENTS + 1);
  // Only the caller's OWN intents are dropped, so this bounds storage without
  // affecting anyone else. `open` is ordered by expiry, i.e. oldest first.
  for (const row of open.slice(0, Math.max(0, open.length - MAX_OPEN_INTENTS + 1))) {
    await ctx.db.delete(row._id);
  }

  await ctx.db.insert("uploadIntents", {
    userId,
    ...(workspaceId ? { workspaceId } : {}),
    createdAt: now,
    expiresAt: now + INTENT_TTL_MS,
  });
}

/** Is `storageId` referenced by a row in any table that holds a blob? */
export async function blobReferenced(
  ctx: QueryCtx,
  storageId: Id<"_storage">,
): Promise<boolean> {
  const hits = await Promise.all([
    ctx.db
      .query("files")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first(),
    ctx.db
      .query("userFiles")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first(),
    ctx.db
      .query("chatAttachments")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first(),
    ctx.db
      .query("chatArtifacts")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first(),
    ctx.db
      .query("users")
      .withIndex("by_image", (q) => q.eq("imageId", storageId))
      .first(),
  ]);
  return hits.some((row) => row !== null);
}

/**
 * Prove the caller uploaded `storageId` and take ownership of it, or throw
 * "Not found" — the same answer for a missing, foreign or already-claimed blob,
 * so the error is never an oracle. Consumes the matching intent.
 */
export async function claimUploadedBlob(
  ctx: MutationCtx,
  userId: Id<"users">,
  storageId: Id<"_storage">,
  workspaceId?: Id<"workspaces">,
) {
  const meta = await ctx.db.system.get(storageId);
  if (!meta) throw new ConvexError("Not found");
  if (await blobReferenced(ctx, storageId)) throw new ConvexError("Not found");

  const created = meta._creationTime;
  const candidates = await ctx.db
    .query("uploadIntents")
    .withIndex("by_user_expires", (q) =>
      q.eq("userId", userId).gte("expiresAt", created),
    )
    .take(MAX_OPEN_INTENTS + 1);
  const intent = candidates.find(
    (i) =>
      i.createdAt <= created &&
      (!workspaceId || !i.workspaceId || i.workspaceId === workspaceId),
  );
  if (!intent) throw new ConvexError("Not found");
  await ctx.db.delete(intent._id);
  return meta;
}

/**
 * Delete a blob's bytes only if no row references it any more. Call AFTER the
 * owning row is deleted or re-pointed (a mutation sees its own writes).
 */
export async function deleteBlobIfUnreferenced(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
): Promise<void> {
  if (await blobReferenced(ctx, storageId)) return;
  // Already gone is done: a resumed cascade or an earlier pass may have taken
  // it, and a row pointing at missing bytes must still be deletable. Any OTHER
  // failure propagates — the caller's row delete then rolls back with it, so a
  // failed blob delete leaves a retryable row, never unreferenced bytes.
  if ((await ctx.db.system.get(storageId)) === null) return;
  await ctx.storage.delete(storageId);
}
