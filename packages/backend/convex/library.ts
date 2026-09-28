import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  query,
  type QueryCtx,
} from "./_generated/server";
import { activeUserId, isActiveUser } from "./accountState";
import { audit } from "./auditLog";
import { blobReferenced } from "./blobOwnership";
import { isExecutableContentType } from "./blobSafety";
import { requireUserId } from "./chat/authz";
import { fileKind, isInlineRaster, nameKeyOf, sanitizeFileName } from "./fileKind";
import {
  GLOBAL_CEILING_BYTES,
  GLOBAL_KEY,
  MAX_EVICTIONS,
  MAX_PROCESSING_PER_USER,
  UPLOADS_PER_HOUR,
  USER_QUOTA_BYTES,
  assertFileCap,
  assertUploadBudget,
  capFor,
  createLibraryFile,
  deletableForSpace,
  hashToken,
  isCharged,
  libraryError,
  mintUploadUrl,
  planSpaceWithCandidates,
  randomToken,
  removeLibraryFile,
  stillDeletable,
  usedBytes,
  userKey,
} from "./libraryCore";
import { notify } from "./notifications";
import { hasWorkspaceAccess, requireMember } from "./orgs";
import { consumeWindow } from "./quotas";

/**
 * File Library — the public API over `userFiles` (see libraryCore.ts for the
 * invariants). A Library file is private to its owner: every function resolves
 * the file by id and answers "Not found" for missing and foreign alike.
 */

const HOUR = 60 * 60 * 1000;
const ACCESS_PER_HOUR = 300;
const BYTES_PER_HOUR = 500 * 1024 * 1024;
const DOWNLOAD_TTL_MS = 60_000;
const PREVIEW_TTL_MS = 5 * 60_000;
/**
 * How often one capability may be fetched. A download manager retries; a
 * thumbnail re-renders. Budgets are charged ONCE, when a capability is minted,
 * and uses are counted on the token's own row — so the bandwidth bound per
 * user stays hard (maxUses × BYTES_PER_HOUR) while parallel fetches never
 * write the same document (they used to contend on the user's quota row: OCC
 * retries on every thumbnail grid, seen in production logs).
 */
const DOWNLOAD_MAX_USES = 3;
const PREVIEW_MAX_USES = 4;
/** Raster images up to this size render inline as their own thumbnail. */
export const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
const PAGE_MAX = 50;

// ------------------------------------------------------------------ helpers

async function ownedFile(
  ctx: QueryCtx,
  userId: Id<"users">,
  fileId: Id<"userFiles">,
): Promise<Doc<"userFiles">> {
  const f = await ctx.db.get(fileId);
  if (!f || f.userId !== userId) throw new ConvexError("Not found");
  return f;
}

/** The client-facing shape. Never the storage id, the ingest id or a URL. */
export function toLibraryRow(f: Doc<"userFiles">) {
  const kind = f.kind ?? fileKind(f.name, f.contentType);
  return {
    _id: f._id,
    name: f.name,
    size: f.size,
    kind,
    source: f.source ?? "uploaded",
    status: f.status,
    error: f.error ?? null,
    // Failure lifecycle (libraryProcessing): the stable code, whether an
    // automatic retry is scheduled (and when), or whether it gave up.
    failureCode: f.failureCode ?? null,
    retryAt: f.status === "failed" ? (f.nextRetryAt ?? null) : null,
    deadLettered: f.status === "failed" && f.deadLetteredAt !== undefined,
    stage: f.stage ?? null,
    progress: f.progress ?? null,
    stageMessage: f.stageMessage ?? null,
    note: f.note ?? null,
    hasBlob: f.storageId !== undefined,
    canPreview:
      kind === "image" &&
      isInlineRaster(f.name, f.contentType) &&
      f.storageId !== undefined &&
      f.size <= PREVIEW_MAX_BYTES,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

function candidateRow(f: Doc<"userFiles">) {
  return {
    _id: f._id,
    name: f.name,
    size: f.size,
    kind: f.kind ?? fileKind(f.name, f.contentType),
    createdAt: f.createdAt,
  };
}

function logEvent(code: string, fields: Record<string, unknown>): void {
  // Structured, grep-able, and never a name, a token or content.
  console.log(JSON.stringify({ event: code, ...fields }));
}

async function processingCount(ctx: QueryCtx, userId: Id<"users">): Promise<number> {
  const rows = await ctx.db
    .query("userFiles")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "processing"))
    .take(MAX_PROCESSING_PER_USER + 1);
  return rows.length;
}

