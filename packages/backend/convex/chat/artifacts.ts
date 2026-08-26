import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation, internalQuery, mutation } from "../_generated/server";

/**
 * File Generation System — persistence + ownership-enforced download for a file the
 * assistant generated.
 *
 * The Python plane stores the rendered blob via /ai/artifact (http.ts), which calls
 * `registerArtifact` with the streamId; the owner is DERIVED from the stream here and
 * never trusted from Python. Unlike the execution ledger, the row is PERSISTENT — the
 * download must keep working after the turn.
 *
 * Download is OWNERSHIP-ENFORCED, not a bearer capability: the ARTIFACT event carries
 * only the artifact `_id`; the real URL is produced by `mintDownload`, an AUTHENTICATED
 * mutation that checks `getAuthUserId === userId` and issues a short-TTL one-time token
 * the /artifact/file proxy resolves. storageId never leaves the server.
 */

const DOWNLOAD_TTL_MS = 5 * 60 * 1000; // 5 minutes — long enough to click, short enough

async function loadStream(
  ctx: MutationCtx,
  streamId: string,
): Promise<Doc<"chatStreams"> | null> {
  return await ctx.db
    .query("chatStreams")
    .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
    .unique();
}

/** Called ONLY from /ai/artifact (ingress-secret verified). Owner ids come from the
 *  stream, never the caller. Returns the new artifact id, or null if the stream is
 *  gone (the caller then discards the just-stored blob). */
export const registerArtifact = internalMutation({
  args: {
    streamId: v.string(),
    storageId: v.id("_storage"),
    filename: v.string(),
    format: v.string(),
    mime: v.string(),
    size: v.number(),
  },
  handler: async (ctx, a) => {
    const stream = await loadStream(ctx, a.streamId);
    if (!stream) return { ok: false as const, artifactId: null };
    const artifactId = await ctx.db.insert("chatArtifacts", {
      streamId: a.streamId,
      messageId: stream.messageId,
      threadId: stream.threadId,
      workspaceId: stream.workspaceId,
      userId: stream.userId,
      storageId: a.storageId,
      filename: a.filename,
      format: a.format,
      mime: a.mime,
      size: a.size,
      createdAt: Date.now(),
    });
    return { ok: true as const, artifactId };
  },
});

/**
 * AUTHENTICATED, ownership-enforced. Mints a short-TTL one-time download token for an
 * artifact the caller OWNS, and returns the browser-reachable proxy URL's token. Every
 * non-owner gets "Not found" (no existence oracle), exactly like the rest of chat.
 */
export const mintDownload = mutation({
  // v.string() + normalizeId (not v.id): a malformed id must resolve to "Not found",
  // never an ArgumentValidationError → console.error (which fails every e2e script).
  args: { artifactId: v.string() },
  handler: async (ctx, { artifactId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");
    const id = ctx.db.normalizeId("chatArtifacts", artifactId);
    const art = id ? await ctx.db.get(id) : null;
    if (!art || art.userId !== userId) throw new ConvexError("Not found");
    const token = crypto.randomUUID() + crypto.randomUUID().slice(0, 8);
    await ctx.db.patch(art._id, {
      downloadToken: token,
      downloadTokenExpiresAt: Date.now() + DOWNLOAD_TTL_MS,
    });
    return { token, filename: art.filename, mime: art.mime };
  },
});

/** INTERNAL — for the /artifact/file proxy only. Resolves a live (non-expired) token
 *  to the blob's storageId + headers, or null (missing / expired / wrong). Same null
 *  for every failure — no existence oracle. */
export const resolveDownload = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (!token) return null;
    const art = await ctx.db
      .query("chatArtifacts")
      .withIndex("by_downloadToken", (q) => q.eq("downloadToken", token))
      .unique();
    if (!art || !art.downloadTokenExpiresAt) return null;
    if (art.downloadTokenExpiresAt < Date.now()) return null;
    return { storageId: art.storageId, mime: art.mime, filename: art.filename };
  },
});

/** Delete every generated artifact for a message (row + blob). Called on message /
 *  thread deletion so a purged conversation leaves no orphaned blob behind. */
export async function deleteArtifactsForMessage(
  ctx: MutationCtx,
  messageId: Id<"chatMessages">,
): Promise<void> {
  const rows = await ctx.db
    .query("chatArtifacts")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .collect();
  for (const r of rows) {
    await ctx.storage.delete(r.storageId).catch(() => {});
    await ctx.db.delete(r._id);
  }
}

export async function deleteArtifactsForThread(
  ctx: MutationCtx,
  threadId: Id<"chatThreads">,
): Promise<void> {
  const rows = await ctx.db
    .query("chatArtifacts")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  for (const r of rows) {
    await ctx.storage.delete(r.storageId).catch(() => {});
    await ctx.db.delete(r._id);
  }
}
