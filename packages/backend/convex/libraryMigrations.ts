import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { deleteBlobIfUnreferenced } from "./blobOwnership";
import { neutralizedBlobType } from "./blobSafety";
import { bump } from "./counters";
import { fileKind, nameKeyOf, sha256Hex } from "./fileKind";
import {
  GLOBAL_KEY,
  addGeneratedToLibrary,
  createLibraryFile,
  isCharged,
  userKey,
} from "./libraryCore";

/**
 * File Library migrations — operator-run, never automatic.
 *
 * Every one is PAGED (one page per call; pass `cursor` back until `done`),
 * IDEMPOTENT (re-running a page changes nothing it already changed), DRY-RUN
 * FIRST (`dryRun` defaults to true: it reports what it would do and writes
 * nothing but its progress row), and records progress in `migrationRuns` so an
 * interrupted run resumes from its cursor. A destructive phase refuses to run
 * until its verification has recorded `verifiedAt`. Nothing here ever deletes
 * the last copy of any bytes.
 *
 *   npx convex run libraryMigrations:backfillKindSource '{"dryRun":false}'
 */

const PAGE = 100;

async function run(ctx: MutationCtx, name: string): Promise<Doc<"migrationRuns">> {
  const row = await ctx.db
    .query("migrationRuns")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  if (row) return row;
  const id = await ctx.db.insert("migrationRuns", {
    name,
    processed: 0,
    ok: 0,
    failed: 0,
    done: false,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });
  return (await ctx.db.get(id)) as Doc<"migrationRuns">;
}

async function progress(
  ctx: MutationCtx,
  r: Doc<"migrationRuns">,
  d: { processed: number; ok: number; failed: number; cursor: string; done: boolean; lastError?: string },
): Promise<void> {
  await ctx.db.patch(r._id, {
    processed: r.processed + d.processed,
    ok: r.ok + d.ok,
    failed: r.failed + d.failed,
    cursor: d.cursor,
    done: d.done,
    ...(d.lastError ? { lastError: d.lastError.slice(0, 500) } : {}),
    updatedAt: Date.now(),
  });
  console.log(JSON.stringify({ event: "LIB_MIGRATION", name: r.name, ...d, lastError: undefined }));
}

const pageArgs = {
  cursor: v.optional(v.union(v.string(), v.null())),
  dryRun: v.optional(v.boolean()),
};

// ------------------------------------------------------ kind / source / name

/** Fill kind, source, nameKey and the server sha256 on rows that predate them. */
export const backfillKindSource = internalMutation({
  args: pageArgs,
  handler: async (ctx, { cursor, dryRun }) => {
    const dry = dryRun !== false;
    const r = await run(ctx, `backfillKindSource${dry ? ":dry" : ""}`);
    const res = await ctx.db.query("userFiles").paginate({ numItems: PAGE, cursor: cursor ?? null });
    let changed = 0;
    for (const f of res.page) {
      if (f.kind && f.source && f.nameKey && (f.sha256 || !f.storageId)) continue;
      changed++;
      if (dry) continue;
      const meta = f.storageId ? await ctx.db.system.get(f.storageId) : null;
      await ctx.db.patch(f._id, {
        kind: f.kind ?? fileKind(f.name, f.contentType),
        source: f.source ?? "uploaded",
        nameKey: f.nameKey ?? nameKeyOf(f.name),
        ...(meta?.sha256 && !f.sha256 ? { sha256: sha256Hex(meta.sha256) } : {}),
      });
    }
    await progress(ctx, r, { processed: res.page.length, ok: changed, failed: 0, cursor: res.continueCursor, done: res.isDone });
    return { dryRun: dry, scanned: res.page.length, changed, isDone: res.isDone, continueCursor: res.continueCursor };
  },
});

// ------------------------------------------------------ usage (the quota ledger)

/**
 * Re-derive the quota ledger from the rows. Sums into shadow documents
 * ("recompute:<key>") page by page, so a half-finished run never corrupts the
 * live ledger; the final page swaps them in (unless dryRun), and reports every
 * difference it corrected.
 *
 * NOT a snapshot: pages are separate transactions, so an upload or delete that
 * lands between pages can skew the result by that file. Run it in a quiet
 * window, then run it again with dryRun — zero diffs is the proof it is right.
 */