// ------------------------------------------------------------------ upload

/**
 * Open an upload session — or say what must be freed first.
 *
 * Nothing is ever deleted here. When the file does not fit, the answer lists
 * the user's deletable files (oldest first, never generated, never in a
 * Project) with the oldest pre-selected, so the "Free up space" panel can ask.
 * With `approvedDeletions` covering the shortfall, the session opens and
 * finishUpload deletes exactly those — re-checked — in the same transaction as
 * the new file.
 */
export const beginUpload = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
    contentType: v.string(),
    size: v.number(),
    purpose: v.union(v.literal("library"), v.literal("chat")),
    approvedDeletions: v.optional(v.array(v.id("userFiles"))),
  },
  handler: async (ctx, a) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, a.workspaceId);
    const name = sanitizeFileName(a.name);
    if (!(a.size > 0)) throw libraryError("EMPTY", "The file is empty.");
    const cap = capFor(name, a.contentType);
    if (a.size > cap) {
      throw libraryError("TOO_LARGE", `Files like this can be up to ${Math.round(cap / 1048576)} MB.`);
    }
    if (isExecutableContentType(a.contentType)) {
      throw new ConvexError(`Unsupported file type: ${a.contentType}. Upload it declared as text/plain instead.`);
    }
    const rate = await consumeWindow(ctx, userId, "libraryUpload", UPLOADS_PER_HOUR, HOUR);
    if (!rate.ok) throw libraryError("RATE_LIMITED", "Too many uploads. Please wait a moment.");
    await assertFileCap(ctx, userId);
    // Refuse before any bytes move; createLibraryFile charges the real size.
    await assertUploadBudget(ctx, userId, a.size);
    if ((await processingCount(ctx, userId)) >= MAX_PROCESSING_PER_USER) {
      throw libraryError("PROCESSING_BUSY", "Several of your files are still processing. Try again shortly.");
    }
    if ((await usedBytes(ctx, GLOBAL_KEY)) + a.size > GLOBAL_CEILING_BYTES) {
      throw libraryError("GLOBAL_FULL", "Storage is temporarily full. Please try again later.");
    }

    const { plan, candidates } = await planSpaceWithCandidates(ctx, userId, a.size);
    if (plan.shortBytes > 0) {
      let covered = 0;
      for (const id of a.approvedDeletions ?? []) {
        const f = await stillDeletable(ctx, userId, id);
        if (f) covered += f.size;
      }
      if (covered < plan.shortBytes || (a.approvedDeletions?.length ?? 0) > MAX_EVICTIONS) {
        return {
          ok: false as const,
          reason: plan.canFit ? ("NEEDS_SPACE" as const) : ("CANNOT_FIT" as const),
          plan,
          candidates: candidates.map(candidateRow),
        };
      }
    }
    const { intentId, uploadUrl } = await mintUploadUrl(ctx, userId, {
      workspaceId: a.workspaceId,
      session: { purpose: a.purpose, declaredBytes: a.size },
      // The ticket admits exactly the declared size: the edge cuts off
      // anything longer, and finishUpload re-checks the stored blob.
      maxBytes: a.size,
      sessionCounted: true,
    });
    return { ok: true as const, intentId, uploadUrl };
  },
});

/**
 * Finish an upload session: verify the ACTUAL bytes, delete the user-approved
 * files if the new one needs the room, create the Library file. One
 * transaction — a failure deletes nothing and creates nothing.
 *
 * Idempotent: a retry after a lost response returns the same file.
 */
