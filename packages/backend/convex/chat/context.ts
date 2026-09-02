import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";

/**
 * Conversational context — the platform layer.
 *
 * WHY THIS IS NOT IN A SKILL. Continuity was already solved here three separate
 * times, each for one skill: runner.py seeds Deep Research from
 * `activeResearchRun` so it "continues OPEN sub-questions", and Data Analysis
 * from `datasets` so "a follow-up with no new upload still analyses the same
 * data", and the capability overview from live runtime state. Each is correct.
 * None of them helps Blog, SEO, Coding, Documents, or anything added next. This
 * file is the generalisation of that proven pattern, and it reaches every skill
 * through the one seam they all already pass through — build_system_prompt.
 *
 * THE FLOOR IS DERIVED, NOT TRUSTED. Everything a reference actually resolves
 * against — the active artifact, its version, the subject, the entity
 * activation order, the version lineage — is computed here as a PURE FUNCTION of
 * rows the application already owns. It is recomputed on every dispatch rather
 * than read back from a field something else wrote. That is what makes it
 * impossible for a model that declines to call `record_context` to leave the
 * critical state missing or stale: there is no code path in which the floor is
 * whatever a model last said it was.
 *
 * The model may only ENRICH — constraints, decisions, open loops — which are the
 * things genuinely not derivable from data, and which nothing in the resolution
 * path reads.
 */

/**
 * streamId -> the turn it belongs to.
 *
 * Every ingress op is keyed on the stream, and the stream already carries both
 * the thread and the message being written — so an artifact registered from a
 * turn needs no ids from the model, which also means the model cannot register
 * an artifact against someone else's message.
 */
async function resolveStream(ctx: MutationCtx, streamId: string) {
  const stream = await ctx.db
    .query("chatStreams")
    .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
    .unique();
  if (!stream) return null;
  const message = await ctx.db.get(stream.messageId);
  if (!message || message.threadId !== stream.threadId) return null;
  return { stream, message };
}

/** How many artifacts travel in a dispatch payload. Metadata only, no content. */
const MAX_ARTIFACTS_IN_PAYLOAD = 24;
/**
 * Bound on the out-of-window artifact text carried in a payload. Generous
 * enough for a long article, bounded so a pathological artifact cannot make
 * every subsequent turn expensive; the Python side reserves tokens for it and
 * clips again against the real window.
 */
const OUT_OF_WINDOW_CHARS = 24_000;
/** Bound on the message scan used to derive entity activation. */
const ENTITY_SCAN_MESSAGES = 40;

export type ArtifactView = {
  artifactId: string;
  version: number;
  kind: string;
  subject: string;
  status: string;
  messageId: Id<"chatMessages">;
  seq: number;
  supersedesId: Id<"conversationArtifacts"> | null;
};

export type ContextView = {
  // ---- derived floor (authoritative) ----
  activeArtifactId: string | null;
  activeArtifactVersion: number | null;
  activeSubject: string | null;
  entities: { name: string; activatedAtSeq: number }[];
  artifacts: ArtifactView[];
  // ---- persisted, model-enrichable ----
  lastOperation: string | null;
  userConstraints: string[];
  userDecisions: string[];
  openLoops: string[];
  /** Set only when the active artifact fell outside the history window. */
  activeArtifactText: string | null;
};

const view = (a: Doc<"conversationArtifacts">): ArtifactView => ({
  artifactId: a.artifactId,
  version: a.version,
  kind: a.kind,
  subject: a.subject,
  status: a.status,
  messageId: a.messageId,
  seq: a.seq,
  supersedesId: a.supersedesId ?? null,
});

/**
 * Entity activation order — deliberately not "most recently mentioned".
 *
 * The multi-subject case is the one that exposes the difference. After
 * PostgreSQL → Redis → "go back to PostgreSQL", a following "compare that with
 * Redis" must bind `that` to PostgreSQL. Mention-recency binds it to Redis and
 * is wrong. So an entity is ACTIVATED when it is the subject of a new artifact
 * OR when a later user message names it, and the activation seq is what orders
 * them.
 *
 * The entity set comes from artifact subjects rather than from open-ended
 * extraction: those are the things this conversation has actually produced work
 * about, which is exactly the set a reference can point at, and it needs no
 * model to compute.
 */
