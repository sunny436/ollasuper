import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireMember } from "../orgs";
import { getUserIdOrNull, requireFolderAccess, requireUserId } from "./authz";

/**
 * Sidebar folders. Per-user, workspace-scoped, and small by nature — a folder
 * list is O(10). No pagination and no search index: the whole set is resident
 * in the sidebar, so filtering belongs on the client.
 */

const MAX_FOLDERS = 100;
const MAX_NAME = 60;

function cleanName(raw: string): string {
  const n = raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  if (!n) throw new ConvexError("Folder name cannot be empty");
  return n;
}

export const list = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return [];
    await requireMember(ctx, userId, workspaceId);
    const folders = await ctx.db
      .query("chatFolders")
      .withIndex("by_user_ws_order", (q) =>
        q.eq("userId", userId).eq("workspaceId", workspaceId),
      )
      .take(MAX_FOLDERS + 1);
    return folders.map((f) => ({
      _id: f._id,
      name: f.name,
      color: f.color ?? null,
      order: f.order,
    }));
  },
});

export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, args.workspaceId);

    const existing = await ctx.db
      .query("chatFolders")
      .withIndex("by_user_ws_order", (q) =>
        q.eq("userId", userId).eq("workspaceId", args.workspaceId),
      )
      .take(MAX_FOLDERS + 1);
    if (existing.length > MAX_FOLDERS) {
      throw new ConvexError("Folder limit reached");
    }

    const now = Date.now();
    return await ctx.db.insert("chatFolders", {
      workspaceId: args.workspaceId,
      userId,
      name: cleanName(args.name),
      color: args.color?.slice(0, 32),
      // Append at the end; reorder() rewrites these wholesale.
      order: existing.length,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const rename = mutation({
  args: { folderId: v.id("chatFolders"), name: v.string() },
  handler: async (ctx, { folderId, name }) => {
    const userId = await requireUserId(ctx);
    await requireFolderAccess(ctx, userId, folderId);
    await ctx.db.patch(folderId, {
      name: cleanName(name),
      updatedAt: Date.now(),
    });
  },
});

export const setColor = mutation({
  args: {
    folderId: v.id("chatFolders"),
    color: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { folderId, color }) => {
    const userId = await requireUserId(ctx);
    await requireFolderAccess(ctx, userId, folderId);
    await ctx.db.patch(folderId, {
      color: color?.slice(0, 32) ?? undefined,
      updatedAt: Date.now(),
    });
  },
});

/** Rewrites `order` for the supplied ids. Every id is ownership-checked. */
export const reorder = mutation({
  args: { folderIds: v.array(v.id("chatFolders")) },
  handler: async (ctx, { folderIds }) => {
    const userId = await requireUserId(ctx);
    if (folderIds.length > MAX_FOLDERS)
      throw new ConvexError("Too many folders");
    const now = Date.now();
    for (let i = 0; i < folderIds.length; i++) {
      const id = folderIds[i];
      if (!id) continue;
      await requireFolderAccess(ctx, userId, id);
      await ctx.db.patch(id, { order: i, updatedAt: now });
    }
  },
});

/**
 * Deleting a folder never deletes its conversations — it unfiles them. Losing
 * a folder is recoverable; losing a chat is not.
 */
export const remove = mutation({
  args: { folderId: v.id("chatFolders") },
  handler: async (ctx, { folderId }) => {
    const userId = await requireUserId(ctx);
    const folder = await requireFolderAccess(ctx, userId, folderId);

    // Bounded: unfile in batches, re-running until the folder is empty. A user
    // with thousands of threads in one folder must not blow the transaction.
    for (let guard = 0; guard < 20; guard++) {
      const batch = await ctx.db
        .query("chatThreads")
        .withIndex("by_user_ws_folder_updated", (q) =>
          q
            .eq("userId", userId)
            .eq("workspaceId", folder.workspaceId)
            .eq("folderId", folderId),
        )
        .take(200);
      if (batch.length === 0) break;
      for (const t of batch) {
        await ctx.db.patch(t._id, { folderId: undefined });
      }
      if (batch.length < 200) break;
    }

    await ctx.db.delete(folderId);
  },
});