export const finishUpload = mutation({
  args: {
    intentId: v.id("uploadIntents"),
    storageId: v.id("_storage"),
    name: v.string(),
    contentType: v.string(),
    approvedDeletions: v.optional(v.array(v.id("userFiles"))),
  },
  handler: async (ctx, a) => {
    const userId = await requireUserId(ctx);
    // Idempotency first: the response to a committed finish may have been lost.
    const existing = await ctx.db
      .query("userFiles")
      .withIndex("by_storage", (q) => q.eq("storageId", a.storageId))
      .first();
    if (existing) {
      if (existing.userId !== userId) throw new ConvexError("Not found");
      return { ok: true as const, fileId: existing._id, evicted: [] as string[] };
    }

    const intent = await ctx.db.get(a.intentId);
    const meta = await ctx.db.system.get(a.storageId);
    if (
      !intent ||
      intent.userId !== userId ||
      intent.status !== "created" ||
      !intent.purpose ||
      !intent.workspaceId ||
      !meta ||
      meta._creationTime < intent.createdAt ||
      meta._creationTime > intent.expiresAt ||
      (await blobReferenced(ctx, a.storageId))
    ) {
      throw new ConvexError("Not found");
    }
    await requireMember(ctx, userId, intent.workspaceId);

    const name = sanitizeFileName(a.name);
    const size = meta.size;
    const reject = async (code: "SIZE_MISMATCH" | "TOO_LARGE" | "EMPTY", message: string) => {
      // These are final for THIS blob: drop it and close the session. Returned,
      // not thrown — a throw would roll the cleanup back.
      await ctx.storage.delete(a.storageId);
      await ctx.db.patch(intent._id, { status: "aborted" });
      logEvent("LIB_UPLOAD_FAIL", { userId, code, size });
      return { ok: false as const, code, message };
    };
    if (size <= 0) return reject("EMPTY", "The file is empty.");
    if (size > (intent.declaredBytes ?? 0)) {
      return reject("SIZE_MISMATCH", "The uploaded file is larger than declared.");
    }
    if (size > capFor(name, a.contentType)) return reject("TOO_LARGE", "The file is too large.");
    if (isExecutableContentType(meta.contentType) || isExecutableContentType(a.contentType)) {
      await ctx.storage.delete(a.storageId);
      await ctx.db.patch(intent._id, { status: "aborted" });
      throw new ConvexError(`Unsupported file type: ${a.contentType}. Upload it declared as text/plain instead.`);
    }

    // Room: re-planned now, excluding THIS session's own reservation.
    const { plan, candidates } = await planSpaceWithCandidates(ctx, userId, size, intent._id);
    const evictions: Doc<"userFiles">[] = [];
    if (plan.shortBytes > 0) {
      const approved = a.approvedDeletions ?? [];
      if (approved.length === 0) {
        return { ok: false as const, code: "QUOTA_EXCEEDED" as const, plan, candidates: candidates.map(candidateRow) };
      }
      let freed = 0;
      for (const id of approved.slice(0, MAX_EVICTIONS)) {
        const f = await stillDeletable(ctx, userId, id);
        if (!f) continue;
        evictions.push(f);
        freed += f.size;
      }
      if (freed < plan.shortBytes || approved.length > MAX_EVICTIONS) {
        return {
          ok: false as const,
          code: "QUOTA_PLAN_CHANGED" as const,
          plan,
          candidates: candidates.map(candidateRow),
        };
      }
    }
    const freedGlobal = evictions.reduce((s, f) => s + f.size, 0);
    if ((await usedBytes(ctx, GLOBAL_KEY)) - freedGlobal + size > GLOBAL_CEILING_BYTES) {
      return { ok: false as const, code: "GLOBAL_FULL" as const, message: "Storage is temporarily full. Please try again later." };
    }

    const evicted: string[] = [];
    for (const f of evictions) evicted.push(await removeLibraryFile(ctx, f, "evicted"));
    const fileId = await createLibraryFile(ctx, {
      userId,
      workspaceId: intent.workspaceId,
      storageId: a.storageId,
      name,
      contentType: a.contentType,
      size,
      sha256: meta.sha256,
      source: "uploaded",
    });
    await ctx.db.patch(intent._id, { status: "completed" });
    if (evicted.length > 0) {
      await notify(
        ctx,
        userId,
        "library.evicted",
        `Deleted ${evicted.length} old file${evicted.length === 1 ? "" : "s"} to make room`,
        `To make room for ${name}: ${evicted.join(", ")}`,
      );
      logEvent("LIB_EVICT", { userId, fileId, evicted: evictions.map((f) => f._id) });
    }
    logEvent("LIB_UPLOAD_OK", { userId, fileId, size, purpose: intent.purpose });
    return { ok: true as const, fileId, evicted };
  },
});

