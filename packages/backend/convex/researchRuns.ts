import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { audit } from "./auditLog";

/** Cascade helper — delete every research run for a user (called from account deletion). */
export async function deleteResearchRunsForUser(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const rows = await ctx.db
    .query("researchRuns")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}

/** Cascade helper — delete every research run for a thread (called from thread purge). */
export async function deleteResearchRunsForThread(
  ctx: MutationCtx,
  threadId: Id<"chatThreads">,
): Promise<void> {
  const rows = await ctx.db
    .query("researchRuns")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}

/**
 * Deep Research — the durable, owner-scoped, RESUMABLE research state.
 *
 * `checkpoint` is the ONLY writer, called from http.ts (op:"research-checkpoint",
 * ingress-secret-verified) when the agent's reserved `record_research` tool fires.
 * Owner/workspace/thread ids are DERIVED from the stream (never client-sent), exactly
 * like seoMutations/chat executions. Idempotent by researchRunId (upsert in place — a
 * resume never duplicates a row). A runId is bound to its thread (cross-thread reuse is
 * rejected). plan/evidence are bounded JSON strings. Reads are user-trust owner-scoped
 * (`loadActiveResearchRun` for the dispatch resume seed; the raw run is never exposed).
 */

const MAX_JSON = 24_000; // defensive ceiling per bounded-JSON blob
const MAX_FINDINGS = 300; // hard cap on the accumulated evidence array

function bound(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s.length > MAX_JSON ? `${s.slice(0, MAX_JSON)}…(truncated)` : s;
}

function loadStream(
  ctx: MutationCtx,
  streamId: string,
): Promise<Doc<"chatStreams"> | null> {
  return ctx.db
    .query("chatStreams")
    .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
    .unique();
}

type Finding = {
  subquestion?: string;
  claim?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  sourceType?: string;
  sourceDate?: string;
  retrievedDate?: string;
  confidence?: string;
  supports?: boolean;
};

function parseFindings(s: string | undefined): Finding[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as Finding[]) : [];
  } catch {
    return [];
  }
}

/**
 * Ingress op:"research-checkpoint": persist ONE unit of research state (plan / finding /
 * complete). Idempotent by researchRunId — upsert in place, never a duplicate row. Owner
 * DERIVED from the stream; a dead/unknown stream is rejected; a runId already bound to a
 * DIFFERENT thread is rejected (no cross-thread reuse). `payloadJson` is a bounded JSON
 * string (the http edge stringifies + caps it), parsed defensively per kind.
 */
