import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { claimUploadedBlob, issueUploadIntent } from "./blobOwnership";
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
import { getUserIdOrNull, requireUserId } from "./chat/authz";
import {
  UPLOAD_WINDOW_MS,
  UPLOADS_PER_HOUR,
  assertRoomWithoutEviction,
  capFor,
  createLibraryFile,
  libraryError,
  removeLibraryFile,
} from "./libraryCore";
import { hasWorkspaceAccess, requireMember } from "./orgs";
import { consumeWindow } from "./quotas";

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

/** Ceiling on the per-dispatch scope scan; past it the scope fails closed. */
const RAG_SCOPE_SCAN = 4096;

/**
 * The retrieval scope for an ORDINARY (non-Project) chat: ALWAYS an explicit
 * allowlist of the caller's ready files in workspaces they still belong to
 * (audit F-08).
 *
 * It used to return `null` — "search the whole corpus" — whenever every file
 * was entitled. But the corpus is Python's copy, which lags Convex: a file
 * deleted here stays in pgvector until its purge lands, and a purge that failed
 * transiently retries with backoff. With `null`, the retrieval in between could
 * still surface a file the user had already deleted. Convex's own state must
 * dominate the derived index, so the scope is always spelled out; an empty list
 * retrieves nothing (store.retrieve's three states).
 *
 * Fails closed past the scan ceiling: an unscanned file cannot be vouched for.
 */
export async function accountRagScope(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<string[]> {
  const ready = await ctx.db
    .query("userFiles")
    .withIndex("by_user_status", (q) =>
      q.eq("userId", userId).eq("status", "ready"),
    )
    .take(RAG_SCOPE_SCAN);
  const entitled = new Map<string, boolean>();
  const allowed: string[] = [];
  for (const f of ready) {
    let ok = entitled.get(f.workspaceId);
    if (ok === undefined) {
      ok = await hasWorkspaceAccess(ctx, userId, f.workspaceId);
      entitled.set(f.workspaceId, ok);
    }
    if (ok) allowed.push(f.ingestId);
  }
  return allowed;
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
 * The LEGACY knowledge upload door (Project sources and older clients). It now
 * goes through the Library core like every other door: the 100 MB quota, the
 * file cap and the global ceiling all apply (no eviction here — the ask-first
 * flow is library.beginUpload/finishUpload). Identical bytes are NOT collapsed
 * into an earlier file any more: a new upload is a new file.
 */
export const saveFile = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    storageId: v.id("_storage"),
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
    contentHash: v.string(), // client SHA-256 — advisory only; the server hash wins
  },
  handler: async (ctx, a) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, a.workspaceId);
    // PROVENANCE FIRST (audit F-01): only a blob proven to be the caller's own
    // fresh, unregistered upload.
    const meta = await claimUploadedBlob(ctx, userId, a.storageId, a.workspaceId);
    if (isExecutableContentType(meta?.contentType) || isExecutableContentType(a.contentType)) {
      throw new ConvexError(
        `Unsupported file type: ${meta?.contentType}. Upload it declared as text/plain instead.`,
      );
    }
    const size = meta.size;
    if (size <= 0) throw libraryError("EMPTY", "The file is empty.");
    if (size > capFor(a.name, a.contentType)) throw libraryError("TOO_LARGE", "The file is too large.");
    await assertRoomWithoutEviction(ctx, userId, size);
    return await createLibraryFile(ctx, {
      userId,
      workspaceId: a.workspaceId,
      storageId: a.storageId,
      name: a.name,
      contentType: a.contentType,
      size,
      sha256: meta.sha256,
      source: "uploaded",
    });
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
    // Same "Not found" for missing and not-yours — no existence oracle. Deleting
    // one's OWN file needs no membership: it grants nothing.
    if (!file || file.userId !== userId) throw new ConvexError("Not found");
    await removeLibraryFile(ctx, file, "user");
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
    // CURRENT entitlement, the same gate list/remove apply: a member removed
    // from the workspace must not keep dispatching processing for it (F-08).
    await requireMember(ctx, userId, file.workspaceId);
    if (file.status !== "failed") return { ok: false, reason: "not_failed" };
    if (!file.storageId) return { ok: false, reason: "needs_reupload" };
    // Retry storms: 10 per hour per user, 3 per day per file.
    const day = Math.floor(Date.now() / 86_400_000);
    const today = file.retryDay === day ? (file.retriesToday ?? 0) : 0;
    if (today >= 3) return { ok: false, reason: "retry_limit" };
    const rate = await consumeWindow(ctx, userId, "libraryRetry", 10, 60 * 60_000);
    if (!rate.ok) return { ok: false, reason: "rate_limited" };
    await ctx.db.patch(fileId, {
      status: "processing",
      error: undefined,
      attempts: 0,
      retryDay: day,
      retriesToday: today + 1,
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
      // The canonical original's server-computed SHA-256 (Convex _storage),
      // so the processing copy can never silently diverge from it.
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
    };
  },
});

/**
 * Python admits a bounded number of ingestions (per user and in total) and
 * answers 429 + Retry-After past that. That is a QUEUE signal, not a verdict:
 * treating it as terminal failed every file after the first in a multi-file
 * upload. So a 429 re-schedules the dispatch after Retry-After (clamped, with
 * jitter so a burst does not re-arrive in lockstep), bounded by an attempt cap,
 * and the row stays "processing" with a message saying why. The cap keeps a
 * permanently saturated plane from queueing forever; past it the file fails
 * with a retryable error.
 */
