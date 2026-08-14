import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { mutation, query } from "../_generated/server";
import { requireMember } from "../orgs";
import {
  getUserIdOrNull,
  requireAttachmentAccess,
  requireThreadAccess,
  requireUserId,
} from "./authz";

/**
 * Chat attachments.
 *
 * These live in their own table rather than reusing `files` because
 * `files.list` returns every row in the workspace to any member — correct for a
 * shared Files page, catastrophic for private chat uploads.
 *
 * THE STORAGE URL IS A BEARER CAPABILITY. `ctx.storage.getUrl()` returns a URL
 * that anyone holding it can fetch with no auth. So `storageId` is NEVER
 * returned from any public function here, and `url` is only ever minted after
 * the ownership check, inside the same handler.
 */

const MAX_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const DOCUMENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

function classify(contentType: string): "image" | "document" | "text" {
  const ct = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (IMAGE_TYPES.has(ct)) return "image";
  if (DOCUMENT_TYPES.has(ct)) return "document";
  if (TEXT_TYPES.has(ct) || ct.startsWith("text/")) return "text";
  throw new ConvexError(`Unsupported file type: ${ct || "unknown"}`);
}

/** Public shape. Note the absence of storageId — that is load-bearing. */
async function toPublic(ctx: QueryCtx, a: Doc<"chatAttachments">) {
  return {
    _id: a._id,
    name: a.name,
    size: a.size,
    contentType: a.contentType,
    kind: a.kind,
    status: a.status,
    createdAt: a.createdAt,
    url: await ctx.storage.getUrl(a.storageId),
  };
}

export const generateUploadUrl = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, workspaceId);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Claim an uploaded blob.
 *
 * `userId` comes from the session, never from args. The by_storage uniqueness
 * check is the anti-claim-squat defense: generateUploadUrl is necessarily open
 * to any workspace member and storage ids are opaque but not cryptographically
 * bound to an uploader, so without this a user who guessed someone else's
 * storageId could register it and then read the bytes through the sanctioned
 * path. First registration wins, and the legitimate uploader always registers
 * first because generateUploadUrl → POST → register is one user action.
 */
export const register = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    storageId: v.id("_storage"),
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
    threadId: v.optional(v.id("chatThreads")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, args.workspaceId);

    if (args.size <= 0 || args.size > MAX_BYTES) {
      throw new ConvexError("File too large (max 20MB)");
    }
    const kind = classify(args.contentType);

    const clash = await ctx.db
      .query("chatAttachments")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .first();
    if (clash) throw new ConvexError("Already registered");

    if (args.threadId) await requireThreadAccess(ctx, userId, args.threadId);

    return await ctx.db.insert("chatAttachments", {
      workspaceId: args.workspaceId,
      userId,
      threadId: args.threadId,
      storageId: args.storageId,
      name: args.name.slice(0, 256) || "untitled",
      size: args.size,
      contentType: args.contentType.slice(0, 128),
      kind,
      status: "uploaded",
      createdAt: Date.now(),
    });
  },
});

export const get = query({
  args: { attachmentId: v.id("chatAttachments") },
  handler: async (ctx, { attachmentId }) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return null;
    const a = await requireAttachmentAccess(ctx, userId, attachmentId);
    return await toPublic(ctx, a);
  },
});

export const listForThread = query({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return [];
    const id = ctx.db.normalizeId("chatThreads", threadId);
    if (!id) return [];
    await requireThreadAccess(ctx, userId, id);
    const rows = await ctx.db
      .query("chatAttachments")
      .withIndex("by_thread", (q) => q.eq("threadId", id))
      .take(200);
    return await Promise.all(rows.map((a) => toPublic(ctx, a)));
  },
});

export const remove = mutation({
  args: { attachmentId: v.id("chatAttachments") },
  handler: async (ctx, { attachmentId }) => {
    const userId = await requireUserId(ctx);
    const a = await requireAttachmentAccess(ctx, userId, attachmentId);
    // Refuse to unpick an attachment already bound to a sent message —
    // otherwise the transcript would render a broken reference.
    if (a.messageId) throw new ConvexError("Attachment is already sent");
    await ctx.storage.delete(a.storageId);
    await ctx.db.delete(attachmentId);
  },
});

/**
 * Resolve and validate attachments for a send(). Exported for messages.ts.
 *
 * Every id is checked individually: owned by the caller, not already bound to a
 * message, and belonging to this thread (or unfiled). Without the per-id check
 * a user could attach someone else's attachment id to their own message and the
 * resolved-URL path in the message list would hand over the bytes.
 */
export async function bindAttachments(
  ctx: { db: QueryCtx["db"] },
  userId: Id<"users">,
  threadId: Id<"chatThreads">,
  attachmentIds: Id<"chatAttachments">[],
): Promise<Doc<"chatAttachments">[]> {
  const out: Doc<"chatAttachments">[] = [];
  for (const id of attachmentIds) {
    const a = await ctx.db.get(id);
    if (!a || a.userId !== userId) throw new ConvexError("Not found");
    if (a.messageId) throw new ConvexError("Attachment already used");
    if (a.threadId && a.threadId !== threadId) {
      throw new ConvexError("Attachment belongs to another conversation");
    }
    out.push(a);
  }
  return out;
}
