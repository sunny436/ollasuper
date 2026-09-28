import { activeUserId } from "./accountState";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { claimUploadedBlob, deleteBlobIfUnreferenced } from "./blobOwnership";
import { assertNonExecutableBlob } from "./blobSafety";
import { mutation, query } from "./_generated/server";
import { audit } from "./auditLog";
import { bump } from "./counters";
import {
  assertRoomWithoutEviction,
  capFor,
  createLibraryFile,
  legacyUploadBytes,
  libraryError,
  mintUploadUrl,
} from "./libraryCore";
import { requireMember } from "./orgs";

/**
 * Files module — the LEGACY workspace-shared store.
 *
 * New uploads no longer land here: `saveFile` now creates a private Library
 * file (userFiles) through the Library core, so the 100 MB quota applies and
 * there is one file system. Existing rows stay listable and deletable until
 * libraryMigrations.foldSharedFiles has moved them — verified — into their
 * uploaders' Libraries.
 */

export const generateUploadUrl = mutation({
  args: { workspaceId: v.id("workspaces"), size: v.optional(v.number()) },
  handler: async (ctx, { workspaceId, size }) => {
    const userId = await activeUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await requireMember(ctx, userId, workspaceId);
    const { uploadUrl } = await mintUploadUrl(ctx, userId, {
      workspaceId,
      maxBytes: legacyUploadBytes(size),
    });
    return uploadUrl;
  },
});

export const saveFile = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    storageId: v.id("_storage"),
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
  },
  handler: async (ctx, a) => {
    const userId = await activeUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await requireMember(ctx, userId, a.workspaceId);
    await assertNonExecutableBlob(ctx, a.storageId);
    // Only a blob THIS caller uploaded, and nobody has registered, may become
    // a row here — never a storage id lifted from someone else's URL (F-01).
    const meta = await claimUploadedBlob(ctx, userId, a.storageId, a.workspaceId);
    if (meta.size <= 0) throw libraryError("EMPTY", "The file is empty.");
    if (meta.size > capFor(a.name, a.contentType)) {
      throw libraryError("TOO_LARGE", "The file is too large.");
    }
    await assertRoomWithoutEviction(ctx, userId, meta.size);
    return await createLibraryFile(ctx, {
      userId,
      workspaceId: a.workspaceId,
      storageId: a.storageId,
      name: a.name,
      contentType: a.contentType,
      size: meta.size,
      sha256: meta.sha256,
      source: "uploaded",
    });
  },
});

export const list = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await activeUserId(ctx);
    if (!userId) return [];
    await requireMember(ctx, userId, workspaceId);
    const rows = await ctx.db
      .query("files")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .take(100);
    return Promise.all(
      rows.map(async (f) => ({
        _id: f._id,
        name: f.name,
        size: f.size,
        contentType: f.contentType,
        createdAt: f.createdAt,
        url: await ctx.storage.getUrl(f.storageId),
      })),
    );
  },
});

export const listPaged = query({
  args: {
    workspaceId: v.id("workspaces"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { workspaceId, paginationOpts }) => {
    const userId = await activeUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };
    await requireMember(ctx, userId, workspaceId);
    const res = await ctx.db
      .query("files")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .paginate(paginationOpts);
    return {
      ...res,
      page: await Promise.all(
        res.page.map(async (f) => ({
          _id: f._id,
          name: f.name,
          size: f.size,
          contentType: f.contentType,
          createdAt: f.createdAt,
          url: await ctx.storage.getUrl(f.storageId),
        })),
      ),
    };
  },
});

export const remove = mutation({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    const userId = await activeUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const f = await ctx.db.get(fileId);
    if (!f) throw new Error("Not found");
    await requireMember(ctx, userId, f.workspaceId);
    await ctx.db.delete(fileId);
    // Row first, then the bytes — and only if no other row still points at
    // them, so a pre-existing alias can never destroy another owner's file.
    await deleteBlobIfUnreferenced(ctx, f.storageId);
    await audit(ctx, f.workspaceId, userId, "file.delete", { fileId });
    await bump(ctx, f.workspaceId, "files", -1);
  },
});
