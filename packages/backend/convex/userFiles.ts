import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { isExecutableContentType } from "./blobSafety";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import { audit } from "./auditLog";
import { unlinkFileEverywhere } from "./projects";
import { getUserIdOrNull, requireUserId } from "./chat/authz";
import { bump } from "./counters";
import { requireMember } from "./orgs";

/**
 * Per-user File Knowledge System — the Convex METADATA MIRROR + orchestration.
 *
 * The bytes/chunks/embeddings live in the Python-owned pgvector DB; this module
 * owns only a small reactive `userFiles` row (status for the sidebar) plus the
 * upload/dispatch/status/delete lifecycle. Every ingress-crossing surface is
 * scoped by the random `ingestId` capability (mirroring chatStreams.streamId),
 * NOT the enumerable Convex id. Trust model is chat's (private-per-user), not the
 * workspace-shared `files` plane — see chat/authz.ts.
 */

const INGEST_STALL_MS = 10 * 60_000; // embedding a big PDF is slow; >> chat's 90s
const MAX_ATTEMPTS = 3;

// Exported for the chat dispatch gate (stream.ts): does the user have any ready
// file so RAG retrieval is worth the extra embedding + query latency?
export async function userHasReadyFiles(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const one = await ctx.db
    .query("userFiles")
    .withIndex("by_user_status", (q) =>
      q.eq("userId", userId).eq("status", "ready"),
    )
    .first();
  return one !== null;
}

export const generateUploadUrl = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, workspaceId);
    return await ctx.storage.generateUploadUrl();
  },
});

export const saveFile = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    storageId: v.id("_storage"),
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
    contentHash: v.string(), // client SHA-256, for per-user dedup + idempotency
  },
  handler: async (ctx, a) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, a.workspaceId);

    // Dedup identical content for THIS user (per-user hash, never global — a
    // global hash would be a cross-user existence oracle). Drop the redundant
    // just-uploaded staging blob so it doesn't orphan.
    const dupe = await ctx.db
      .query("userFiles")
      .withIndex("by_user_hash", (q) =>
        q.eq("userId", userId).eq("contentHash", a.contentHash),
      )
      .first();
    if (dupe && dupe.status !== "failed") {
      await ctx.storage.delete(a.storageId).catch(() => {});
      return dupe._id;
    }

    // Anti-claim-squat: a storageId may be registered exactly once.
    const claimed = await ctx.db
      .query("userFiles")
      .withIndex("by_storage", (q) => q.eq("storageId", a.storageId))
      .first();
    if (claimed) throw new ConvexError("Not found");

    // Re-measure the real blob server-side; the client size is untrusted.
    const meta = await ctx.db.system.get(a.storageId);
    if (isExecutableContentType(meta?.contentType)) {
      throw new ConvexError(
        `Unsupported file type: ${meta?.contentType}. Upload it declared as text/plain instead.`,
      );
    }
    const size = meta?.size ?? a.size;

    const now = Date.now();
    const ingestId = crypto.randomUUID();
    const id = await ctx.db.insert("userFiles", {
      userId,
      workspaceId: a.workspaceId,
      name: a.name.slice(0, 300),
      storageId: a.storageId,
      size,
      contentType: a.contentType,
      ingestId,
      status: "processing",
      attempts: 0,
      contentHash: a.contentHash,
      createdAt: now,
      updatedAt: now,
    });
    await audit(ctx, a.workspaceId, userId, "userfile.upload", { name: a.name });
    await bump(ctx, a.workspaceId, "userFiles", 1);
    await ctx.scheduler.runAfter(0, internal.userFiles.dispatch, { fileId: id });
    return id;
  },
});

