import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { GENERATED_LIVE_BYTES, GLOBAL_CEILING_BYTES, GLOBAL_KEY, MAX_PROCESSING_PER_USER, usedBytes } from "./libraryCore";

/**
 * File Library — the processing lifecycle beyond one dispatch:
 *
 *   * stable FAILURE CODES, and which of them are worth retrying;
 *   * AUTOMATIC RETRY with backoff, a storm cap, then a DEAD LETTER;
 *   * the GENERATION FENCE — every attempt has an identity, and only the
 *     current one may move a row (userFiles.setStatus applies it);
 *   * background RE-INDEX when the embedding model or pipeline changes, with
 *     the file staying searchable on its old chunks until the swap;
 *   * the CROSS-PLANE RECONCILE — Python rows no Convex file owns are purged;
 *   * the operator/monitor health snapshot.
 */

// ------------------------------------------------------------ failure codes

/**
 * Every failure a file can end in, by stable code. The UI and the monitor
 * key on these, never on the message text. `retry` = worth another attempt
 * without the user doing anything (a transient cause).
 */
export const FAILURE_CODES = {
  // Reported by Python (app/ingest/types.py IngestError.code).
  PARSE_FAILED: { retry: false },
  PARSE_TIMEOUT: { retry: true },
  OCR_TIMEOUT: { retry: true },
  UNSUPPORTED: { retry: false },
  TOO_LARGE: { retry: false },
  INTEGRITY: { retry: false },
  EMBED_PROVIDER: { retry: true },
  EMBED_RATE_LIMIT: { retry: true },
  KNOWLEDGE_DB: { retry: true },
  SANDBOX_UNAVAILABLE: { retry: true },
  FETCH_FAILED: { retry: true },
  INTERNAL: { retry: true },
  // Decided here.
  NOT_CONFIGURED: { retry: true },
  DISPATCH_FAILED: { retry: true },
  DISPATCH_REJECTED: { retry: true },
  QUEUE_EXHAUSTED: { retry: true },
  TIMEOUT: { retry: true },
  // A failure recorded before codes existed, with a message nobody mapped.
  LEGACY: { retry: true },
} as const;
export type FailureCode = keyof typeof FAILURE_CODES;

export function isFailureCode(x: unknown): x is FailureCode {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(FAILURE_CODES, x);
}

export function isRetryable(code: FailureCode): boolean {
  return FAILURE_CODES[code].retry;
}

/** The code for a failure recorded as text only (before codes, or an old Python). */
export function codeFromMessage(message: string | undefined): FailureCode {
  const m = (message ?? "").trim();
  if (m === "Embedding provider failed") return "EMBED_PROVIDER";
  if (m === "Embedding rate limit exceeded") return "EMBED_RATE_LIMIT";
  if (m === "Knowledge database write failed") return "KNOWLEDGE_DB";
  if (m === "Ingest service responded 429" || m.startsWith("Processing is busy")) return "QUEUE_EXHAUSTED";
  if (/^Ingest service responded \d+$/.test(m)) return "DISPATCH_REJECTED";
  if (m === "Ingest dispatch failed") return "DISPATCH_FAILED";
  if (m === "Inference plane not configured") return "NOT_CONFIGURED";
  if (m.startsWith("Processing timed out")) return "TIMEOUT";
  if (m === "Parsing timed out") return "PARSE_TIMEOUT";
  if (m === "OCR timed out") return "OCR_TIMEOUT";
  if (m === "The stored file failed its integrity check") return "INTEGRITY";
  if (m.startsWith("File too large")) return "TOO_LARGE";
  if (m.startsWith("no parser for")) return "UNSUPPORTED";
  if (m === "Parsing failed" || m.startsWith("Parsing failed")) return "PARSE_FAILED";
  if (m === "Ingestion failed") return "INTERNAL";
  return "LEGACY";
}

// ------------------------------------------------------------ retry policy

/** Automatic attempts after the first failure, then a dead letter. */
export const AUTO_RETRY_MAX = 3;
/** 10 min, 1 h, 6 h — a provider outage or a deploy is usually over by then. */
const BACKOFF_MS = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const;
/** Storm cap: files re-dispatched per run of the cron (every 5 minutes). */
export const AUTO_RETRY_BATCH = 10;
/** Past this many files processing app-wide, a run re-dispatches nothing. */
export const GLOBAL_PROCESSING_SOFT_CAP = 40;
const BUSY_DEFER_MS = 10 * 60_000;
/** A requeue spreads the backlog out instead of waking it all at once. */
const REQUEUE_STAGGER_MS = 30_000;