/** Cancel an upload session: its reservation lapses at once, and a blob it produced is dropped. */
export const abortUpload = mutation({
  args: { intentId: v.id("uploadIntents"), storageId: v.optional(v.id("_storage")) },
  handler: async (ctx, { intentId, storageId }) => {
    const userId = await requireUserId(ctx);
    const intent = await ctx.db.get(intentId);
    if (!intent || intent.userId !== userId) return { ok: false };
    if (intent.status === "created") await ctx.db.patch(intentId, { status: "aborted" });
    if (storageId) {
      const meta = await ctx.db.system.get(storageId);
      // Only a blob of THIS session that nothing registered.
      if (
        meta &&
        meta._creationTime >= intent.createdAt &&
        meta._creationTime <= intent.expiresAt &&
        !(await blobReferenced(ctx, storageId))
      ) {
        await ctx.storage.delete(storageId);
      }
    }
    return { ok: true };
  },
});

/**
 * The edge proxy's gate on an upload body (http.ts /edge/upload-ticket).
 * A ticket is redeemed exactly once, only while its URL is unexpired and its
 * session is still open; the answer is the byte ceiling the edge enforces on
 * the stream. Every failure is the same `ok: false` — no oracle.
 */
export const redeemUploadTicket = internalMutation({
  args: { ticketHash: v.string() },
  handler: async (ctx, { ticketHash }) => {
    const intent = await ctx.db
      .query("uploadIntents")
      .withIndex("by_ticket", (q) => q.eq("ticketHash", ticketHash))
      .first();
    if (
      !intent ||
      intent.ticketUsedAt !== undefined ||
      intent.expiresAt < Date.now() ||
      !intent.maxBytes ||
      (intent.status !== undefined && intent.status !== "created")
    ) {
      logEvent("LIB_TICKET_REFUSED", { reason: intent ? "state" : "unknown" });
      return { ok: false as const };
    }
    await ctx.db.patch(intent._id, { ticketUsedAt: Date.now() });
    return { ok: true as const, maxBytes: intent.maxBytes };
  },
});

// ------------------------------------------------------------------ read

const kindV = v.union(
  v.literal("image"),
  v.literal("pdf"),
  v.literal("document"),
  v.literal("spreadsheet"),
  v.literal("presentation"),
  v.literal("text"),
  v.literal("other"),
);
const sourceV = v.union(v.literal("uploaded"), v.literal("generated"));

/**
 * The Library, one bounded page at a time. Filtering, sorting and name search
 * all run on the server; cursors are index positions, so inserts and deletes
 * never duplicate or skip a row. Search is on FILE NAMES — searching a file's
 * contents is what the AI's retrieval does, not this.
 */
export const list = query({
  args: {
    workspaceId: v.id("workspaces"),
    paginationOpts: paginationOptsValidator,
    kind: v.optional(kindV),
    source: v.optional(sourceV),
    sort: v.optional(
      v.union(v.literal("newest"), v.literal("oldest"), v.literal("name_asc"), v.literal("name_desc")),
    ),
    search: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const userId = await activeUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };
    await requireMember(ctx, userId, a.workspaceId);
    const opts = { ...a.paginationOpts, numItems: Math.min(Math.max(1, a.paginationOpts.numItems), PAGE_MAX) };
    const term = a.search?.trim().slice(0, 100);
    let res: { page: Doc<"userFiles">[]; isDone: boolean; continueCursor: string };
    if (term) {
      res = await ctx.db
        .query("userFiles")
        .withSearchIndex("search_name", (q) => {
          let s = q.search("name", term).eq("userId", userId).eq("workspaceId", a.workspaceId);
          if (a.kind) s = s.eq("kind", a.kind);
          if (a.source) s = s.eq("source", a.source);
          return s;
        })
        .paginate(opts);
    } else if (a.sort === "name_asc" || a.sort === "name_desc") {
      let q = ctx.db
        .query("userFiles")
        .withIndex("by_user_ws_namekey", (q) => q.eq("userId", userId).eq("workspaceId", a.workspaceId))
        .order(a.sort === "name_asc" ? "asc" : "desc");
      if (a.kind) q = q.filter((f) => f.eq(f.field("kind"), a.kind));
      if (a.source) q = q.filter((f) => f.eq(f.field("source"), a.source));
      res = await q.paginate(opts);
    } else {
      const order = a.sort === "oldest" ? "asc" : "desc";
      if (a.kind) {
        let q = ctx.db
          .query("userFiles")
          .withIndex("by_user_ws_kind_created", (q) =>
            q.eq("userId", userId).eq("workspaceId", a.workspaceId).eq("kind", a.kind),
          )
          .order(order);
        if (a.source) q = q.filter((f) => f.eq(f.field("source"), a.source));
        res = await q.paginate(opts);
      } else if (a.source) {
        res = await ctx.db
          .query("userFiles")
          .withIndex("by_user_ws_source_created", (q) =>
            q.eq("userId", userId).eq("workspaceId", a.workspaceId).eq("source", a.source),
          )
          .order(order)
          .paginate(opts);
      } else {
        res = await ctx.db
          .query("userFiles")
          .withIndex("by_user_ws_created", (q) => q.eq("userId", userId).eq("workspaceId", a.workspaceId))
          .order(order)
          .paginate(opts);
      }
    }
    return { ...res, page: res.page.map(toLibraryRow) };
  },
});