async function deriveEntities(
  ctx: QueryCtx,
  threadId: Id<"chatThreads">,
  artifacts: Doc<"conversationArtifacts">[],
): Promise<{ name: string; activatedAtSeq: number }[]> {
  const activation = new Map<string, number>();
  for (const a of artifacts) {
    const prev = activation.get(a.subject) ?? -1;
    if (a.seq > prev) activation.set(a.subject, a.seq);
  }
  if (activation.size === 0) return [];

  const recent = await ctx.db
    .query("chatMessages")
    .withIndex("by_thread_seq", (q) => q.eq("threadId", threadId))
    .order("desc")
    .take(ENTITY_SCAN_MESSAGES);

  for (const m of recent) {
    // Only the USER re-activates a subject. An assistant mentioning Redis in
    // passing while working on PostgreSQL must not steal the reference.
    if (m.role !== "user") continue;
    const haystack = m.content.toLowerCase();
    for (const [name] of activation) {
      if (!name) continue;
      if (haystack.includes(name.toLowerCase())) {
        const prev = activation.get(name) ?? -1;
        if (m.seq > prev) activation.set(name, m.seq);
      }
    }
  }

  return [...activation.entries()]
    .map(([name, activatedAtSeq]) => ({ name, activatedAtSeq }))
    .sort((a, b) => b.activatedAtSeq - a.activatedAtSeq);
}

/**
 * The context a dispatch carries. Pure read; safe from any query.
 *
 * Artifacts travel as METADATA ONLY — id, version, kind, subject, and the
 * messageId their content lives in. The text is never copied: `chatMessages` is
 * append-only, so the row a version points at is already immutable, and there is
 * exactly one source of truth for it.
 */
export async function loadContext(
  ctx: QueryCtx,
  threadId: Id<"chatThreads">,
  /**
   * The message seqs the history window already carries. The active
   * artifact's TEXT is attached only when its message is NOT among them —
   * which is exactly the long-conversation case where the artifact has aged
   * out and a bare reference would otherwise resolve to nothing retrievable.
   */
  historySeqs: ReadonlySet<number> = new Set(),
): Promise<ContextView> {
  const rows = await ctx.db
    .query("conversationArtifacts")
    .withIndex("by_thread_seq", (q) => q.eq("threadId", threadId))
    .order("desc")
    .take(MAX_ARTIFACTS_IN_PAYLOAD);

  const state = await ctx.db
    .query("conversationState")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .unique();

  // The lineage HEAD is the active artifact: the newest row that nothing has
  // superseded. Derived, so a REVERT that re-activates an older version is
  // reflected without anything having to remember to update a pointer.
  const active = rows.find((a) => a.status === "active") ?? null;
  const entities = await deriveEntities(ctx, threadId, rows);

  let activeArtifactText: string | null = null;
  if (active && !historySeqs.has(active.seq)) {
    const msg = await ctx.db.get(active.messageId);
    if (msg) activeArtifactText = msg.content.slice(0, OUT_OF_WINDOW_CHARS);
  }

  return {
    activeArtifactId: active?.artifactId ?? null,
    activeArtifactVersion: active?.version ?? null,
    activeSubject: active?.subject ?? entities[0]?.name ?? null,
    entities,
    artifacts: rows.map(view),
    lastOperation: state?.lastOperation ?? null,
    userConstraints: state?.userConstraints ?? [],
    userDecisions: state?.userDecisions ?? [],
    openLoops: state?.openLoops ?? [],
    activeArtifactText,
  };
}

/**
 * Register a produced artifact, or a new version of one.
 *
 * IDEMPOTENT on (threadId, artifactId, version): a retried finalize, a duplicate
 * ingress or a crash-resume re-registration returns the existing row instead of
 * forking the lineage. Concurrency here is real — two finalizes for the same
 * turn must not be able to mint two v2s.
 */
export const registerArtifact = internalMutation({
  args: {
    streamId: v.string(),
    artifactId: v.optional(v.string()),
    kind: v.string(),
    subject: v.string(),
    /** Present when this REPLACES an existing artifact (MODIFY/REWRITE/EXTEND). */
    supersedesArtifactId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveStream(ctx, args.streamId);
    if (!resolved) return { ok: false as const };
    const { message } = resolved;
    const threadId = message.threadId;

    // A new version of an existing lineage, or a brand-new artifact.
    const lineageId = args.supersedesArtifactId ?? args.artifactId ?? null;
    let previous: Doc<"conversationArtifacts"> | null = null;
    if (lineageId) {
      const versions = await ctx.db
        .query("conversationArtifacts")
        .withIndex("by_thread_artifact", (q) =>
          q.eq("threadId", threadId).eq("artifactId", lineageId),
        )
        .order("desc")
        .take(1);
      previous = versions[0] ?? null;
    }

    const artifactId =
      lineageId ?? `art_${threadId}_${message.seq}_${args.kind}`;
    const version = (previous?.version ?? 0) + 1;

    // IDEMPOTENCY IS KEYED ON THE MESSAGE, not on (artifact, version).
    //
    // One message IS one version — messages are append-only, so a message can
    // never be a second version of anything. Keying on (artifact, version) looked
    // right and was not: a retried finalize re-derives version = head + 1, and by
    // then the head is already the row the first attempt wrote, so the retry
    // minted v3 from v2. Caught by chat.contextstate.test.ts.
    const already = await ctx.db
      .query("conversationArtifacts")
      .withIndex("by_thread_seq", (q) => q.eq("threadId", threadId))
      .collect();
    const dup = already.find((a) => a.messageId === message._id);
    if (dup) {
      return { ok: true as const, artifactId: dup.artifactId, version: dup.version };
    }

    // The previous head stops being active BEFORE the new head exists, in the
    // same transaction, so a reader can never observe two active heads.
    if (previous && previous.status === "active") {
      await ctx.db.patch(previous._id, { status: "superseded" });
    }

    await ctx.db.insert("conversationArtifacts", {
      threadId,
      userId: message.userId,
      workspaceId: message.workspaceId,
      artifactId,
      version,
      kind: args.kind,
      subject: args.subject,
      status: "active",
      messageId: message._id,
      supersedesId: previous?._id,
      seq: message.seq,
      createdAt: Date.now(),
    });
    return { ok: true as const, artifactId, version };
  },
});

