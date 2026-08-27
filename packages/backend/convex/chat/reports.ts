import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation, query } from "../_generated/server";

/**
 * Phase 3 — a persisted, secure SEO audit REPORT.
 *
 * The Python plane stores the report envelope via /ai/ingress `op:"report"`
 * (http.ts), which calls `upsertReport` with the streamId; the owner is DERIVED from
 * the stream here and never trusted from Python. The row is the reactive source for
 * the rich report card; its `manifest` references the downloadable `chatArtifacts`
 * (md/json/pdf), whose bytes are minted by the existing ownership-checked
 * `mintDownload`. Idempotent by (sourceRunId, reportId) so a crash-resume re-emit is
 * a no-op. `getReport` is OWNERSHIP-ENFORCED (getAuthUserId === userId), returning
 * the parsed report + manifest but NEVER a storageId. Same "Not found" for missing
 * or not-owned — no existence oracle.
 */

const MAX_REPORT_BYTES = 700_000; // well short of the ~1 MiB Convex document cap
const DELETE_BATCH = 100;

async function loadStream(
  ctx: MutationCtx,
  streamId: string,
): Promise<Doc<"chatStreams"> | null> {
  return await ctx.db
    .query("chatStreams")
    .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
    .unique();
}

const summaryValidator = v.object({
  totalFindings: v.number(),
  passed: v.number(),
  failed: v.number(),
  warnings: v.number(),
  notTested: v.number(),
});

const manifestValidator = v.array(
  v.object({
    artifactId: v.string(),
    format: v.string(),
    mime: v.string(),
    size: v.number(),
    sha256: v.string(),
  }),
);

/** Called ONLY from /ai/ingress `op:"report"` (ingress-secret verified). Owner ids
 *  come from the stream, never the caller. Idempotent by (sourceRunId, reportId). */
export const upsertReport = internalMutation({
  args: {
    streamId: v.string(),
    reportId: v.string(),
    status: v.string(),
    target: v.string(),
    scope: v.string(),
    methodologyName: v.string(),
    methodologyVersion: v.string(),
    generatedAt: v.string(),
    summary: summaryValidator,
    report: v.string(),
    manifest: manifestValidator,
  },
  handler: async (ctx, a) => {
    if (a.report.length > MAX_REPORT_BYTES) {
      // The bounded row overflowed; refuse rather than store a giant doc. The full
      // report still lives in the JSON artifact (referenced by the manifest).
      return { ok: false as const, reason: "report too large" };
    }
    const stream = await loadStream(ctx, a.streamId);
    if (!stream) return { unknown: true as const };

    const fields = {
      status: a.status,
      target: a.target,
      scope: a.scope,
      methodologyName: a.methodologyName,
      methodologyVersion: a.methodologyVersion,
      generatedAt: a.generatedAt,
      summary: a.summary,
      report: a.report,
      manifest: a.manifest,
    };

    const existing = await ctx.db
      .query("seoReports")
      .withIndex("by_report", (q) =>
        q.eq("sourceRunId", a.streamId).eq("reportId", a.reportId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, fields); // resume re-emit ⇒ replace, no dup
      return { ok: true as const, reportId: a.reportId };
    }
    await ctx.db.insert("seoReports", {
      sourceRunId: a.streamId,
      reportId: a.reportId,
      inReplyToMessageId: stream.messageId,
      threadId: stream.threadId,
      workspaceId: stream.workspaceId,
      userId: stream.userId,
      createdAt: Date.now(),
      ...fields,
    });
    return { ok: true as const, reportId: a.reportId };
  },
});

/**
 * AUTHENTICATED, ownership-enforced. Returns the parsed report + download manifest
 * for a report the caller OWNS. Every non-owner (and every missing id) gets the same
 * "Not found" — no existence oracle. storageId never leaves the server (the manifest
 * carries only artifactIds, which `mintDownload` re-checks on click).
 */
export const getReport = query({
  // v.string() + normalizeId is unnecessary here (reportId is our own app id, not a
  // Convex _id) — a bad reportId simply matches nothing ⇒ "Not found".
  args: { reportId: v.string() },
  handler: async (ctx, { reportId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");
    const row = await ctx.db
      .query("seoReports")
      .withIndex("by_report_id", (q) => q.eq("reportId", reportId))
      .first();
    if (!row || row.userId !== userId) throw new ConvexError("Not found");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(row.report);
    } catch {
      parsed = null;
    }
    return {
      reportId: row.reportId,
      status: row.status,
      target: row.target,
      scope: row.scope,
      methodologyName: row.methodologyName,
      methodologyVersion: row.methodologyVersion,
      generatedAt: row.generatedAt,
      summary: row.summary,
      manifest: row.manifest, // artifactIds only — safe to expose
      report: parsed, // the parsed envelope (findings/evidence/…)
    };
  },
});

/** Delete every report row for a thread. Called from the thread-purge loop
 *  (threads.ts) alongside the inline chatArtifacts reclamation. The report's
 *  downloadable blobs are chatArtifacts, purged there — reports carry no blob. */
export async function deleteReportsForThread(
  ctx: MutationCtx,
  threadId: Id<"chatThreads">,
): Promise<void> {
  const rows = await ctx.db
    .query("seoReports")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .take(DELETE_BATCH);
  for (const r of rows) await ctx.db.delete(r._id);
}

/** Delete report rows tied to a specific (assistant) message — the regenerate/edit
 *  tail-purge path (messages.ts deleteFromSeq). */
export async function deleteReportsForMessage(
  ctx: MutationCtx,
  messageId: Id<"chatMessages">,
): Promise<void> {
  const rows = await ctx.db
    .query("seoReports")
    .withIndex("by_message", (q) => q.eq("inReplyToMessageId", messageId))
    .take(DELETE_BATCH);
  for (const r of rows) await ctx.db.delete(r._id);
}