export const list = query({
  args: {
    workspaceId: v.id("workspaces"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };
    await requireMember(ctx, userId, args.workspaceId);
    const res = await ctx.db
      .query("userFiles")
      .withIndex("by_user_ws_created", (q) =>
        q.eq("userId", userId).eq("workspaceId", args.workspaceId),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    // Never expose storageId or the ingestId capability to the client.
    return {
      ...res,
      page: res.page.map((f) => ({
        _id: f._id,
        name: f.name,
        size: f.size,
        contentType: f.contentType,
        status: f.status,
        error: f.error ?? null,
        chunkCount: f.chunkCount ?? null,
        pageCount: f.pageCount ?? null,
        detectedType: f.detectedType ?? null,
        stage: f.stage ?? null,
        progress: f.progress ?? null,
        processedUnits: f.processedUnits ?? null,
        totalUnits: f.totalUnits ?? null,
        stageMessage: f.stageMessage ?? null,
        note: f.note ?? null,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      })),
    };
  },
});

export const remove = mutation({
  args: { fileId: v.id("userFiles") },
  handler: async (ctx, { fileId }) => {
    const userId = await requireUserId(ctx);
    const file = await ctx.db.get(fileId);
    // Same "Not found" for missing and not-yours — no existence oracle.
    if (!file || file.userId !== userId) throw new ConvexError("Not found");
    await requireMember(ctx, userId, file.workspaceId);
    if (file.storageId) await ctx.storage.delete(file.storageId);
    const ingestId = file.ingestId;
    // Drop every Project association first, so a deleted file can never leave a
    // dangling edge that a Project sources list or a retrieval scope would try
    // to resolve.
    await unlinkFileEverywhere(ctx, fileId);
    await ctx.db.delete(fileId);
    await bump(ctx, file.workspaceId, "userFiles", -1);
    await audit(ctx, file.workspaceId, userId, "userfile.delete", {
      name: file.name,
    });
    // Reclaim the Postgres bytes/chunks/embeddings (FK cascade, Python side).
    await ctx.scheduler.runAfter(0, internal.userFiles.purge, { ingestId });
    return { ok: true };
  },
});

/** Re-run ingestion for a FAILED file without re-uploading. Ownership-checked
 *  (same "Not found" for missing/not-yours). Only acts on a failed row whose
 *  staging blob still exists (a reaper-exhausted file dropped its blob and must
 *  be re-uploaded). Resets the live-progress fields and re-dispatches. */
export const retry = mutation({
  args: { fileId: v.id("userFiles") },
  handler: async (ctx, { fileId }) => {
    const userId = await requireUserId(ctx);
    const file = await ctx.db.get(fileId);
    if (!file || file.userId !== userId) throw new ConvexError("Not found");
    if (file.status !== "failed") return { ok: false, reason: "not_failed" };
    if (!file.storageId) return { ok: false, reason: "needs_reupload" };
    await ctx.db.patch(fileId, {
      status: "processing",
      error: undefined,
      attempts: 0,
      stage: undefined,
      progress: undefined,
      processedUnits: undefined,
      totalUnits: undefined,
      stageMessage: undefined,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.userFiles.dispatch, { fileId });
    return { ok: true };
  },
});

// --- orchestration (internal) --------------------------------------------

export const dispatchPayload = internalQuery({
  args: { fileId: v.id("userFiles") },
  handler: async (ctx, { fileId }) => {
    const file = await ctx.db.get(fileId);
    // No-op if the row vanished or already reached a terminal state.
    if (!file || file.status !== "processing") return null;
    return {
      ingestId: file.ingestId,
      userId: file.userId,
      workspaceId: file.workspaceId,
      name: file.name,
      contentType: file.contentType,
      size: file.size,
    };
  },
});

export const dispatch = internalAction({
  args: { fileId: v.id("userFiles") },
  handler: async (ctx, { fileId }) => {
    const base = process.env.AI_BASE_URL;
    const key = process.env.AI_SERVICE_KEY;
    if (!base || !key) {
      await ctx.runMutation(internal.userFiles.failById, {
        fileId,
        error: "Inference plane not configured",
      });
      return;
    }
    const payload = await ctx.runQuery(internal.userFiles.dispatchPayload, {
      fileId,
    });
    if (!payload) return;
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/v1/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-service-key": key },
        body: JSON.stringify(payload),
      });
      // 409 = already ingesting this file (a double dispatch) — benign no-op;
      // Python's Registry rejects the duplicate and the first run converges it.
      if (!res.ok && res.status !== 409) {
        await ctx.runMutation(internal.userFiles.failById, {
          fileId,
          error: `Ingest service responded ${res.status}`,
        });
      }
    } catch {
      await ctx.runMutation(internal.userFiles.failById, {
        fileId,
        error: "Ingest dispatch failed",
      });
    }
  },
});