export const checkpoint = internalMutation({
  args: {
    streamId: v.string(),
    researchRunId: v.string(),
    kind: v.union(
      v.literal("plan"),
      v.literal("finding"),
      v.literal("complete"),
    ),
    payloadJson: v.string(),
  },
  handler: async (ctx, a) => {
    const stream = await loadStream(ctx, a.streamId);
    if (!stream) return { ok: false, cancel: true, unknown: true };
    // Terminal guard: the streamId survives finalize + is client-known, so a
    // stale/replayed id must not write outside a live turn.
    if (
      stream.status === "done" ||
      stream.status === "error" ||
      stream.status === "aborted"
    ) {
      return { ok: true, dropped: "terminal", cancel: true };
    }

    let payload: Record<string, unknown> = {};
    try {
      const p = JSON.parse(a.payloadJson);
      if (p && typeof p === "object") payload = p as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const str = (x: unknown, cap: number) =>
      typeof x === "string" ? x.slice(0, cap) : undefined;

    const existing = await ctx.db
      .query("researchRuns")
      .withIndex("by_run", (q) => q.eq("researchRunId", a.researchRunId))
      .unique();
    // A runId is bound to its thread — never let a replayed/forged id touch another.
    if (existing && existing.threadId !== stream.threadId) {
      return { ok: true, rejected: "cross_thread" };
    }

    const now = Date.now();
    // Fields we set/merge for this checkpoint kind.
    const patch: Partial<Doc<"researchRuns">> = { updatedAt: now };

    if (a.kind === "plan") {
      const subs = Array.isArray(payload.subquestions)
        ? (payload.subquestions as unknown[])
            .filter((s): s is string => typeof s === "string")
            .slice(0, 32)
        : [];
      patch.objective =
        str(payload.objective, 600) ?? existing?.objective ?? "";
      patch.reason = bound(str(payload.reason, 300));
      patch.timeSensitive = !!payload.timeSensitive;
      patch.plan = bound(JSON.stringify(subs));
      patch.status = "researching";
    } else if (a.kind === "finding") {
      const findings = parseFindings(existing?.evidence);
      findings.push({
        subquestion: str(payload.subquestion, 200),
        claim: str(payload.claim, 600),
        sourceUrl: str(payload.sourceUrl, 2000),
        sourceTitle: str(payload.sourceTitle, 200),
        sourceType: str(payload.sourceType, 200),
        sourceDate: str(payload.sourceDate, 200),
        retrievedDate: str(payload.retrievedDate, 200),
        confidence: str(payload.confidence, 20),
        supports: payload.supports !== false,
      });
      const trimmed = findings.slice(-MAX_FINDINGS);
      const distinct = new Set(
        trimmed.map((f) => f.sourceUrl).filter((u): u is string => !!u),
      );
      patch.evidence = bound(JSON.stringify(trimmed));
      patch.sourceCount = distinct.size;
      if (existing?.status !== "complete") patch.status = "researching";
    } else {
      // complete
      patch.status = "complete";
    }

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      // Owner + context DERIVED from the stream — never client-sent.
      await ctx.db.insert("researchRuns", {
        researchRunId: a.researchRunId,
        userId: stream.userId,
        workspaceId: stream.workspaceId,
        threadId: stream.threadId,
        streamId: a.streamId,
        messageId: stream.messageId,
        objective: patch.objective ?? "",
        reason: patch.reason,
        status: patch.status ?? "researching",
        timeSensitive: patch.timeSensitive ?? false,
        plan: patch.plan,
        evidence: patch.evidence,
        sourceCount: patch.sourceCount ?? 0,
        createdAt: now,
        updatedAt: now,
      });
    }
    // Audit carries only the safe shape (kind + source count) — never claims/reason.
    await audit(ctx, stream.workspaceId, stream.userId, "research.checkpoint", {
      kind: a.kind,
      runId: a.researchRunId,
      sourceCount: patch.sourceCount ?? existing?.sourceCount ?? 0,
    });
    return { ok: true, saved: true, cancel: stream.cancelRequested };
  },
});

/**
 * The COMPACT resume seed for a thread's incomplete research run, read owner-scoped
 * for the dispatch payload. Returns the newest run whose status is not terminal, as a
 * small shape (completed sub-questions + key findings, NOT raw evidence). `userId` is
 * the owner boundary — a run belonging to another user is never returned. Plain helper
 * (not an internalQuery): its only caller is stream.dispatchPayload.
 */
export async function loadActiveResearchRun(
  ctx: QueryCtx,
  threadId: Id<"chatThreads">,
  userId: Id<"users">,
) {
  const runs = await ctx.db
    .query("researchRuns")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  const active = runs
    .filter(
      (r) =>
        r.userId === userId && // owner boundary
        (r.status === "planning" ||
          r.status === "researching" ||
          r.status === "synthesizing"),
    )
    .sort((x, y) => y.updatedAt - x.updatedAt)[0];
  if (!active) return null;

  let subquestions: string[] = [];
  try {
    const p = JSON.parse(active.plan ?? "[]");
    if (Array.isArray(p))
      subquestions = p.filter((s): s is string => typeof s === "string");
  } catch {
    subquestions = [];
  }
  const findings = parseFindings(active.evidence);
  // A sub-question is "completed" once it has at least one finding.
  const completed = Array.from(
    new Set(
      findings.map((f) => f.subquestion).filter((s): s is string => !!s),
    ),
  );
  return {
    runId: active.researchRunId,
    objective: active.objective,
    status: active.status,
    timeSensitive: active.timeSensitive,
    subquestions: subquestions.slice(0, 32),
    completed: completed.slice(0, 32),
    // Compact findings only (claim + provenance, no raw source text), bounded.
    findings: findings.slice(0, 60).map((f) => ({
      subquestion: f.subquestion ?? "",
      claim: f.claim ?? "",
      sourceUrl: f.sourceUrl ?? "",
      sourceTitle: f.sourceTitle ?? "",
      sourceDate: f.sourceDate ?? "",
      confidence: f.confidence ?? "",
    })),
    sourceCount: active.sourceCount,
  };
}
