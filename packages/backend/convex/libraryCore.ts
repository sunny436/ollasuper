import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { audit } from "./auditLog";
import { deleteBlobIfUnreferenced } from "./blobOwnership";
import { bump } from "./counters";
import { fileKind, isProcessable, nameKeyOf, sanitizeFileName, sha256Hex } from "./fileKind";
import { notify } from "./notifications";
import { unlinkFileEverywhere } from "./projects";
import { consumeWindow, peekWindow } from "./quotas";

/**
 * File Library core — the ONE place a Library file is created, charged,
 * released and deleted. Every entry point (Library upload, chat paperclip,
 * Projects, the legacy saveFile/register paths, generated files, migrations)
 * goes through here, so a quota can never be bypassed through a side door.
 *
 * QUOTA (your decision, 2026-09-28): 100 MB of UPLOADED bytes per user, across
 * the whole app. Generated files are not charged and never evicted. A global
 * ceiling over ALL Library bytes protects the disk (every byte also lands in
 * each of the 7 daily backups — ROADMAP capacity note).
 *
 * Accounting is physical and per row: every Library row owns a distinct blob,
 * so usage is the sum of its rows' sizes, adjusted inside the very mutation
 * that creates or deletes the row. Reservations are NOT stored: they are the
 * live sum of `declaredBytes` over the user's open, unexpired upload sessions,
 * so a crashed browser's reservation lapses with its TTL and nothing has to
 * clean it up. Two concurrent finalizes both read the user's usage document,
 * so Convex serialises them — neither can overshoot, and neither can evict the
 * same file twice.
 */

export const USER_QUOTA_BYTES = 100 * 1024 * 1024;
export const GLOBAL_CEILING_BYTES =
  Number(process.env.LIBRARY_GLOBAL_CEILING_BYTES) > 0
    ? Number(process.env.LIBRARY_GLOBAL_CEILING_BYTES)
    : 500 * 1024 * 1024;
/** Keeps the degenerate "100 MB of tiny files" case inside the eviction bound. */
export const MAX_FILES_PER_USER = 2_000;
/**
 * Upload sessions per user per hour, shared by EVERY upload door (Library,
 * chat, Projects, the legacy saveFile paths). It only stops floods — bytes are
 * bounded by the quota, the global ceiling and the edge's 26 MB cap. It was 60,
 * which failed a folder of 80 documents partway through (found by the F-12
 * production suite seeding 201 files).
 */
export const UPLOADS_PER_HOUR = 300;
export const UPLOAD_WINDOW_MS = 60 * 60_000;

/**
 * Uploaded BYTES per user per day, NOT refunded by deleting. The quota bounds
 * live bytes, but this self-hosted Convex never reclaims a deleted blob's
 * bytes from disk (measured on production: 1,639 blob files older than the
 * 2-day retention window vs 753 live documents), so upload-delete churn grew
 * the disk without bound — up to ~7.5 GB/h at the upload rate limit, against
 * 14 GB free. 1 GiB/day is ten times the quota: generous for real use, a hard
 * bound on churn per account.
 */
export const UPLOAD_BYTES_PER_DAY = 1024 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60_000;

/** Would `bytes` more fit today's upload budget? (No write — for beginUpload.) */
export async function assertUploadBudget(ctx: MutationCtx, userId: Id<"users">, bytes: number): Promise<void> {
  const { result } = await peekWindow(ctx, userId, "libraryUploadBytes", UPLOAD_BYTES_PER_DAY, DAY_MS, bytes);
  if (!result.ok) {
    throw libraryError("RATE_LIMITED", "You've uploaded a lot today. Please try again tomorrow.");
  }
}

/** At most this many files are removed by one upload. */
export const MAX_EVICTIONS = 50;
/** Processing intake: files a user may have in flight at once. */
export const MAX_PROCESSING_PER_USER = 20;
/** Size caps, server-side, from the stored blob's own metadata. */
export const LIMITS = {
  processable: 20 * 1024 * 1024,
  stored: 25 * 1024 * 1024,
} as const;
/** The one-time "almost out of space" notice fires at 90 % and re-arms below 80 %. */
const NEAR_FULL = 0.9;
const NEAR_FULL_REARM = 0.8;