function backoffMs(autoRetries: number): number {
  const base = BACKOFF_MS[Math.min(autoRetries, BACKOFF_MS.length - 1)] ?? 6 * 60 * 60_000;
  // Up to 20 % jitter so a batch that failed together does not retry together.
  return base + Math.floor(Math.random() * base * 0.2);
}

const CLEAR_PROGRESS = {
  stage: undefined,
  progress: undefined,
  processedUnits: undefined,
  totalUnits: undefined,
  stageMessage: undefined,
} as const;

function logEvent(code: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: code, ...fields }));
}

/**
 * Move a PROCESSING row to failed with a code: a retryable cause schedules an
 * automatic retry (with backoff) while retries remain, anything else — or an
 * exhausted budget, or a missing original — is a dead letter the user sees
 * and can still retry by hand.
 */
export async function applyFailure(
  ctx: MutationCtx,
  f: Doc<"userFiles">,
  code: FailureCode,
  message: string,
): Promise<void> {
  const now = Date.now();
  const autoRetries = f.autoRetries ?? 0;
  const willRetry = isRetryable(code) && autoRetries < AUTO_RETRY_MAX && f.storageId !== undefined;
  await ctx.db.patch(f._id, {
    status: "failed",
    error: message.slice(0, 500),
    failureCode: code,
    nextRetryAt: willRetry ? now + backoffMs(autoRetries) : undefined,
    deadLetteredAt: willRetry ? undefined : now,
    ...CLEAR_PROGRESS,
    updatedAt: now,
  });
  logEvent(willRetry ? "LIB_RETRY_SCHEDULED" : "LIB_DEAD_LETTER", {
    fileId: f._id,
    userId: f.userId,
    code,
    autoRetries,
  });
}

/** A re-index attempt ended without swapping the chunks: the file stays ready. */
export async function endReindex(
  ctx: MutationCtx,
  f: Doc<"userFiles">,
  error: string | undefined,
): Promise<void> {
  await ctx.db.patch(f._id, {
    reindexing: undefined,
    reindexStartedAt: undefined,
    ...(error
      ? { reindexError: error.slice(0, 500), reindexAttempts: (f.reindexAttempts ?? 0) + 1 }
      : { reindexError: undefined, reindexAttempts: undefined }),
    updatedAt: Date.now(),
  });
  logEvent(error ? "LIB_REINDEX_FAIL" : "LIB_REINDEX_OK", { fileId: f._id, userId: f.userId });
}

async function processingCount(ctx: QueryCtx, userId: Id<"users">, cap: number): Promise<number> {
  return (
    await ctx.db
      .query("userFiles")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "processing"))
      .take(cap)
  ).length;
}

async function globalProcessing(ctx: QueryCtx, cap: number): Promise<number> {
  return (
    await ctx.db
      .query("userFiles")
      .withIndex("by_status_updated", (q) => q.eq("status", "processing"))
      .take(cap)
  ).length;
}

/**
 * The automatic retry (crons.ts, every 5 minutes). Bounded three ways: at most
 * AUTO_RETRY_BATCH files per run, nothing while the plane is already busy
 * app-wide, and never past a user's own processing intake — a retry storm is
 * a queue, not a flood.
 */
