import { ConvexError, v } from "convex/values";
import { activeUserId } from "../accountState";
import { deleteBlobIfUnreferenced } from "../blobOwnership";
import { addGeneratedToLibrary } from "../libraryCore";
import { hasWorkspaceAccess } from "../orgs";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";

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
    // Phase 3 (additive): integrity hash + idempotency key. Both optional so filegen
    // is byte-identical.
    contentHash: v.optional(v.string()),
    artifactKey: v.optional(v.string()),
    // Documents preview (additive): a child preview-page image links to its parent
    // artifact + carries a role/page. v.string() (not v.id) + normalizeId below so a
    // malformed parent can never ArgumentValidationError the ingress. All optional ⇒
    // filegen/SEO byte-identical.
    parentArtifactId: v.optional(v.string()),
    role: v.optional(v.string()),
    page: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const stream = await loadStream(ctx, a.streamId);
    if (!stream) return { ok: false as const, artifactId: null };
    // Idempotent re-store: if this (stream, key) was already registered (e.g. the
    // turn crash-resumed and re-ran the report emission), delete the just-stored
    // duplicate blob and return the EXISTING artifact — at-most-once, no orphan.
    if (a.artifactKey) {
      const existing = await ctx.db
        .query("chatArtifacts")
        .withIndex("by_stream_key", (q) =>
          q.eq("streamId", a.streamId).eq("artifactKey", a.artifactKey),
        )
        .first();
      if (existing) {
        await ctx.storage.delete(a.storageId).catch(() => {});
        return { ok: true as const, artifactId: existing._id };
      }
    }
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
      ...(a.contentHash ? { contentHash: a.contentHash } : {}),
      ...(a.artifactKey ? { artifactKey: a.artifactKey } : {}),
      ...(() => {
        const pid = a.parentArtifactId
          ? ctx.db.normalizeId("chatArtifacts", a.parentArtifactId)
          : null;
        return pid ? { parentArtifactId: pid } : {};
      })(),
      ...(a.role ? { role: a.role } : {}),
      ...(a.page !== undefined ? { page: a.page } : {}),
    });
    // A generated file is also a Library file (source "generated") on the SAME
    // blob — never a copy. Preview page images are part of their parent, not
    // files of their own.
    if (a.role !== "preview") {
      await addGeneratedToLibrary(ctx, {
        artifactId,
        userId: stream.userId,
        workspaceId: stream.workspaceId,
        storageId: a.storageId,
        name: a.filename,
        contentType: a.mime,
        size: a.size,
      });
    }
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
    const userId = await activeUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");
    const id = ctx.db.normalizeId("chatArtifacts", artifactId);
    const art = id ? await ctx.db.get(id) : null;
    if (!art || art.userId !== userId) throw new ConvexError("Not found");
    // Current entitlement, like every other chat surface (audit F-08).
    if (!(await hasWorkspaceAccess(ctx, userId, art.workspaceId))) {
      throw new ConvexError("Not found");
    }
    const token = crypto.randomUUID() + crypto.randomUUID().slice(0, 8);
    await ctx.db.patch(art._id, {
      downloadToken: token,
      downloadTokenExpiresAt: Date.now() + DOWNLOAD_TTL_MS,
    });
    return { token, filename: art.filename, mime: art.mime };
  },
});

/**
 * AUTHENTICATED, ownership-enforced inline PREVIEW (Documents capability). Returns the
 * browser-reachable image URLs for a pptx/pdf artifact's preview pages — but ONLY to the
 * owner. `ctx.storage.getUrl()` is a bearer capability, so it is minted here strictly
 * AFTER the `getAuthUserId === parent.userId` check, exactly like /ai/file mints its url
 * only post-ownership. A non-owner (or unknown id) gets an empty list — no existence
 * oracle, no leaked url. Preview children are found via `by_parent` and ordered by page.
 */
export const previewUrls = query({
  // v.string() + normalizeId (not v.id): a malformed/URL-derived id must resolve to an
  // empty result, never an ArgumentValidationError → console.error (fails every e2e).
  args: { artifactId: v.string() },
  handler: async (ctx, { artifactId }) => {
    const userId = await activeUserId(ctx);
    if (!userId) return { pages: [] as { page: number; url: string }[] };
    const id = ctx.db.normalizeId("chatArtifacts", artifactId);
    const parent = id ? await ctx.db.get(id) : null;
    if (
      !parent ||
      parent.userId !== userId ||
      // Current entitlement, like every other chat surface (audit F-08).
      !(await hasWorkspaceAccess(ctx, userId, parent.workspaceId))
    ) {
      return { pages: [] as { page: number; url: string }[] };
    }
    const children = await ctx.db
      .query("chatArtifacts")
      .withIndex("by_parent", (q) => q.eq("parentArtifactId", parent._id))
      .collect();
    children.sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
    const pages: { page: number; url: string }[] = [];
    for (const c of children) {
      if (c.role !== "preview") continue;
      const url = await ctx.storage.getUrl(c.storageId);
      if (url) pages.push({ page: c.page ?? 0, url });
    }
    return { pages };
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
    await ctx.db.delete(r._id);
    await deleteBlobIfUnreferenced(ctx, r.storageId).catch(() => {});
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
    await ctx.db.delete(r._id);
    await deleteBlobIfUnreferenced(ctx, r.storageId).catch(() => {});
  }
}