/**
 * Re-activate an earlier version — REVERT.
 *
 * Walks the stored lineage rather than guessing at "the message before", which
 * is what makes "go back to the previous version" mean the previous VERSION and
 * not the previous message.
 */
export const revertArtifact = internalMutation({
  args: {
    streamId: v.string(),
    artifactId: v.string(),
    /** Absent ⇒ the version immediately before the current head. */
    toVersion: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveStream(ctx, args.streamId);
    if (!resolved) return { ok: false as const };
    const threadId = resolved.message.threadId;
    const versions = await ctx.db
      .query("conversationArtifacts")
      .withIndex("by_thread_artifact", (q) =>
        q.eq("threadId", threadId).eq("artifactId", args.artifactId),
      )
      .collect();
    if (versions.length === 0) return { ok: false as const };
    versions.sort((a, b) => a.version - b.version);

    const head = versions.find((x) => x.status === "active") ?? versions.at(-1);
    const target =
      args.toVersion !== undefined
        ? versions.find((x) => x.version === args.toVersion)
        : versions
            .filter((x) => x.version < (head?.version ?? Number.MAX_SAFE_INTEGER))
            .at(-1);
    if (!target || !head || target._id === head._id) return { ok: false as const };

    await ctx.db.patch(head._id, { status: "superseded" });
    await ctx.db.patch(target._id, { status: "active" });
    return { ok: true as const, artifactId: args.artifactId, version: target.version };
  },
});

/**
 * Persist the turn's context write.
 *
 * `operation` is FLOOR-OWNED — the classifier that produces it is deterministic
 * code, not the model's free choice — so it is always applied. The enrichment
 * fields are only written when supplied, so a model that never calls
 * `record_context` leaves the previous values standing rather than clearing
 * them, and can never blank out a constraint the user set earlier.
 *
 * `throughSeq` makes the write idempotent and monotonic: a retried or
 * out-of-order ingress for older messages cannot roll the state backwards.
 */
export const applyContextWrite = internalMutation({
  args: {
    streamId: v.string(),
    throughSeq: v.number(),
    operation: v.optional(v.string()),
    activeArtifactId: v.optional(v.string()),
    activeArtifactVersion: v.optional(v.number()),
    activeSubject: v.optional(v.string()),
    userConstraints: v.optional(v.array(v.string())),
    userDecisions: v.optional(v.array(v.string())),
    openLoops: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveStream(ctx, args.streamId);
    if (!resolved) return { ok: false as const };
    const threadId = resolved.message.threadId;
    const thread = await ctx.db.get(threadId);
    if (!thread) return { ok: false as const };

    const existing = await ctx.db
      .query("conversationState")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .unique();

    if (existing && existing.updatedThroughSeq > args.throughSeq) {
      // A newer turn already wrote. Stale state must never replace fresh state.
      return { ok: true as const, stale: true };
    }

    const patch = {
      threadId,
      userId: thread.userId,
      updatedThroughSeq: args.throughSeq,
      updatedAt: Date.now(),
      ...(args.operation !== undefined ? { lastOperation: args.operation } : {}),
      // Snapshot of the derived floor. loadContext RE-DERIVES these rather than
      // reading them back, so this is for observability and never a source of
      // truth — but it means a dump of the table explains a turn after the fact.
      ...(args.activeArtifactId !== undefined
        ? { activeArtifactId: args.activeArtifactId }
        : {}),
      ...(args.activeArtifactVersion !== undefined
        ? { activeArtifactVersion: args.activeArtifactVersion }
        : {}),
      ...(args.activeSubject !== undefined
        ? { activeSubject: args.activeSubject }
        : {}),
      ...(args.userConstraints !== undefined
        ? { userConstraints: args.userConstraints }
        : {}),
      ...(args.userDecisions !== undefined
        ? { userDecisions: args.userDecisions }
        : {}),
      ...(args.openLoops !== undefined ? { openLoops: args.openLoops } : {}),
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("conversationState", patch);
    }
    return { ok: true as const, stale: false };
  },
});
