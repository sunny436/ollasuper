import { ConvexError, v } from "convex/values";
import {
  claimUploadedBlob,
  deleteBlobIfUnreferenced,
  issueUploadIntent,
} from "../blobOwnership";
import { isExecutableContentType } from "../blobSafety";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { mutation, query } from "../_generated/server";
import { chatKindOf, fileKind } from "../fileKind";
import {
  UPLOAD_WINDOW_MS,
  UPLOADS_PER_HOUR,
  assertRoomWithoutEviction,
  createLibraryFile,
  libraryError,
} from "../libraryCore";
import { requireMember } from "../orgs";
import { consumeWindow } from "../quotas";
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
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

// Code/text files whose browser MIME is often empty or application/octet-stream
// (e.g. .py). They ingest as plain text (the Python detector reads them), so
// accept them by EXTENSION when the MIME does not classify.
const CODE_EXT = new Set([
  "py", "js", "ts", "tsx", "jsx", "go", "java", "rb", "rs", "c", "cc", "cpp",
  "h", "hpp", "cs", "php", "swift", "kt", "scala", "sh", "bash", "sql", "yaml",
  "yml", "toml", "ini", "cfg", "conf", "xml", "css", "scss", "less", "log",
  "txt", "md", "markdown", "json", "csv", "tsv", "html", "htm",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function classify(
  contentType: string,
  name = "",
): "image" | "document" | "text" {
  const ct = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (IMAGE_TYPES.has(ct)) return "image";
  if (DOCUMENT_TYPES.has(ct)) return "document";
  if (TEXT_TYPES.has(ct) || ct.startsWith("text/")) return "text";
  // Unknown/empty MIME (common for source files): fall back to the extension.
  if (CODE_EXT.has(extOf(name))) return "text";
  throw new ConvexError(`Unsupported file type: ${ct || "unknown"}`);
}

const _XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function isTabular(contentType: string, name: string): boolean {
  const ct = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = extOf(name);
  return (
    ct === "text/csv" ||
    ct === "application/csv" ||
    ct === "text/tab-separated-values" ||
    ct === _XLSX_MIME ||
    ext === "csv" ||
    ext === "tsv" ||
    ext === "xlsx"
  );
}

/**
 * INTERNAL-ONLY: the thread's tabular datasets (CSV/TSV/XLSX) for the dispatch
 * payload, so a follow-up turn analyses the same data without re-uploading. Unlike
 * `toPublic`, this DELIBERATELY carries `storageId` — it is the thread-scoped fetch
 * capability the Python compute tools resolve by NAME (never exposed to the model).
 * Owner-scoped (userId), most-recent first, capped. Callable only from dispatchPayload.
 */
export async function loadThreadDatasets(
  ctx: QueryCtx,
  threadId: Id<"chatThreads">,
  userId: Id<"users">,
  limit = 12,
) {
  const rows = await ctx.db
    .query("chatAttachments")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  const out = rows
    .filter(
      (a) =>
        a.userId === userId &&
        a.status !== "error" &&
        isTabular(a.contentType, a.name),
    )
    .sort((x, y) => y.createdAt - x.createdAt)
    .slice(0, limit)
    .map((a) => ({
      name: a.name,
      storageId: a.storageId as string,
      mime: a.contentType,
    }));
  return out;
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
    const rate = await consumeWindow(ctx, userId, "libraryUpload", UPLOADS_PER_HOUR, UPLOAD_WINDOW_MS);
    if (!rate.ok) throw libraryError("RATE_LIMITED", "Too many uploads. Please wait a moment.");
    await issueUploadIntent(ctx, userId, workspaceId);
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

    // Measure the ACTUAL blob. args.size is client-supplied, so validating it
    // is decorative: upload 500MB, then call register({ size: 1 }). The Python
    // service later pulls the whole blob into memory to build a data: URI.
    const meta = await ctx.db.system.get(args.storageId);
    // The BLOB's type is what Convex serves, not args.contentType — and
    // ctx.storage.getUrl() puts it on the app's own origin. See blobSafety.ts.
    if (isExecutableContentType(meta?.contentType)) {
      throw new ConvexError(
        `Unsupported file type: ${meta?.contentType}. Upload it declared as text/plain instead.`,
      );
    }
    const realSize = meta?.size ?? args.size;
    // Split the guard so an empty (0-byte) file gets a truthful message instead
    // of the nonsensical "too large".
    if (realSize <= 0) {
      throw new ConvexError("File is empty");
    }
    if (realSize > MAX_BYTES) {
      throw new ConvexError("File too large (max 20MB)");
    }
    // The ROW's declared type, not just the blob's.
    //
    // The guard above covers what ctx.storage.getUrl() serves. It does NOT cover
    // what a route that streams the bytes itself might put in a header, and
    // /share/file did exactly that — so a blob stored text/plain and REGISTERED
    // text/html came back executable on the app's own origin. That route now
    // neutralises on the way out, and this closes the same gap on the way in, so
    // the bad value never reaches the database at all.
    //
    // Rejected rather than rewritten: silently storing a different type than the
    // caller asked for is the kind of surprise that surfaces much later as "the
    // download has the wrong extension".
    if (isExecutableContentType(args.contentType)) {
      throw new ConvexError(
        `Unsupported file type: ${args.contentType}. Upload it declared as text/plain instead.`,
      );
    }
    const kind = classify(args.contentType, args.name);

    if (args.threadId) await requireThreadAccess(ctx, userId, args.threadId);

    // Provenance (audit F-01): the caller must have uploaded this blob, and no
    // row in ANY table may already reference it. Supersedes the per-table
    // by_storage check, which let a blob registered elsewhere be claimed here.
    const claimed = await claimUploadedBlob(ctx, userId, args.storageId, args.workspaceId);

    // ONE upload, ONE Library file, ONE blob: the attachment is a reference to
    // the Library file created from the same bytes (it used to be a separate
    // upload into a separate blob). The quota applies here too — this door
    // must not be a way around it.
    await assertRoomWithoutEviction(ctx, userId, realSize);
    const userFileId = await createLibraryFile(ctx, {
      userId,
      workspaceId: args.workspaceId,
      storageId: args.storageId,
      name: args.name,
      contentType: args.contentType,
      size: realSize,
      sha256: claimed.sha256,
      source: "uploaded",
    });
    return await ctx.db.insert("chatAttachments", {
      workspaceId: args.workspaceId,
      userId,
      threadId: args.threadId,
      storageId: args.storageId,
      name: args.name.slice(0, 256) || "untitled",
      size: realSize,
      contentType: args.contentType.slice(0, 128),
      kind,
      status: "uploaded",
      createdAt: Date.now(),
      userFileId,
    });
  },
});