export const autoRetryDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    if ((await globalProcessing(ctx, GLOBAL_PROCESSING_SOFT_CAP)) >= GLOBAL_PROCESSING_SOFT_CAP) {
      logEvent("LIB_RETRY_DEFERRED", { reason: "global_busy" });
      return { retried: 0, deferred: true };
    }
    const due = await ctx.db
      .query("userFiles")
      .withIndex("by_status_next_retry", (q) =>
        q.eq("status", "failed").gt("nextRetryAt", 0).lte("nextRetryAt", now),
      )
      .take(AUTO_RETRY_BATCH);
    let retried = 0;
    for (const f of due) {
      if (!f.storageId) {
        await ctx.db.patch(f._id, { nextRetryAt: undefined, deadLetteredAt: now, updatedAt: now });
        continue;
      }
      if ((await processingCount(ctx, f.userId, MAX_PROCESSING_PER_USER)) >= MAX_PROCESSING_PER_USER) {
        await ctx.db.patch(f._id, { nextRetryAt: now + BUSY_DEFER_MS });
        continue;
      }
      const generation = (f.generation ?? 1) + 1;
      await ctx.db.patch(f._id, {
        status: "processing",
        error: undefined,
        nextRetryAt: undefined,
        attempts: 0,
        autoRetries: (f.autoRetries ?? 0) + 1,
        generation,
        ...CLEAR_PROGRESS,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.userFiles.dispatch, { fileId: f._id });
      logEvent("LIB_RETRY_DISPATCHED", { fileId: f._id, userId: f.userId, generation, code: f.failureCode });
      retried++;
    }
    return { retried, deferred: false };
  },
});

/**
 * Operator migration for files that failed before codes existed (dry run by
 * default; page with the returned cursor). Each gets a code; a retryable one
 * with its original is queued for the automatic retry, spread out by
 * REQUEUE_STAGGER_MS; anything else is dead-lettered (still retryable by hand).
 * Idempotent: a row that already has a code or a schedule is only counted.
 */
export const requeueFailed = internalMutation({
  args: { dryRun: v.optional(v.boolean()), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { dryRun, cursor }) => {
    const dry = dryRun !== false;
    const res = await ctx.db
      .query("userFiles")
      .withIndex("by_status_updated", (q) => q.eq("status", "failed"))
      .paginate({ numItems: 100, cursor: cursor ?? null });
    const byCode: Record<string, number> = {};
    const outcome = { requeue: 0, deadLetter: 0, needsReupload: 0, alreadyHandled: 0 };
    const now = Date.now();
    let slot = 0;
    for (const f of res.page) {
      const code: FailureCode = isFailureCode(f.failureCode) ? f.failureCode : codeFromMessage(f.error);
      byCode[code] = (byCode[code] ?? 0) + 1;
      if (f.nextRetryAt !== undefined || f.deadLetteredAt !== undefined) {
        outcome.alreadyHandled++;
        continue;
      }
      if (!f.storageId) {
        outcome.needsReupload++;
        if (!dry) await ctx.db.patch(f._id, { failureCode: code, deadLetteredAt: now });
        continue;
      }
      if (isRetryable(code)) {
        outcome.requeue++;
        if (!dry) {
          await ctx.db.patch(f._id, {
            failureCode: code,
            autoRetries: 0,
            nextRetryAt: now + slot * REQUEUE_STAGGER_MS + 1,
          });
        }
        slot++;
      } else {
        outcome.deadLetter++;
        if (!dry) await ctx.db.patch(f._id, { failureCode: code, deadLetteredAt: now });
      }
    }
    return {
      dryRun: dry,
      scanned: res.page.length,
      byCode,
      ...outcome,
      isDone: res.isDone,
      continueCursor: res.continueCursor,
    };
  },
});

// ------------------------------------------------------------ re-index

/** Files re-indexed per run (hourly), and the attempts one file gets. */
const REINDEX_BATCH = 10;
export const REINDEX_MAX_ATTEMPTS = 3;
const REINDEX_STALL_MS = 30 * 60_000;

/**
 * Start re-indexing the given ingests (ids Python reported as stale). The file
 * STAYS `ready` — retrieval keeps serving its old chunks, under the model that
 * made them, until Python swaps the new ones in atomically. Bounded like the
 * automatic retry, and never for a file already mid-flight or given up on.
 */