/** One file, for the picker and deep links. Null for missing and foreign alike. */
export const get = query({
  args: { fileId: v.string() },
  handler: async (ctx, { fileId }) => {
    const userId = await activeUserId(ctx);
    if (!userId) return null;
    const id = ctx.db.normalizeId("userFiles", fileId);
    if (!id) return null;
    const f = await ctx.db.get(id);
    if (!f || f.userId !== userId) return null;
    if (!(await hasWorkspaceAccess(ctx, userId, f.workspaceId))) return null;
    return toLibraryRow(f);
  },
});

/**
 * "You already have this file": the caller's own file in this workspace with
 * the same bytes, if any. Advisory only — identical bytes are still allowed to
 * be two files; this lets the user reuse the one they have instead.
 *
 * Owner-scoped on purpose: answering for anyone's bytes would tell a user
 * whether someone else holds a given document. Legacy rows carry only the
 * client-computed `contentHash`, so both hashes are checked.
 */
export const findDuplicate = query({
  args: { workspaceId: v.id("workspaces"), sha256: v.string() },
  handler: async (ctx, { workspaceId, sha256 }) => {
    const userId = await activeUserId(ctx);
    if (!userId || !/^[0-9a-f]{64}$/.test(sha256)) return null;
    await requireMember(ctx, userId, workspaceId);
    const bySha = await ctx.db
      .query("userFiles")
      .withIndex("by_user_sha256", (q) => q.eq("userId", userId).eq("sha256", sha256))
      .take(20);
    const byLegacy = await ctx.db
      .query("userFiles")
      .withIndex("by_user_hash", (q) => q.eq("userId", userId).eq("contentHash", sha256))
      .take(20);
    const hit = [...bySha, ...byLegacy].find(
      (f) => f.workspaceId === workspaceId && f.storageId !== undefined,
    );
    return hit ? candidateRow(hit) : null;
  },
});

/** The storage meter: the caller's uploads against their 100 MB, app-wide. */
export const storageSummary = query({
  args: {},
  handler: async (ctx) => {
    const userId = await activeUserId(ctx);
    if (!userId) return null;
    const usage = await ctx.db
      .query("storageUsage")
      .withIndex("by_key", (q) => q.eq("key", userKey(userId)))
      .unique();
    return {
      usedBytes: usage?.usedBytes ?? 0,
      quotaBytes: USER_QUOTA_BYTES,
      files: usage?.files ?? 0,
      nearFull: (usage?.usedBytes ?? 0) >= USER_QUOTA_BYTES * 0.9,
    };
  },
});

/** "Free up space": what may be deleted, and what fitting `needBytes` would take. */
export const freeUpCandidates = query({
  args: { needBytes: v.optional(v.number()) },
  handler: async (ctx, { needBytes }) => {
    const userId = await activeUserId(ctx);
    if (!userId) return null;
    const { plan, candidates } = await planSpaceWithCandidates(ctx, userId, Math.max(0, needBytes ?? 0));
    // The plan only scans when something must be freed; otherwise scan once here.
    const files = plan.shortBytes > 0 ? candidates : await deletableForSpace(ctx, userId);
    return { plan, files: files.map(candidateRow) };
  },
});

// ------------------------------------------------------------------ write