export const userKey = (userId: Id<"users">) => `user:${userId}`;
export const GLOBAL_KEY = "global";

async function usageDoc(ctx: QueryCtx, key: string) {
  return ctx.db
    .query("storageUsage")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

export async function usedBytes(ctx: QueryCtx, key: string): Promise<number> {
  return (await usageDoc(ctx, key))?.usedBytes ?? 0;
}

async function adjust(
  ctx: MutationCtx,
  key: string,
  bytes: number,
  files: number,
): Promise<Doc<"storageUsage">> {
  const doc = await usageDoc(ctx, key);
  if (!doc) {
    const id = await ctx.db.insert("storageUsage", {
      key,
      usedBytes: Math.max(0, bytes),
      files: Math.max(0, files),
    });
    return (await ctx.db.get(id)) as Doc<"storageUsage">;
  }
  const next = {
    usedBytes: Math.max(0, doc.usedBytes + bytes),
    files: Math.max(0, doc.files + files),
  };
  await ctx.db.patch(doc._id, next);
  return { ...doc, ...next };
}

/** Uploaded files are charged to their owner; generated ones only globally. */
export const isCharged = (f: Pick<Doc<"userFiles">, "source">) => f.source !== "generated";

/** Live reservations: open, unexpired Library upload sessions (optionally minus one). */
export async function reservedBytes(
  ctx: QueryCtx,
  userId: Id<"users">,
  exceptIntent?: Id<"uploadIntents">,
): Promise<number> {
  const now = Date.now();
  const open = await ctx.db
    .query("uploadIntents")
    .withIndex("by_user_expires", (q) => q.eq("userId", userId).gt("expiresAt", now))
    .take(200);
  let sum = 0;
  for (const i of open) {
    if (i._id === exceptIntent) continue;
    if (i.status === "created" && i.declaredBytes) sum += i.declaredBytes;
  }
  return sum;
}

/**
 * The user's files that may be deleted to make room: their own UPLOADS, oldest
 * first, never a generated file and never a file linked to a Project (your
 * decision — a Project must not silently lose its sources).
 */
export async function deletableForSpace(
  ctx: QueryCtx,
  userId: Id<"users">,
  limit = 200,
): Promise<Doc<"userFiles">[]> {
  const out: Doc<"userFiles">[] = [];
  // UPLOADS only, via their own index: generated rows are unbounded and would
  // otherwise use up this bounded scan. Uploads are capped at
  // MAX_FILES_PER_USER, so the scan covers them all; Project-linked ones are
  // skipped.
  const rows = await ctx.db
    .query("userFiles")
    .withIndex("by_user_source_created", (q) => q.eq("userId", userId).eq("source", "uploaded"))
    .order("asc")
    .take(MAX_FILES_PER_USER + 50);
  for (const f of rows) {
    if (await projectLinked(ctx, f._id)) continue;
    out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}

async function projectLinked(ctx: QueryCtx, fileId: Id<"userFiles">): Promise<boolean> {
  const edge = await ctx.db
    .query("projectFiles")
    .withIndex("by_file", (q) => q.eq("fileId", fileId))
    .first();
  return edge !== null;
}

/** Is `fileId` still something the user may approve for deletion right now? */
export async function stillDeletable(
  ctx: QueryCtx,
  userId: Id<"users">,
  fileId: Id<"userFiles">,
): Promise<Doc<"userFiles"> | null> {
  const f = await ctx.db.get(fileId);
  if (!f || f.userId !== userId || !isCharged(f)) return null;
  if (await projectLinked(ctx, fileId)) return null;
  return f;
}

export type SpacePlan = {
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  needBytes: number;
  /** How much must be freed for `needBytes` to fit (0 = it already fits). */
  shortBytes: number;
  /** The oldest deletable files, pre-selected until the new file fits. */
  suggested: Id<"userFiles">[];
  /** Whether deleting every deletable file could make it fit at all. */
  canFit: boolean;
};

/** What fitting `needBytes` more would take. Reads only; deletes nothing. */
export async function planSpace(
  ctx: QueryCtx,
  userId: Id<"users">,
  needBytes: number,
  exceptIntent?: Id<"uploadIntents">,
): Promise<SpacePlan> {
  return (await planSpaceWithCandidates(ctx, userId, needBytes, exceptIntent)).plan;
}

/**
 * The plan AND the deletable files it was computed from (empty when the file
 * already fits). One scan, reused by the caller for the Free-up-space list:
 * the scan costs one index lookup per file (the Project-link check), and
 * scanning twice in one mutation could pass Convex's per-function limit of
 * 4,096 index reads for a user near MAX_FILES_PER_USER — failing the upload.
 */
export async function planSpaceWithCandidates(
  ctx: QueryCtx,
  userId: Id<"users">,
  needBytes: number,
  exceptIntent?: Id<"uploadIntents">,
): Promise<{ plan: SpacePlan; candidates: Doc<"userFiles">[] }> {
  const used = await usedBytes(ctx, userKey(userId));
  const reserved = await reservedBytes(ctx, userId, exceptIntent);
  const short = Math.max(0, used + reserved + needBytes - USER_QUOTA_BYTES);
  const suggested: Id<"userFiles">[] = [];
  let freed = 0;
  let deletableTotal = 0;
  const candidates = short > 0 ? await deletableForSpace(ctx, userId) : [];
  for (const f of candidates) {
    deletableTotal += f.size;
    if (freed < short && suggested.length < MAX_EVICTIONS) {
      suggested.push(f._id);
      freed += f.size;
    }
  }
  return {
    plan: {
      quotaBytes: USER_QUOTA_BYTES,
      usedBytes: used,
      reservedBytes: reserved,
      needBytes,
      shortBytes: short,
      suggested,
      canFit: short === 0 || (deletableTotal >= short && freed >= short),
    },
    candidates,
  };
}

/** Machine-readable failures the UI acts on. */
export function libraryError(
  code:
    | "QUOTA_EXCEEDED"
    | "QUOTA_PLAN_CHANGED"
    | "GLOBAL_FULL"
    | "TOO_LARGE"
    | "EMPTY"
    | "SIZE_MISMATCH"
    | "TOO_MANY_FILES"
    | "PROCESSING_BUSY"
    | "RATE_LIMITED",
  message: string,
  extra: Record<string, unknown> = {},
): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message, ...extra });
}