export const startReindex = internalMutation({
  args: { ingestIds: v.array(v.string()) },
  handler: async (ctx, { ingestIds }) => {
    if ((await globalProcessing(ctx, GLOBAL_PROCESSING_SOFT_CAP)) >= GLOBAL_PROCESSING_SOFT_CAP) {
      return { started: 0, deferred: true };
    }
    const now = Date.now();
    let started = 0;
    for (const ingestId of ingestIds.slice(0, 200)) {
      if (started >= REINDEX_BATCH) break;
      const f = await ctx.db
        .query("userFiles")
        .withIndex("by_ingestId", (q) => q.eq("ingestId", ingestId))
        .unique();
      if (
        !f ||
        f.status !== "ready" ||
        f.reindexing ||
        !f.storageId ||
        (f.reindexAttempts ?? 0) >= REINDEX_MAX_ATTEMPTS
      ) {
        continue;
      }
      if ((await processingCount(ctx, f.userId, MAX_PROCESSING_PER_USER)) >= MAX_PROCESSING_PER_USER) continue;
      const generation = (f.generation ?? 1) + 1;
      await ctx.db.patch(f._id, { reindexing: true, reindexStartedAt: now, generation });
      await ctx.scheduler.runAfter(0, internal.userFiles.dispatch, { fileId: f._id });
      logEvent("LIB_REINDEX_START", { fileId: f._id, userId: f.userId, generation });
      started++;
    }
    return { started, deferred: false };
  },
});

/** Re-index runs whose worker never answered (reapStalled's twin, same cron). */
export async function reapStalledReindex(ctx: MutationCtx): Promise<number> {
  const cutoff = Date.now() - REINDEX_STALL_MS;
  const stalled = await ctx.db
    .query("userFiles")
    .withIndex("by_reindex_started", (q) => q.gt("reindexStartedAt", 0).lt("reindexStartedAt", cutoff))
    .take(25);
  for (const f of stalled) {
    // Bump the generation so the stalled worker's late answer is ignored.
    await ctx.db.patch(f._id, { generation: (f.generation ?? 1) + 1 });
    await endReindex(ctx, f, "Re-index timed out");
  }
  return stalled.length;
}

function aiConfig(): { base: string; key: string } | null {
  const base = process.env.AI_BASE_URL;
  const key = process.env.AI_SERVICE_KEY;
  return base && key ? { base: base.replace(/\/$/, ""), key } : null;
}

/** Hourly: ask Python which ingests are stale for the CURRENT model/pipeline. */
export const reindexStale = internalAction({
  args: {},
  handler: async (ctx): Promise<{ started: number; deferred?: boolean }> => {
    const cfg = aiConfig();
    if (!cfg) return { started: 0 };
    let body: { ids?: unknown } | null = null;
    try {
      const res = await fetch(`${cfg.base}/v1/ingest/stale?limit=50`, {
        headers: { "x-service-key": cfg.key },
      });
      if (!res.ok) {
        logEvent("LIB_REINDEX_SCAN_FAIL", { status: res.status });
        return { started: 0 };
      }
      body = (await res.json()) as { ids?: unknown };
    } catch {
      logEvent("LIB_REINDEX_SCAN_FAIL", { status: 0 });
      return { started: 0 };
    }
    const ids = Array.isArray(body?.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
    if (ids.length === 0) return { started: 0 };
    const r: { started: number; deferred: boolean } = await ctx.runMutation(internal.libraryProcessing.startReindex, { ingestIds: ids });
    logEvent("LIB_REINDEX_SCAN", { stale: ids.length, started: r.started });
    return r;
  },
});

// ------------------------------------------------------------ reconcile

/** Which of these ingest ids does NO Convex file own? (Python rows to purge.) */
export const unknownIngestIds = internalQuery({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const unknown: string[] = [];
    for (const id of ids.slice(0, 500)) {
      const f = await ctx.db
        .query("userFiles")
        .withIndex("by_ingestId", (q) => q.eq("ingestId", id))
        .first();
      if (!f) unknown.push(id);
    }
    return unknown;
  },
});

export const schedulePurges = internalMutation({
  args: { ingestIds: v.array(v.string()) },
  handler: async (ctx, { ingestIds }) => {
    for (const ingestId of ingestIds) {
      await ctx.scheduler.runAfter(0, internal.userFiles.purge, { ingestId });
    }
  },
});

/** Past this many orphans in ONE run the reconcile stops: that many at once
 *  means Convex's view is wrong (a restore, a bad deploy), not garbage. */
const RECONCILE_MAX_PURGES = 200;
const RECONCILE_MAX_PAGES = 50;

/**
 * CROSS-PLANE RECONCILE (crons.ts, daily). The purge is retried for a week
 * (userFiles.purge), but a purge that exhausts, a purge lost with a scheduler
 * restore, or a Python row written by a worker that outlived its file would
 * otherwise be retained silently. This walks Python's file ids and purges
 * every one no Convex file owns. Tombstoned ids are already excluded by Python.
 */