/**
 * "Add from Library": a REFERENCE to an existing Library file — the same blob,
 * no upload, no copy. The file must be the caller's own, in the chat's
 * workspace, with its original still stored, and of a kind the chat can read.
 */
export const attachLibraryFile = mutation({
  args: {
    fileId: v.id("userFiles"),
    workspaceId: v.id("workspaces"),
    threadId: v.optional(v.id("chatThreads")),
  },
  handler: async (ctx, { fileId, workspaceId, threadId }) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, workspaceId);
    const f = await ctx.db.get(fileId);
    if (!f || f.userId !== userId || f.workspaceId !== workspaceId) {
      throw new ConvexError("Not found");
    }
    if (!f.storageId) {
      throw new ConvexError("This file's original is being restored. Try again later.");
    }
    if (threadId) await requireThreadAccess(ctx, userId, threadId);
    const kind = f.kind ?? fileKind(f.name, f.contentType);
    if (kind === "other") {
      throw new ConvexError("This type of file can't be read in a chat. Download it instead.");
    }
    return await ctx.db.insert("chatAttachments", {
      workspaceId,
      userId,
      threadId,
      storageId: f.storageId,
      name: f.name,
      size: f.size,
      contentType: f.contentType,
      kind: chatKindOf(kind),
      status: "uploaded",
      createdAt: Date.now(),
      userFileId: f._id,
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
    await ctx.db.delete(attachmentId);
    // Row first, then bytes nothing else references (audit F-01).
    await deleteBlobIfUnreferenced(ctx, a.storageId);
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