/**
 * Sized so a FULL intake never runs out of patience: MAX_PROCESSING_PER_USER
 * files (20) ingest one at a time per user, each up to Python's whole-file
 * deadline (ai_ingest_overall_deadline_s, 300 s) — up to 100 min for the last
 * file in line. At Python's 5-10 s Retry-After (+ jitter) that needs well over
 * 120 attempts, the old value, which failed the tail of a 20-PDF upload with
 * "Processing is busy". 1,500 attempts ≈ 2-5 h. The polling is bounded by the
 * same cap: at most 20 queued files per user.
 */
export const QUEUE_MAX_ATTEMPTS = 1_500;
/** Python's ai_ingest_overall_deadline_s — one ingestion's worst case. */
export const INGEST_DEADLINE_MS = 300_000;
export const QUEUE_MIN_DELAY_MS = 5_000;
const QUEUE_MAX_DELAY_MS = 30_000;

function queueDelayMs(retryAfter: string | null): number {
  const s = Number(retryAfter);
  const base = Number.isFinite(s) && s > 0 ? s * 1000 : QUEUE_MIN_DELAY_MS;
  const clamped = Math.min(QUEUE_MAX_DELAY_MS, Math.max(QUEUE_MIN_DELAY_MS, base));
  return clamped + Math.floor(Math.random() * 2000);
}

/** Keep a queued file visibly waiting — and out of reapStalled's reach, which
 *  keys on updatedAt — while its dispatch is re-scheduled. */
export const markQueued = internalMutation({
  args: { fileId: v.id("userFiles") },
  handler: async (ctx, { fileId }) => {
    const f = await ctx.db.get(fileId);
    if (!f || f.status !== "processing") return;
    await ctx.db.patch(fileId, {
      stage: "queued",
      stageMessage: "Waiting for a free processing slot",
      updatedAt: Date.now(),
    });
  },
});

export const dispatch = internalAction({
  args: { fileId: v.id("userFiles"), queued: v.optional(v.number()) },
  handler: async (ctx, { fileId, queued = 0 }) => {
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
      if (res.status === 429 && queued < QUEUE_MAX_ATTEMPTS) {
        await ctx.runMutation(internal.userFiles.markQueued, { fileId });
        await ctx.scheduler.runAfter(
          queueDelayMs(res.headers.get("retry-after")),
          internal.userFiles.dispatch,
          { fileId, queued: queued + 1 },
        );
        return;
      }
      if (!res.ok && res.status !== 409) {
        await ctx.runMutation(internal.userFiles.failById, {
          fileId,
          error:
            res.status === 429
              ? "Processing is busy right now — retry this file"
              : `Ingest service responded ${res.status}`,
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
    // Idempotent; never resurrect or move a terminal row (mirrors
    // finishStream). `stored` is terminal too: a late or forged callback must
    // not turn a kept-only file into a processed one.
    if (file.status !== "processing") {
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
    // The Convex blob is the CANONICAL ORIGINAL of a Library file (download,
    // reuse in chat, retry). It used to be dropped here as a staging copy.
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
    if (!file || file.status !== "processing") return;
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
        // Failed, and RETRYABLE: the blob is the file's only original, so it is
        // kept (this used to delete it, destroying the upload of a file whose
        // processing had merely timed out).
        await ctx.db.patch(f._id, {
          status: "failed",
          error: "Processing timed out — retry the file",
          updatedAt: now,
        });
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

/** Reclaim the Postgres bytes/chunks/embeddings for one ingest.
 *
 *  THIS IS THE ONLY THING THAT DELETES A USER'S DOCUMENT TEXT AND EMBEDDINGS.
 *  There is no orphan sweeper — checked, no such cron exists — so an earlier
 *  comment here claiming a leftover row is "swept later" was simply wrong, and
 *  a swallowed failure was permanent silent data retention. That matters most
 *  on the account-deletion path, where this is the difference between a user's
 *  documents being gone and being merely unreferenced. Hence a bounded retry:
 *  a Python restart or a brief outage no longer costs the deletion guarantee,
 *  and the cap stops a permanently-down plane from looping forever.
 *
 *  The cap is a WEEK, not minutes (audit F-13: retain retryable cleanup state
 *  across both stores). Five attempts over ~7.5 minutes lost two deletions on
 *  production — the VM was down ~1.5 h on 2026-09-26 — and each left a
 *  document its owner had deleted still retrievable by their chats. The
 *  pending scheduled purge IS the durable record: Convex keeps it across
 *  restarts, and the backoff settles at hourly. */
const PURGE_MAX_ATTEMPTS = 175; // 7 quick retries, then hourly for ~7 days
const PURGE_MAX_DELAY_MS = 60 * 60_000;

export const purge = internalAction({
  args: { ingestId: v.string(), attempt: v.optional(v.number()) },
  handler: async (ctx, { ingestId, attempt = 0 }) => {
    const base = process.env.AI_BASE_URL;
    const key = process.env.AI_SERVICE_KEY;
    if (!base || !key) return;
    let ok = false;
    try {
      const res = await fetch(
        `${base.replace(/\/$/, "")}/v1/ingest/${encodeURIComponent(ingestId)}`,
        { method: "DELETE", headers: { "x-service-key": key } },
      );
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (ok) return;
    if (attempt + 1 >= PURGE_MAX_ATTEMPTS) {
      console.error("userfile purge exhausted", { ingestId });
      return;
    }
    // Backoff: 30s, 60s, 2m, … capped at hourly.
    await ctx.scheduler.runAfter(
      Math.min(30_000 * 2 ** attempt, PURGE_MAX_DELAY_MS),
      internal.userFiles.purge,
      { ingestId, attempt: attempt + 1 },
    );
  },
});