export const reconcileKnowledge = internalAction({
  args: {},
  handler: async (ctx): Promise<{ scanned: number; orphans: number; stopped: boolean }> => {
    const cfg = aiConfig();
    if (!cfg) return { scanned: 0, orphans: 0, stopped: false };
    let after = "";
    let scanned = 0;
    const orphans: string[] = [];
    for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
      let body: { ids?: unknown; next?: unknown } | null = null;
      try {
        const res = await fetch(
          `${cfg.base}/v1/ingest/known?limit=500&after=${encodeURIComponent(after)}`,
          { headers: { "x-service-key": cfg.key } },
        );
        if (!res.ok) {
          logEvent("LIB_RECONCILE_FAIL", { status: res.status });
          return { scanned, orphans: orphans.length, stopped: true };
        }
        body = (await res.json()) as { ids?: unknown; next?: unknown };
      } catch {
        logEvent("LIB_RECONCILE_FAIL", { status: 0 });
        return { scanned, orphans: orphans.length, stopped: true };
      }
      const ids = Array.isArray(body?.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
      scanned += ids.length;
      if (ids.length > 0) {
        orphans.push(...(await ctx.runQuery(internal.libraryProcessing.unknownIngestIds, { ids })));
      }
      if (orphans.length > RECONCILE_MAX_PURGES) {
        logEvent("LIB_RECONCILE_STOPPED", { scanned, orphans: orphans.length });
        return { scanned, orphans: orphans.length, stopped: true };
      }
      if (typeof body?.next !== "string" || !body.next) break;
      after = body.next;
    }
    if (orphans.length > 0) {
      await ctx.runMutation(internal.libraryProcessing.schedulePurges, { ingestIds: orphans });
    }
    logEvent("LIB_RECONCILE", { scanned, orphans: orphans.length });
    return { scanned, orphans: orphans.length, stopped: false };
  },
});

// ------------------------------------------------------------ health

const HOUR = 60 * 60_000;

/**
 * The monitor's snapshot (http.ts /ops/library-health). Counts only — never a
 * name, a user's content or an id beyond counts.
 */
export const healthSnapshot = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const count = async (status: "processing" | "ready" | "failed" | "stored") =>
      (
        await ctx.db
          .query("userFiles")
          .withIndex("by_status_updated", (q) => q.eq("status", status))
          .take(20_000)
      ).length;
    const failed = await ctx.db
      .query("userFiles")
      .withIndex("by_status_updated", (q) => q.eq("status", "failed"))
      .take(20_000);
    const oldestProcessing = await ctx.db
      .query("userFiles")
      .withIndex("by_status_updated", (q) => q.eq("status", "processing"))
      .first();
    const reindexing = await ctx.db
      .query("userFiles")
      .withIndex("by_reindex_started", (q) => q.gt("reindexStartedAt", 0))
      .take(5_000);
    const usage = await ctx.db.query("storageUsage").take(10_000);
    const generatedBytes = usage.filter((u) => u.key.startsWith("gen:")).reduce((s, u) => s + u.usedBytes, 0);
    const usersOverGenerated = usage.filter((u) => u.key.startsWith("gen:") && u.usedBytes >= GENERATED_LIVE_BYTES * 0.9).length;
    return {
      at: now,
      files: {
        processing: await count("processing"),
        ready: await count("ready"),
        stored: await count("stored"),
        failed: failed.length,
      },
      failedLastHour: failed.filter((f) => f.updatedAt > now - HOUR).length,
      failedLastDay: failed.filter((f) => f.updatedAt > now - 24 * HOUR).length,
      deadLettered: failed.filter((f) => f.deadLetteredAt !== undefined).length,
      retryScheduled: failed.filter((f) => f.nextRetryAt !== undefined).length,
      retryOverdue: failed.filter((f) => f.nextRetryAt !== undefined && f.nextRetryAt < now - 30 * 60_000).length,
      oldestProcessingAgeMs: oldestProcessing ? now - oldestProcessing.updatedAt : 0,
      reindexing: reindexing.length,
      uploadBytes: await usedBytes(ctx, GLOBAL_KEY),
      uploadCeilingBytes: GLOBAL_CEILING_BYTES,
      generatedBytes,
      usersNearGeneratedCap: usersOverGenerated,
    };
  },
});