export const rename = mutation({
  args: { fileId: v.id("userFiles"), name: v.string() },
  handler: async (ctx, { fileId, name }) => {
    const userId = await requireUserId(ctx);
    const f = await ownedFile(ctx, userId, fileId);
    // Metadata only: a Library file's bytes are immutable.
    const clean = sanitizeFileName(name);
    await ctx.db.patch(fileId, { name: clean, nameKey: nameKeyOf(clean), updatedAt: Date.now() });
    await audit(ctx, f.workspaceId, userId, "userfile.rename", { fileId });
    return { name: clean };
  },
});

/** Delete several of the caller's own files at once (the "Free up space" panel). */
export const removeMany = mutation({
  args: { fileIds: v.array(v.id("userFiles")) },
  handler: async (ctx, { fileIds }) => {
    const userId = await requireUserId(ctx);
    if (fileIds.length > MAX_EVICTIONS) {
      throw new ConvexError(`Delete at most ${MAX_EVICTIONS} files at a time.`);
    }
    const removed: string[] = [];
    for (const id of fileIds) {
      const f = await ctx.db.get(id);
      if (!f || f.userId !== userId) continue; // foreign and missing: skipped alike
      removed.push(await removeLibraryFile(ctx, f, "user"));
    }
    return { removed: removed.length };
  },
});

// ------------------------------------------------------------------ access

async function mintOne(
  ctx: MutationCtx,
  userId: Id<"users">,
  f: Doc<"userFiles">,
  purpose: "download" | "preview",
): Promise<string> {
  const token = randomToken();
  await ctx.db.insert("fileAccessTokens", {
    tokenHash: await hashToken(token),
    fileId: f._id,
    userId,
    purpose,
    expiresAt: Date.now() + (purpose === "download" ? DOWNLOAD_TTL_MS : PREVIEW_TTL_MS),
    uses: 0,
    maxUses: purpose === "download" ? DOWNLOAD_MAX_USES : PREVIEW_MAX_USES,
  });
  return token;
}

/**
 * A short-lived capability for ONE file and ONE purpose. The raw token is
 * returned once and never stored (only its SHA-256); every use re-checks the
 * file, the owner and the purpose (resolveAccess).
 */
export const mintAccess = mutation({
  args: { fileId: v.id("userFiles"), purpose: v.union(v.literal("download"), v.literal("preview")) },
  handler: async (ctx, { fileId, purpose }) => {
    const userId = await requireUserId(ctx);
    const f = await ownedFile(ctx, userId, fileId);
    await requireMember(ctx, userId, f.workspaceId);
    if (!f.storageId) throw new ConvexError("This file's original is being restored. Try again later.");
    if (purpose === "preview" && !toLibraryRow(f).canPreview) throw new ConvexError("Not found");
    const rate = await consumeWindow(ctx, userId, "libraryAccess", ACCESS_PER_HOUR, HOUR);
    if (!rate.ok) throw libraryError("RATE_LIMITED", "Too many downloads. Please wait a moment.");
    // The byte budget is charged here, once per capability (see *_MAX_USES).
    const bytes = await consumeWindow(ctx, userId, "libraryBytes", BYTES_PER_HOUR, HOUR, f.size);
    if (!bytes.ok) {
      throw libraryError("RATE_LIMITED", "You've downloaded a lot this hour. Please try again later.");
    }
    return { token: await mintOne(ctx, userId, f, purpose) };
  },
});

/** Preview tokens for a page of image cards (bounded). */
export const mintPreviews = mutation({
  args: { fileIds: v.array(v.id("userFiles")) },
  handler: async (ctx, { fileIds }) => {
    const userId = await requireUserId(ctx);
    const out: { fileId: Id<"userFiles">; token: string }[] = [];
    let bytes = 0;
    for (const id of fileIds.slice(0, 24)) {
      const f = await ctx.db.get(id);
      if (!f || f.userId !== userId || !toLibraryRow(f).canPreview) continue;
      if (!(await hasWorkspaceAccess(ctx, userId, f.workspaceId))) continue;
      out.push({ fileId: id, token: await mintOne(ctx, userId, f, "preview") });
      bytes += f.size;
    }
    if (out.length > 0) {
      // One request unit per batch and the batch's bytes, charged at mint (a
      // throw rolls the minted tokens back with it).
      const rate = await consumeWindow(ctx, userId, "libraryAccess", ACCESS_PER_HOUR, HOUR, 1);
      const budget = rate.ok
        ? await consumeWindow(ctx, userId, "libraryBytes", BYTES_PER_HOUR, HOUR, bytes)
        : rate;
      if (!budget.ok) throw libraryError("RATE_LIMITED", "Too many requests. Please wait a moment.");
    }
    return out;
  },
});