export const recomputeUsage = internalMutation({
  args: pageArgs,
  handler: async (ctx, { cursor, dryRun }) => {
    const dry = dryRun !== false;
    const r = await run(ctx, `recomputeUsage${dry ? ":dry" : ""}`);
    if (!cursor) {
      // Fresh start: clear any shadows from an abandoned run.
      for (const s of await ctx.db.query("storageUsage").take(10_000)) {
        if (s.key.startsWith("recompute:")) await ctx.db.delete(s._id);
      }
    }
    const res = await ctx.db.query("userFiles").paginate({ numItems: PAGE, cursor: cursor ?? null });
    const add = async (key: string, bytes: number) => {
      const shadow = `recompute:${key}`;
      const doc = await ctx.db
        .query("storageUsage")
        .withIndex("by_key", (q) => q.eq("key", shadow))
        .unique();
      if (doc) await ctx.db.patch(doc._id, { usedBytes: doc.usedBytes + bytes, files: doc.files + 1 });
      else await ctx.db.insert("storageUsage", { key: shadow, usedBytes: bytes, files: 1 });
    };
    for (const f of res.page) {
      // Uploads only, on both keys: generated rows add no bytes (libraryCore).
      if (!isCharged(f)) continue;
      await add(userKey(f.userId), f.size);
      await add(GLOBAL_KEY, f.size);
    }
    const diffs: { key: string; live: number; truth: number }[] = [];
    if (res.isDone) {
      const all = await ctx.db.query("storageUsage").take(10_000);
      const live = new Map(all.filter((s) => !s.key.startsWith("recompute:")).map((s) => [s.key, s]));
      const truth = all.filter((s) => s.key.startsWith("recompute:"));
      for (const t of truth) {
        const key = t.key.slice("recompute:".length);
        const l = live.get(key);
        if ((l?.usedBytes ?? 0) !== t.usedBytes || (l?.files ?? 0) !== t.files) {
          diffs.push({ key, live: l?.usedBytes ?? 0, truth: t.usedBytes });
        }
        if (!dry) {
          if (l) await ctx.db.patch(l._id, { usedBytes: t.usedBytes, files: t.files });
          else await ctx.db.insert("storageUsage", { key, usedBytes: t.usedBytes, files: t.files });
          live.delete(key);
        }
        await ctx.db.delete(t._id);
      }
      // A live key with no rows left at all is zero.
      if (!dry) {
        for (const [key, l] of live) {
          if (l.usedBytes !== 0 || l.files !== 0) diffs.push({ key, live: l.usedBytes, truth: 0 });
          await ctx.db.patch(l._id, { usedBytes: 0, files: 0 });
        }
      }
    }
    await progress(ctx, r, { processed: res.page.length, ok: res.page.length, failed: 0, cursor: res.continueCursor, done: res.isDone });
    return { dryRun: dry, scanned: res.page.length, isDone: res.isDone, continueCursor: res.continueCursor, diffs };
  },
});

// ------------------------------------------------------ legacy shared `files`

/**
 * Phase A: each legacy workspace-shared `files` row becomes a private Library
 * file of its UPLOADER, on the SAME blob (no copy). The legacy row is kept;
 * phase B removes it only after `verifyFold` has passed.
 */