export type CreateArgs = {
  userId: Id<"users">;
  workspaceId: Id<"workspaces">;
  storageId: Id<"_storage">;
  name: string;
  contentType: string;
  size: number;
  sha256?: string;
  source: "uploaded" | "generated";
  artifactId?: Id<"chatArtifacts">;
  legacyFileId?: Id<"files">;
  createdAt?: number;
  /** Migrations fold existing bytes in as-is; they are never re-processed. */
  forceStored?: boolean;
};

/**
 * Insert ONE Library row and charge it. The caller has already proven the blob
 * is the user's (upload session / claim / artifact / migration) and checked the
 * quota; this only enforces the invariants every path shares.
 */
export async function createLibraryFile(
  ctx: MutationCtx,
  a: CreateArgs,
): Promise<Id<"userFiles">> {
  // One logical file per blob: a second row on the same bytes would double-
  // charge them and let one delete strand the other.
  const taken = await ctx.db
    .query("userFiles")
    .withIndex("by_storage", (q) => q.eq("storageId", a.storageId))
    .first();
  if (taken) throw new ConvexError("Not found");

  const name = sanitizeFileName(a.name);
  const sha256 = sha256Hex(a.sha256);
  const processable =
    a.source === "uploaded" && !a.forceStored && isProcessable(name, a.contentType);
  // Today's upload budget (see UPLOAD_BYTES_PER_DAY), charged at EVERY door on
  // the actual size. Migrations fold existing bytes in and are not uploads.
  if (a.source === "uploaded" && !a.legacyFileId) {
    const budget = await consumeWindow(ctx, a.userId, "libraryUploadBytes", UPLOAD_BYTES_PER_DAY, DAY_MS, a.size);
    if (!budget.ok) {
      throw libraryError("RATE_LIMITED", "You've uploaded a lot today. Please try again tomorrow.");
    }
  }
  if (processable) {
    // The processing intake cap, enforced HERE so no door can skip it. It used
    // to live only in library.beginUpload; the legacy saveFile/register doors
    // let one script queue 200+ files, each polling Python for a slot.
    const inFlight = await ctx.db
      .query("userFiles")
      .withIndex("by_user_status", (q) => q.eq("userId", a.userId).eq("status", "processing"))
      .take(MAX_PROCESSING_PER_USER);
    if (inFlight.length >= MAX_PROCESSING_PER_USER) {
      throw libraryError("PROCESSING_BUSY", "Several of your files are still processing. Try again shortly.");
    }
  }
  const now = Date.now();
  const id = await ctx.db.insert("userFiles", {
    userId: a.userId,
    workspaceId: a.workspaceId,
    name,
    nameKey: nameKeyOf(name),
    storageId: a.storageId,
    size: a.size,
    contentType: a.contentType.slice(0, 200),
    ingestId: crypto.randomUUID(),
    status: processable ? "processing" : "stored",
    attempts: 0,
    ...(sha256 ? { sha256, contentHash: sha256 } : {}),
    source: a.source,
    kind: fileKind(name, a.contentType),
    ...(a.artifactId ? { artifactId: a.artifactId } : {}),
    ...(a.legacyFileId ? { legacyFileId: a.legacyFileId } : {}),
    createdAt: a.createdAt ?? now,
    updatedAt: now,
  });
  // Generated rows reference their artifact's EXISTING bytes (no new disk), so
  // they are charged to nobody — not the user, and not the global ceiling. If
  // they counted globally, one user generating files could fill the ceiling
  // and block every other user's uploads.
  if (a.source === "uploaded") {
    const user = await adjust(ctx, userKey(a.userId), a.size, 1);
    await maybeNearFull(ctx, a.userId, user);
    await adjust(ctx, GLOBAL_KEY, a.size, 1);
  }
  await bump(ctx, a.workspaceId, "userFiles", 1);
  await audit(ctx, a.workspaceId, a.userId, "userfile.upload", { fileId: id });
  if (processable) {
    await ctx.scheduler.runAfter(0, internal.userFiles.dispatch, { fileId: id });
  }
  return id;
}

