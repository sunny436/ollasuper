import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import { audit } from "./auditLog";
import { getUserIdOrNull, requireUserId } from "./chat/authz";
import {
  MAX_MEMORY_CHARS,
  MEMORY_ACTIVE_CAP,
  defaultScopeForKind,
  normalizeMemory,
  scanForSecret,
  strongestSource,
} from "./memoryUtil";
import { requireMember } from "./orgs";

/**
 * Phase 6 — long-term agent memory (Convex is the source of truth).
 *
 * Trust model is CHAT's (private-per-user), not the workspace-shared plane: a
 * memory is a fact about a PERSON, so `userId` is derived from the session and a
 * non-owner always gets "Not found" (no existence oracle). `requireMember` is
 * defense-in-depth for a user removed from the workspace.
 *
 * The agent RECALLS memories via a bounded set pre-loaded into the generate
 * payload (loadMemoriesForDispatch) and WRITES via rememberFromIngress — which
 * derives ownership from the streamId capability, guards the terminal state,
 * re-checks the user's memory switch, scans for secrets, and dedups. The LLM
 * never writes a record directly.
 */

const kindValidator = v.union(
  v.literal("preference"),
  v.literal("instruction"),
  v.literal("fact"),
  v.literal("project_context"),
);

// How many active memories to pre-load per turn (bounded — memories ride in
// every /v1/generate payload).
const DISPATCH_CAP = 40;

type DispatchMemory = {
  id: Id<"userMemories">;
  kind: string;
  content: string;
  source: string;
};

/**
 * The scope-correct active memory set for a turn: user-global memories (any
 * workspace) PLUS this-workspace memories — two indexed queries merged, because
 * Convex indexes are prefix-range (no OR) and a `scope="user"` row carries the
 * workspaceId it was learned in, so a single ws-filtered query would drop it.
 * A ws-B query never returns a ws-A `scope="workspace"` memory (isolation).
 */
export async function loadMemoriesForDispatch(
  ctx: QueryCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
  projectId?: Id<"projects">,
): Promise<DispatchMemory[]> {
  const userGlobal = await ctx.db
    .query("userMemories")
    .withIndex("by_user_scope_status", (q) =>
      q.eq("userId", userId).eq("scope", "user").eq("status", "active"),
    )
    .take(DISPATCH_CAP);
  const wsScoped = await ctx.db
    .query("userMemories")
    .withIndex("by_user_ws_scope_status", (q) =>
      q
        .eq("userId", userId)
        .eq("workspaceId", workspaceId)
        .eq("scope", "workspace")
        .eq("status", "active"),
    )
    .take(DISPATCH_CAP);
  // Project memories, when this turn belongs to a Project. Absent projectId ->
  // this query never runs, so an ordinary chat can never receive Project memory
  // and its two-query behaviour is byte-identical to before Projects existed.
  const projectScoped = projectId
    ? await ctx.db
        .query("userMemories")
        .withIndex("by_user_project_status", (q) =>
          q
            .eq("userId", userId)
            .eq("projectId", projectId)
            .eq("status", "active"),
        )
        .take(DISPATCH_CAP)
    : [];

  // PRECEDENCE IS APPLIED AT THE MERGE, not left to recency.
  //
  // The cap is filled most-specific-first: project, then workspace, then
  // user-global. Concatenating all three and sorting by updatedAt would let a
  // newer user-global memory EVICT a Project's own memories from its own
  // conversation — the more memories a user accumulates elsewhere, the less of
  // its own context a Project would get.
  //
  // Ordering WITHIN each tier is still updatedAt-desc, unchanged.
  const byRecency = <T extends { updatedAt: number }>(rows: T[]) =>
    [...rows].sort((a, b) => b.updatedAt - a.updatedAt);

  return [
    ...byRecency(projectScoped),
    ...byRecency(wsScoped),
    ...byRecency(userGlobal),
  ]
    .slice(0, DISPATCH_CAP)
    .map((m) => ({
      id: m._id,
      kind: m.kind,
      content: m.content,
      source: m.source,
    }));
}