export const foldSharedFiles = internalMutation({
  args: pageArgs,
  handler: async (ctx, { cursor, dryRun }) => {
    const dry = dryRun !== false;
    const r = await run(ctx, `foldSharedFiles${dry ? ":dry" : ""}`);
    const res = await ctx.db.query("files").paginate({ numItems: PAGE, cursor: cursor ?? null });
    let created = 0;
    let failed = 0;
    let lastError: string | undefined;
    for (const legacy of res.page) {
      const done = await ctx.db
        .query("userFiles")
        .withIndex("by_legacy", (q) => q.eq("legacyFileId", legacy._id))
        .first();
      if (done) continue;
      const meta = await ctx.db.system.get(legacy.storageId);
      if (!meta) {
        failed++;
        lastError = `files:${legacy._id} has no stored bytes`;
        continue;
      }
      // One Library row per blob: if these bytes already back a Library file,
      // folding would throw and abort the whole page on every retry. Record it
      // and move on; the operator decides (it is reported, never merged).
      const already = await ctx.db
        .query("userFiles")
        .withIndex("by_storage", (q) => q.eq("storageId", legacy.storageId))
        .first();
      if (already) {
        failed++;
        lastError = `files:${legacy._id} shares its bytes with userFiles:${already._id}`;
        continue;
      }
      created++;
      if (dry) continue;
      await createLibraryFile(ctx, {
        userId: legacy.userId,
        workspaceId: legacy.workspaceId,
        storageId: legacy.storageId,
        name: legacy.name,
        contentType: legacy.contentType,
        size: meta.size,
        sha256: meta.sha256,
        source: "uploaded",
        legacyFileId: legacy._id,
        createdAt: legacy.createdAt,
        forceStored: true,
      });
    }
    await progress(ctx, r, { processed: res.page.length, ok: created, failed, cursor: res.continueCursor, done: res.isDone, lastError });
    return { dryRun: dry, scanned: res.page.length, created, failed, lastError, isDone: res.isDone, continueCursor: res.continueCursor };
  },
});

/**
 * Verify phase A: every legacy row has a Library file with the same owner,
 * the same blob, the same size and the stored bytes' own sha256. Records
 * `verifiedAt` only when ALL match; otherwise lists what does not.
 */
export const verifyFold = internalMutation({
  args: {},
  handler: async (ctx) => {
    const r = await run(ctx, "foldSharedFiles");
    const legacy = await ctx.db.query("files").take(5_000);
    const problems: string[] = [];
    for (const l of legacy) {
      const f = await ctx.db
        .query("userFiles")
        .withIndex("by_legacy", (q) => q.eq("legacyFileId", l._id))
        .first();
      const meta = await ctx.db.system.get(l.storageId);
      if (!f) problems.push(`${l._id}: no Library file`);
      else if (f.userId !== l.userId) problems.push(`${l._id}: owner differs`);
      else if (f.storageId !== l.storageId) problems.push(`${l._id}: blob differs`);
      else if (!meta) problems.push(`${l._id}: bytes missing`);
      else if (f.size !== meta.size || (f.sha256 && f.sha256 !== sha256Hex(meta.sha256))) {
        problems.push(`${l._id}: size or hash differs`);
      }
    }
    if (problems.length === 0) await ctx.db.patch(r._id, { verifiedAt: Date.now() });
    return { legacyRows: legacy.length, verified: problems.length === 0, problems };
  },
});

/** Phase B: drop verified legacy rows. The blob stays — its Library file references it. */
export const cleanupFoldedFiles = internalMutation({
  args: pageArgs,
  handler: async (ctx, { cursor, dryRun }) => {
    const dry = dryRun !== false;
    const fold = await run(ctx, "foldSharedFiles");
    if (!fold.verifiedAt) {
      return { refused: "foldSharedFiles has not been verified (run verifyFold)" };
    }
    const r = await run(ctx, `cleanupFoldedFiles${dry ? ":dry" : ""}`);
    const res = await ctx.db.query("files").paginate({ numItems: PAGE, cursor: cursor ?? null });
    let removed = 0;
    for (const l of res.page) {
      const f = await ctx.db
        .query("userFiles")
        .withIndex("by_legacy", (q) => q.eq("legacyFileId", l._id))
        .first();
      // Only a row whose Library file still holds the very same bytes.
      if (!f || f.storageId !== l.storageId) continue;
      removed++;
      if (dry) continue;
      await ctx.db.delete(l._id);
      await deleteBlobIfUnreferenced(ctx, l.storageId); // no-op: still referenced
      await bump(ctx, l.workspaceId, "files", -1);
    }
    await progress(ctx, r, { processed: res.page.length, ok: removed, failed: 0, cursor: res.continueCursor, done: res.isDone });
    return { dryRun: dry, scanned: res.page.length, removed, isDone: res.isDone, continueCursor: res.continueCursor };
  },
});

// ------------------------------------------------------ generated files