/** The one-time 90 % notice; re-arms once usage falls below 80 %. */
async function maybeNearFull(
  ctx: MutationCtx,
  userId: Id<"users">,
  doc: Doc<"storageUsage">,
): Promise<void> {
  const ratio = doc.usedBytes / USER_QUOTA_BYTES;
  if (ratio >= NEAR_FULL && !doc.nearFullAt) {
    await ctx.db.patch(doc._id, { nearFullAt: Date.now() });
    await notify(
      ctx,
      userId,
      "library.near_full",
      "You're almost out of space",
      `Your Library uses ${Math.round(ratio * 100)}% of your 100 MB. Free up space to keep uploading.`,
    );
  } else if (ratio < NEAR_FULL_REARM && doc.nearFullAt) {
    await ctx.db.patch(doc._id, { nearFullAt: undefined });
  }
}

/**
 * Release a Library row's quota charge (once) and revoke its capabilities.
 * For callers that delete rows in bulk outside removeLibraryFile — account
 * deletion — so the global ledger cannot drift upward with every deleted
 * account until uploads falsely report "Storage is temporarily full".
 */
export async function releaseLibraryCharge(ctx: MutationCtx, f: Doc<"userFiles">): Promise<void> {
  if (isCharged(f)) {
    await adjust(ctx, userKey(f.userId), -f.size, -1);
    await adjust(ctx, GLOBAL_KEY, -f.size, -1);
  }
  const tokens = await ctx.db
    .query("fileAccessTokens")
    .withIndex("by_file", (q) => q.eq("fileId", f._id))
    .take(500);
  for (const t of tokens) await ctx.db.delete(t._id);
}

/**
 * Delete ONE Library file completely, inside the caller's transaction:
 * its chat references, its Project links, its access tokens, its charge (once),
 * its row, its bytes (when nothing else references them) and — scheduled — its
 * derived Python data behind a tombstone. Returns the deleted name.
 *
 * A generated file's chat card keeps working: its chatArtifacts row still
 * references the blob, so the bytes stay until the chat is deleted too.
 */