/** Client-facing projection — never leak the internal normalizedKey/subject. */
function toClient(m: Doc<"userMemories">) {
  return {
    _id: m._id,
    kind: m.kind,
    content: m.content,
    source: m.source,
    scope: m.scope,
    // Exposed so Settings -> Memories can say WHICH project a memory belongs to.
    // Without it a project-scoped memory looks identical to a global one, and a
    // user cannot tell why it is not applying everywhere.
    projectId: m.projectId ?? null,
    status: m.status,
    reason: m.reason ?? null,
    sourceThreadId: m.sourceThreadId ?? null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

// --- user-facing CRUD (management UI) -------------------------------------
export const list = query({
  args: {
    workspaceId: v.id("workspaces"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };
    await requireMember(ctx, userId, args.workspaceId);
    // The user's OWN memories across workspaces (private data); superseded
    // history is hidden. Pinned to userId so no query enumerates a tenant.
    const res = await ctx.db
      .query("userMemories")
      .withIndex("by_user_status", (q) => q.eq("userId", userId))
      .order("desc")
      .filter((q) => q.neq(q.field("status"), "superseded"))
      .paginate(args.paginationOpts);
    return { ...res, page: res.page.map(toClient) };
  },
});

async function ownedMemory(
  ctx: QueryCtx,
  userId: Id<"users">,
  memoryId: Id<"userMemories">,
): Promise<Doc<"userMemories">> {
  const m = await ctx.db.get(memoryId);
  // Same "Not found" for missing and not-yours — no existence oracle.
  if (!m || m.userId !== userId) throw new ConvexError("Not found");
  return m;
}

export const remove = mutation({
  args: { memoryId: v.id("userMemories") },
  handler: async (ctx, { memoryId }) => {
    const userId = await requireUserId(ctx);
    const m = await ownedMemory(ctx, userId, memoryId);
    await requireMember(ctx, userId, m.workspaceId);
    await ctx.db.delete(memoryId);
    await audit(ctx, m.workspaceId, userId, "memory.delete", { kind: m.kind });
    return { ok: true };
  },
});

export const update = mutation({
  args: { memoryId: v.id("userMemories"), content: v.string() },
  handler: async (ctx, { memoryId, content }) => {
    const userId = await requireUserId(ctx);
    const m = await ownedMemory(ctx, userId, memoryId);
    await requireMember(ctx, userId, m.workspaceId);
    const text = content.slice(0, MAX_MEMORY_CHARS).trim();
    if (!text) throw new ConvexError("empty");
    // A user correction is authoritative -> explicit.
    await ctx.db.patch(memoryId, {
      content: text,
      normalizedKey: normalizeMemory(text),
      source: "explicit",
      updatedAt: Date.now(),
    });
    await audit(ctx, m.workspaceId, userId, "memory.update", { kind: m.kind });
    return { ok: true };
  },
});

export const setDisabled = mutation({
  args: { memoryId: v.id("userMemories"), disabled: v.boolean() },
  handler: async (ctx, { memoryId, disabled }) => {
    const userId = await requireUserId(ctx);
    const m = await ownedMemory(ctx, userId, memoryId);
    await requireMember(ctx, userId, m.workspaceId);
    if (m.status === "superseded") return { ok: false };
    await ctx.db.patch(memoryId, {
      status: disabled ? "disabled" : "active",
      updatedAt: Date.now(),
    });
    return { ok: true };
  },
});

export const clearAll = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, workspaceId);
    let removed = 0;
    // Deletes are pinned to the session userId, so only the caller's memories
    // are ever touched. The per-user set is small (active cap + a little).
    for (;;) {
      const batch = await ctx.db
        .query("userMemories")
        .withIndex("by_user_status", (q) => q.eq("userId", userId))
        .take(200);
      if (batch.length === 0) break;
      for (const m of batch) {
        await ctx.db.delete(m._id);
        removed++;
      }
      if (batch.length < 200) break;
    }
    await audit(ctx, workspaceId, userId, "memory.clear_all", { removed });
    return { ok: true, removed };
  },
});