/** Existing generated artifacts (not preview pages) become Library files. */
export const backfillGenerated = internalMutation({
  args: pageArgs,
  handler: async (ctx, { cursor, dryRun }) => {
    const dry = dryRun !== false;
    const r = await run(ctx, `backfillGenerated${dry ? ":dry" : ""}`);
    const res = await ctx.db.query("chatArtifacts").paginate({ numItems: PAGE, cursor: cursor ?? null });
    let created = 0;
    let skipped = 0;
    for (const a of res.page) {
      if (a.role === "preview") continue;
      const has = await ctx.db
        .query("userFiles")
        .withIndex("by_artifact", (q) => q.eq("artifactId", a._id))
        .first();
      if (has) continue;
      if (!(await ctx.db.system.get(a.storageId))) continue;
      if (dry) {
        created++;
        continue;
      }
      const id = await addGeneratedToLibrary(ctx, {
        artifactId: a._id,
        userId: a.userId,
        workspaceId: a.workspaceId,
        storageId: a.storageId,
        name: a.filename,
        contentType: a.mime,
        size: a.size,
      });
      if (id) created++;
      else skipped++;
    }
    await progress(ctx, r, { processed: res.page.length, ok: created, failed: skipped, cursor: res.continueCursor, done: res.isDone });
    return { dryRun: dry, scanned: res.page.length, created, skipped, isDone: res.isDone, continueCursor: res.continueCursor };
  },
});

// ------------------------------------------------------ restore originals

/** Ready files whose only original is Python's processing copy. */
export const blobless = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const res = await ctx.db
      .query("userFiles")
      .withIndex("by_status_updated", (q) => q.eq("status", "ready"))
      .paginate({ numItems: 25, cursor: cursor ?? null });
    return {
      page: res.page
        .filter((f) => !f.storageId)
        .map((f) => ({
          fileId: f._id,
          ingestId: f.ingestId,
          contentType: f.contentType,
          size: f.size,
          contentHash: f.contentHash ?? null,
        })),
      isDone: res.isDone,
      continueCursor: res.continueCursor,
    };
  },
});

export const storedSha256 = internalQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) =>
    sha256Hex((await ctx.db.system.get(storageId))?.sha256) ?? null,
});

/** Bind a VERIFIED restored blob to its file — only if it still lacks one. */
export const attachRestoredBlob = internalMutation({
  args: { fileId: v.id("userFiles"), storageId: v.id("_storage"), sha256: v.string() },
  handler: async (ctx, { fileId, storageId, sha256 }) => {
    const f = await ctx.db.get(fileId);
    if (!f || f.storageId) {
      // Deleted meanwhile, or restored by an overlapping run: drop the new copy.
      await deleteBlobIfUnreferenced(ctx, storageId);
      return { attached: false };
    }
    await ctx.db.patch(fileId, { storageId, sha256 });
    return { attached: true };
  },
});

export const recordRun = internalMutation({
  args: {
    name: v.string(),
    processed: v.number(),
    ok: v.number(),
    failed: v.number(),
    cursor: v.string(),
    done: v.boolean(),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const r = await run(ctx, a.name);
    await progress(ctx, r, a);
  },
});

async function hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Restore the canonical original of a ready file whose Convex blob was dropped
 * after processing (the pre-Library "staging" behaviour), from Python's copy.
 *
 * Per file: Python's recorded hash == the hash of the bytes received (== the
 * row's own recorded hash when it has one) → store → Convex's server-computed
 * sha256 of the stored blob == the same hash → only THEN bind it to the row.
 * Any mismatch is a recorded failure: nothing is bound, and Python's copy — the
 * only one — is never touched here.
 */
type RestoreResult =
  | { error: string }
  | {
      dryRun: boolean;
      restored: number;
      failed: number;
      lastError: string | undefined;
      isDone: boolean;
      continueCursor: string;
    };

type BloblessPage = {
  page: {
    fileId: string;
    ingestId: string;
    contentType: string;
    size: number;
    contentHash: string | null;
  }[];
  isDone: boolean;
  continueCursor: string;
};