export async function removeLibraryFile(
  ctx: MutationCtx,
  f: Doc<"userFiles">,
  reason: "user" | "evicted",
): Promise<string> {
  const refs = await ctx.db
    .query("chatAttachments")
    .withIndex("by_userfile", (q) => q.eq("userFileId", f._id))
    .take(1_000);
  for (const r of refs) await ctx.db.delete(r._id);
  await unlinkFileEverywhere(ctx, f._id);
  const tokens = await ctx.db
    .query("fileAccessTokens")
    .withIndex("by_file", (q) => q.eq("fileId", f._id))
    .take(500);
  for (const t of tokens) await ctx.db.delete(t._id);

  await ctx.db.delete(f._id);
  if (isCharged(f)) {
    const user = await adjust(ctx, userKey(f.userId), -f.size, -1);
    await maybeNearFull(ctx, f.userId, user);
    await adjust(ctx, GLOBAL_KEY, -f.size, -1);
  }
  if (f.storageId) await deleteBlobIfUnreferenced(ctx, f.storageId);
  await bump(ctx, f.workspaceId, "userFiles", -1);
  await audit(ctx, f.workspaceId, f.userId, reason === "evicted" ? "userfile.evict" : "userfile.delete", {
    fileId: f._id,
  });
  // A stored-only file never reached Python; anything else may have.
  if (f.status !== "stored") {
    await ctx.scheduler.runAfter(0, internal.userFiles.purge, { ingestId: f.ingestId });
  }
  return f.name;
}

/**
 * The legacy upload doors (userFiles.saveFile, files.saveFile, chat register)
 * predate upload sessions: no reservation, no eviction. They still may not
 * exceed the quota, the file cap or the global ceiling.
 */
export async function assertRoomWithoutEviction(
  ctx: QueryCtx,
  userId: Id<"users">,
  size: number,
): Promise<void> {
  const plan = await planSpace(ctx, userId, size);
  if (plan.shortBytes > 0) {
    throw libraryError("QUOTA_EXCEEDED", "Your Library is full (100 MB). Free up space to upload.");
  }
  await assertGlobalRoom(ctx, size);
  await assertFileCap(ctx, userId);
}

export async function assertGlobalRoom(ctx: QueryCtx, size: number): Promise<void> {
  if ((await usedBytes(ctx, GLOBAL_KEY)) + size > GLOBAL_CEILING_BYTES) {
    throw libraryError("GLOBAL_FULL", "Storage is temporarily full. Please try again later.");
  }
}

export async function assertFileCap(ctx: QueryCtx, userId: Id<"users">): Promise<void> {
  const usage = await usageDoc(ctx, userKey(userId));
  if ((usage?.files ?? 0) >= MAX_FILES_PER_USER) {
    throw libraryError("TOO_MANY_FILES", `You can keep up to ${MAX_FILES_PER_USER} files. Delete some to upload more.`);
  }
}

/** The size cap for a file of this kind. */
export function capFor(name: string, contentType: string): number {
  return isProcessable(name, contentType) ? LIMITS.processable : LIMITS.stored;
}

/**
 * A generated artifact becomes a Library file on the artifact's OWN bytes —
 * the same blob, referenced by the chatArtifacts row and this row, both the
 * user's; it is deleted only when neither references it. Idempotent by
 * artifactId (a crash-resumed turn re-registers). Charged to nobody: it adds
 * no bytes (your decision: uploads only count), so it cannot be refused.
 */
export async function addGeneratedToLibrary(
  ctx: MutationCtx,
  a: {
    artifactId: Id<"chatArtifacts">;
    userId: Id<"users">;
    workspaceId: Id<"workspaces">;
    storageId: Id<"_storage">;
    name: string;
    contentType: string;
    size: number;
  },
): Promise<Id<"userFiles"> | null> {
  const existing = await ctx.db
    .query("userFiles")
    .withIndex("by_artifact", (q) => q.eq("artifactId", a.artifactId))
    .first();
  if (existing) return existing._id;
  const meta = await ctx.db.system.get(a.storageId);
  return await createLibraryFile(ctx, {
    ...a,
    size: meta?.size ?? a.size,
    ...(meta?.sha256 ? { sha256: meta.sha256 } : {}),
    source: "generated",
  });
}