// --- the controlled write (Python -> /ai/ingress -> here) -----------------
export const rememberFromIngress = internalMutation({
  args: {
    streamId: v.string(),
    content: v.string(),
    kind: kindValidator,
    source: v.optional(v.union(v.literal("explicit"), v.literal("inferred"))),
    scope: v.optional(v.union(v.literal("user"), v.literal("workspace"))),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    // Ownership is the streamId capability — NEVER a client-sent userId.
    const stream = await ctx.db
      .query("chatStreams")
      .withIndex("by_streamId", (q) => q.eq("streamId", a.streamId))
      .unique();
    if (!stream) return { ok: false, cancel: true, unknown: true };
    // Terminal guard: the streamId survives finalize + is client-known, so a
    // stale/replayed id must not inject a memory outside a live turn.
    if (
      stream.status === "done" ||
      stream.status === "error" ||
      stream.status === "aborted"
    ) {
      return { ok: true, dropped: "terminal", cancel: true };
    }

    // Defense-in-depth: honor the user's memory switch server-side (a compromised
    // inference plane with the secret + a live streamId still can't write).
    const settings = await ctx.db
      .query("chatSettings")
      .withIndex("by_user_workspace", (q) =>
        q.eq("userId", stream.userId).eq("workspaceId", stream.workspaceId),
      )
      .unique();
    if (settings?.memoryEnabled === false) return { ok: true, disabled: true };

    const content = a.content.slice(0, MAX_MEMORY_CHARS).trim();
    if (!content) return { ok: true, rejected: "empty" };
    if (scanForSecret(content)) return { ok: true, rejected: "secret" };

    const source = a.source ?? "explicit";
    const normalizedKey = normalizeMemory(content);
    const now = Date.now();

    // PROJECT SCOPE IS DERIVED, NEVER DECLARED.
    //
    // If the stream's thread belongs to a Project, everything learned in that
    // conversation is the Project's. The projectId comes from the thread the
    // streamId capability resolves to — the inference plane cannot name a
    // Project, and http.ts deliberately refuses to coerce a body-supplied
    // scope:"project" for the same reason.
    //
    // This OVERRIDES defaultScopeForKind (which would send a `fact` to
    // "workspace"): inside a Project the container wins, or a fact learned about
    // one client would surface while working on another.
    const thread = await ctx.db.get(stream.threadId);
    // UNATTENDED RUNS DO NOT WRITE MEMORY. The Python runner already withholds
    // the tool, so this is defence in depth: a compromised inference plane
    // holding a live streamId still cannot persist memory from a scheduled run,
    // where nobody is present to notice.
    if (thread?.status === "scheduled") {
      return { ok: true, dropped: "unattended", cancel: stream.cancelRequested };
    }
    const projectId = thread?.projectId;
    const scope = projectId
      ? ("project" as const)
      : (a.scope ?? defaultScopeForKind(a.kind));

    // Idempotent dedup: refresh an existing active row with the same normalized
    // content rather than inserting a duplicate.
    //
    // The QUERY branches — this is the whole fix, not the index.
    // by_user_scope_key would key every Project row as
    // [userId, "project", normalizedKey], so the same sentence remembered in
    // Project A and Project B would dedup into ONE row and silently merge two
    // Projects' memories. Project-scoped dedup is per-PROJECT.
    const dupe = projectId
      ? await ctx.db
          .query("userMemories")
          .withIndex("by_user_project_key", (q) =>
            q
              .eq("userId", stream.userId)
              .eq("projectId", projectId)
              .eq("normalizedKey", normalizedKey),
          )
          .filter((q) => q.eq(q.field("status"), "active"))
          .first()
      : await ctx.db
          .query("userMemories")
          .withIndex("by_user_scope_key", (q) =>
            q
              .eq("userId", stream.userId)
              .eq("scope", scope)
              .eq("normalizedKey", normalizedKey),
          )
          .filter((q) => q.eq(q.field("status"), "active"))
          .first();
    if (dupe) {
      await ctx.db.patch(dupe._id, {
        updatedAt: now,
        source: strongestSource(dupe.source, source),
      });
      return {
        ok: true,
        deduped: true,
        id: dupe._id,
        cancel: stream.cancelRequested,
      };
    }

    // Per-user active cap: memories ride in every payload, so evict the oldest
    // active memory when at the ceiling.
    const active = await ctx.db
      .query("userMemories")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", stream.userId).eq("status", "active"),
      )
      .collect();
    if (active.length >= MEMORY_ACTIVE_CAP) {
      active.sort((x, y) => x.updatedAt - y.updatedAt);
      const evict = active.length - MEMORY_ACTIVE_CAP + 1;
      for (const row of active.slice(0, evict)) await ctx.db.delete(row._id);
    }

    const id = await ctx.db.insert("userMemories", {
      userId: stream.userId,
      workspaceId: stream.workspaceId,
      kind: a.kind,
      content,
      source,
      scope,
      ...(projectId ? { projectId } : {}),
      status: "active",
      normalizedKey,
      sourceThreadId: stream.threadId,
      sourceMessageId: stream.messageId,
      reason: a.reason,
      createdAt: now,
      updatedAt: now,
    });
    // Audit carries only kind/scope — never the memory content.
    await audit(ctx, stream.workspaceId, stream.userId, "memory.remember", {
      kind: a.kind,
      scope,
    });
    return { ok: true, id, cancel: stream.cancelRequested };
  },
});