export const restoreOriginals = internalAction({
  args: pageArgs,
  // Explicit: this action calls its own module's functions, and an inferred
  // return type there is a circular reference that degrades every api type.
  handler: async (ctx, { cursor, dryRun }): Promise<RestoreResult> => {
    const dry = dryRun !== false;
    const base = process.env.AI_BASE_URL;
    const key = process.env.AI_SERVICE_KEY;
    if (!base || !key) return { error: "AI_BASE_URL / AI_SERVICE_KEY not set" };
    const page: BloblessPage = await ctx.runQuery(internal.libraryMigrations.blobless, {
      cursor: cursor ?? null,
    });
    let ok = 0;
    let failed = 0;
    let lastError: string | undefined;
    for (const f of page.page) {
      try {
        const res = await fetch(`${base}/v1/files/ingest/${encodeURIComponent(f.ingestId)}/original`, {
          headers: { "x-service-key": key },
        });
        if (!res.ok) throw new Error(`python ${res.status}`);
        const declared = (res.headers.get("x-content-sha256") ?? "").toLowerCase();
        const bytes = await res.arrayBuffer();
        const got = await hex(bytes);
        if (!declared || got !== declared) throw new Error("hash mismatch (python)");
        if (f.contentHash && /^[0-9a-f]{64}$/i.test(f.contentHash) && f.contentHash.toLowerCase() !== got) {
          throw new Error("hash mismatch (row)");
        }
        if (dry) {
          ok++;
          continue;
        }
        const storageId = await ctx.storage.store(
          new Blob([bytes], { type: neutralizedBlobType(f.contentType) }),
        );
        const stored: string | null = await ctx.runQuery(internal.libraryMigrations.storedSha256, {
          storageId,
        });
        if (!stored || stored.toLowerCase() !== got) {
          await ctx.storage.delete(storageId);
          throw new Error("hash mismatch (stored)");
        }
        const bound: { attached: boolean } = await ctx.runMutation(internal.libraryMigrations.attachRestoredBlob, {
          fileId: f.fileId as Id<"userFiles">,
          storageId,
          sha256: got,
        });
        if (bound.attached) ok++;
      } catch (e) {
        failed++;
        lastError = `${f.fileId}: ${String((e as Error)?.message ?? e)}`;
      }
    }
    await ctx.runMutation(internal.libraryMigrations.recordRun, {
      name: `restoreOriginals${dry ? ":dry" : ""}`,
      processed: page.page.length,
      ok,
      failed,
      cursor: page.continueCursor,
      done: page.isDone,
      ...(lastError ? { lastError } : {}),
    });
    return { dryRun: dry, restored: ok, failed, lastError, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

// ------------------------------------------------------ reconciliation (report only)

/**
 * Metadata ↔ storage, both directions, report-only. Destructive repair stays
 * with the existing sweeps, which act only on PROVEN orphans (authDeletion).
 */
export const reconcile = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const res = await ctx.db.query("userFiles").paginate({ numItems: 200, cursor: cursor ?? null });
    const missingBlob: string[] = [];
    const awaitingRestore: string[] = [];
    const orphanGenerated: string[] = [];
    for (const f of res.page) {
      if (!f.storageId) {
        if (f.status === "ready") awaitingRestore.push(f._id);
        else missingBlob.push(f._id);
      } else if (!(await ctx.db.system.get(f.storageId))) {
        missingBlob.push(f._id);
      }
      if (f.artifactId && !(await ctx.db.get(f.artifactId))) orphanGenerated.push(f._id);
    }
    const refs = await ctx.db.query("chatAttachments").take(5_000);
    const danglingRefs: string[] = [];
    for (const a of refs) {
      if (a.userFileId && !(await ctx.db.get(a.userFileId))) danglingRefs.push(a._id);
    }
    const expiredTokens = (
      await ctx.db
        .query("fileAccessTokens")
        .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
        .take(1_000)
    ).length;
    return {
      scanned: res.page.length,
      isDone: res.isDone,
      continueCursor: res.continueCursor,
      missingBlob,
      awaitingRestore,
      orphanGenerated, // report-only: the generated file is still a valid Library file
      danglingRefs,
      expiredTokens,
    };
  },
});