/**
 * The /library/file route's gate (http.ts). Resolves a token by its hash and
 * re-authorises EVERY use: unexpired, the right purpose, the file still there,
 * its owner still active and still a member, the bytes still stored — and the
 * owner's hourly request and byte budget. Any failure is the same null, so the
 * route answers one uniform 404 (429 for budget).
 */
export const resolveAccess = internalMutation({
  args: { tokenHash: v.string(), purpose: v.union(v.literal("download"), v.literal("preview")) },
  handler: async (ctx, { tokenHash, purpose }) => {
    const t = await ctx.db
      .query("fileAccessTokens")
      .withIndex("by_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!t || t.expiresAt < Date.now() || t.purpose !== purpose) return { ok: false as const, status: 404 };
    const f = await ctx.db.get(t.fileId);
    if (!f || f.userId !== t.userId || !f.storageId) return { ok: false as const, status: 404 };
    if (!(await isActiveUser(ctx, t.userId))) return { ok: false as const, status: 404 };
    if (!(await hasWorkspaceAccess(ctx, t.userId, f.workspaceId))) return { ok: false as const, status: 404 };
    // Uses are counted on THIS token's row (budgets were charged at mint), so
    // concurrent fetches of different files never write the same document.
    const uses = t.uses ?? 0;
    const maxUses = t.maxUses ?? (t.purpose === "download" ? DOWNLOAD_MAX_USES : PREVIEW_MAX_USES);
    if (uses >= maxUses) {
      logEvent("LIB_DENIED", { reason: "uses", userId: t.userId, fileId: f._id });
      return { ok: false as const, status: 429 };
    }
    await ctx.db.patch(t._id, { uses: uses + 1 });
    logEvent(purpose === "download" ? "LIB_DOWNLOAD" : "LIB_PREVIEW", { userId: t.userId, fileId: f._id, size: f.size });
    return { ok: true as const, storageId: f.storageId, name: f.name, size: f.size };
  },
});

/** Expired capabilities (crons.ts). Bounded per run. */
export const purgeExpiredTokens = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query("fileAccessTokens")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
      .take(500);
    for (const t of old) await ctx.db.delete(t._id);
    return { deleted: old.length };
  },
});

// ------------------------------------------------------------------ operators

/**
 * Operator view (npx convex run library:stats). Counts only — no names, ids of
 * users or files beyond the top consumers' ids.
 */
export const stats = internalQuery({
  args: {},
  handler: async (ctx) => {
    const usage = await ctx.db.query("storageUsage").take(5000);
    const global = usage.find((u) => u.key === GLOBAL_KEY);
    const users = usage.filter((u) => u.key.startsWith("user:"));
    const byStatus: Record<string, number> = {};
    for (const s of ["processing", "ready", "failed", "stored"] as const) {
      byStatus[s] = (
        await ctx.db
          .query("userFiles")
          .withIndex("by_status_updated", (q) => q.eq("status", s))
          .take(10_000)
      ).length;
    }
    const since = Date.now() - 24 * HOUR;
    const failed24h = (
      await ctx.db
        .query("userFiles")
        .withIndex("by_status_updated", (q) => q.eq("status", "failed").gt("updatedAt", since))
        .take(10_000)
    ).length;
    return {
      globalUsedBytes: global?.usedBytes ?? 0,
      globalCeilingBytes: GLOBAL_CEILING_BYTES,
      usersNearFull: users.filter((u) => u.usedBytes >= USER_QUOTA_BYTES * 0.9).length,
      topUsers: users
        .sort((a, b) => b.usedBytes - a.usedBytes)
        .slice(0, 10)
        .map((u) => ({ key: u.key, usedBytes: u.usedBytes, files: u.files })),
      byStatus,
      processingQueueDepth: byStatus.processing,
      failedLast24h: failed24h,
    };
  },
});