/**
 * Phase 6 — the agent's `forget_memory` tool. DISABLES (reversible) the caller's
 * OWN active memories named by `memoryIds` (chosen by the inference plane from
 * the pre-loaded, scope-authorized pool). Ownership is the streamId capability,
 * never a client userId: an id belonging to another user — or an already
 * inactive row — is silently skipped, so a forget can never cross users or
 * hard-delete. Returns `{disabled}` so the agent reports the true count.
 */
export const forgetFromIngress = internalMutation({
  args: {
    streamId: v.string(),
    memoryIds: v.array(v.id("userMemories")),
  },
  handler: async (ctx, a) => {
    const stream = await ctx.db
      .query("chatStreams")
      .withIndex("by_streamId", (q) => q.eq("streamId", a.streamId))
      .unique();
    if (!stream) return { ok: false, cancel: true, unknown: true };
    if (
      stream.status === "done" ||
      stream.status === "error" ||
      stream.status === "aborted"
    ) {
      return { ok: true, dropped: "terminal", cancel: true };
    }

    // The Project this turn belongs to (undefined for an ordinary chat). A
    // forget may only reach memories in the SAME scope the turn runs in.
    const thread = await ctx.db.get(stream.threadId);
    // Same rule as remember: an unattended run may READ memory but never
    // destroy it. A wrong forget in a scheduled loop is unrecoverable and
    // silent.
    if (thread?.status === "scheduled") {
      return { ok: true, disabled: 0, cancel: stream.cancelRequested };
    }
    const turnProjectId = thread?.projectId;

    let disabled = 0;
    for (const id of a.memoryIds.slice(0, 25)) {
      const m = await ctx.db.get(id);
      if (!m || m.userId !== stream.userId || m.status !== "active") continue;
      // PROJECT BOUNDARY. The userId check above is NOT sufficient: one user
      // owns every one of their Projects, so a Project A turn naming a Project B
      // memory id would otherwise disable it. The ids are supposed to come from
      // the pre-loaded, scope-authorized pool — this makes that a rule rather
      // than a convention, so a model that invents or replays an id from another
      // Project is refused. An ordinary chat (undefined) can only forget
      // non-Project memories, which is the same comparison.
      if (m.projectId !== turnProjectId) continue;
      await ctx.db.patch(id, { status: "disabled", updatedAt: Date.now() });
      disabled++;
    }
    if (disabled > 0) {
      await audit(ctx, stream.workspaceId, stream.userId, "memory.forget", {
        count: disabled,
      });
    }
    return { ok: true, disabled, cancel: stream.cancelRequested };
  },
});