/** Terminal status from Python's callback. Capability-scoped by ingestId. */
export const setStatus = internalMutation({
  args: {
    fileId: v.string(), // ingestId capability, NOT a Convex id
    status: v.union(v.literal("ready"), v.literal("failed")),
    chunkCount: v.optional(v.number()),
    parserUsed: v.optional(v.string()),
    pageCount: v.optional(v.number()),
    detectedType: v.optional(v.string()),
    contentHash: v.optional(v.string()),
    error: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const file = await ctx.db
      .query("userFiles")
      .withIndex("by_ingestId", (q) => q.eq("ingestId", a.fileId))
      .unique();
    if (!file) return { ok: false, unknown: true };
    // Idempotent; never resurrect a terminal row (mirrors finishStream).
    if (file.status === "ready" || file.status === "failed") {
      return { ok: true, alreadyFinal: true };
    }
    const now = Date.now();
    await ctx.db.patch(file._id, {
      status: a.status,
      chunkCount: a.chunkCount,
      parserUsed: a.parserUsed,
      pageCount: a.pageCount,
      detectedType: a.detectedType,
      contentHash: a.contentHash ?? file.contentHash,
      error:
        a.status === "failed"
          ? (a.error ?? "Ingestion failed").slice(0, 500)
          : undefined,
      // A partial-success note (e.g. content-limit truncation) rides onto a
      // `ready` row so the UI can tell the user what was processed.
      note: a.status === "ready" ? (a.note ?? undefined) : undefined,
      // Progress is transient: clear the live fields on any terminal status.
      stage: undefined,
      progress: undefined,
      processedUnits: undefined,
      totalUnits: undefined,
      stageMessage: undefined,
      updatedAt: now,
    });
    // Staging blob is transient: drop it only on durable success, then null the
    // reference so /ai/ingest-file can never re-scope to a freed blob.
    if (a.status === "ready" && file.storageId) {
      await ctx.storage.delete(file.storageId);
      await ctx.db.patch(file._id, { storageId: undefined });
    }
    return { ok: true };
  },
});

/** Intermediate progress from Python's file-progress callback. Capability-scoped
 *  by ingestId. Only ever touches a `processing` row (never a terminal one), and
 *  writes only the transient live fields, so it cannot corrupt the result. The
 *  Python side coalesces these, so this stays cheap despite the reactive list. */
export const setProgress = internalMutation({
  args: {
    fileId: v.string(), // ingestId capability
    stage: v.string(),
    progress: v.optional(v.number()),
    processedUnits: v.optional(v.number()),
    totalUnits: v.optional(v.number()),
    stageMessage: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const file = await ctx.db
      .query("userFiles")
      .withIndex("by_ingestId", (q) => q.eq("ingestId", a.fileId))
      .unique();
    if (!file) return { ok: false, unknown: true };
    if (file.status !== "processing") return { ok: true, alreadyFinal: true };
    await ctx.db.patch(file._id, {
      stage: a.stage,
      progress: a.progress,
      processedUnits: a.processedUnits,
      totalUnits: a.totalUnits,
      stageMessage: a.stageMessage,
      updatedAt: Date.now(),
    });
    return { ok: true };
  },
});

/** Internal failure path (dispatch / reaper), scoped by the Convex id. */
export const failById = internalMutation({
  args: { fileId: v.id("userFiles"), error: v.string() },
  handler: async (ctx, { fileId, error }) => {
    const file = await ctx.db.get(fileId);
    if (!file || file.status === "ready" || file.status === "failed") return;
    await ctx.db.patch(fileId, {
      status: "failed",
      error: error.slice(0, 500),
      updatedAt: Date.now(),
    });
  },
});

/** Capability query for the /ai/ingest-file byte fetch. storageId never leaves
 *  the server; the ingestId is the only thing Python presents. */
export const stagingBlobForFile = internalQuery({
  args: { fileId: v.string() }, // ingestId
  handler: async (ctx, { fileId }) => {
    const file = await ctx.db
      .query("userFiles")
      .withIndex("by_ingestId", (q) => q.eq("ingestId", fileId))
      .unique();
    if (!file || !file.storageId) return null;
    return { storageId: file.storageId };
  },
});

/** Re-dispatch or fail files stuck in `processing` past the deadline. Mirrors
 *  chat/stream.ts reapStalled. */
export const reapStalled = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - INGEST_STALL_MS;
    const stalled = await ctx.db
      .query("userFiles")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "processing").lt("updatedAt", cutoff),
      )
      .take(25);
    for (const f of stalled) {
      const now = Date.now();
      if (f.attempts >= MAX_ATTEMPTS) {
        await ctx.db.patch(f._id, {
          status: "failed",
          error: "Ingestion timed out",
          updatedAt: now,
          storageId: undefined,
        });
        if (f.storageId) await ctx.storage.delete(f.storageId);
      } else {
        await ctx.db.patch(f._id, { attempts: f.attempts + 1, updatedAt: now });
        await ctx.scheduler.runAfter(0, internal.userFiles.dispatch, {
          fileId: f._id,
        });
      }
    }
    return stalled.length;
  },
});

export const purge = internalAction({
  args: { ingestId: v.string() },
  handler: async (ctx, { ingestId }) => {
    const base = process.env.AI_BASE_URL;
    const key = process.env.AI_SERVICE_KEY;
    if (!base || !key) return;
    try {
      await fetch(
        `${base.replace(/\/$/, "")}/v1/ingest/${encodeURIComponent(ingestId)}`,
        { method: "DELETE", headers: { "x-service-key": key } },
      );
    } catch {
      // A leftover Postgres row is unreferenced and swept later; never fatal.
    }
  },
});
