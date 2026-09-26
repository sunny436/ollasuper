import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { audit } from "./auditLog";
import {
  getUserIdOrNull,
  requireThreadAccess,
  requireUserId,
} from "./chat/authz";
import { hasWorkspaceAccess, requireMember } from "./orgs";
import { cancelOpenForTask, holdOpenForTask } from "./scheduled/occurrences";

/**
 * Projects — a first-class container for conversations.
 *
 * TRUST MODEL. A Project follows the CHAT model, not the workspace model: it is
 * private to the user who created it, and the workspace is only the
 * tenancy/billing boundary. That is deliberate — chats are already user-private
 * (see chat/authz.ts), so a workspace-shared Project would silently widen the
 * visibility of every conversation placed inside it.
 *
 * Phase 1 scope: identity, authorization, lifecycle and the Project↔chat link.
 * No RAG, no memory, no instruction injection, no scheduling. `instructions` is
 * stored and editable here but is not read by any prompt path yet.
 */

const EMPTY_PAGE = { page: [], isDone: true, continueCursor: "" };

const MAX_NAME = 200;
const MAX_INSTRUCTIONS = 8000;

/** Mirrors threads.cleanTitle: collapse whitespace, bound length, reject empty. */
function cleanName(raw: string): string {
  const n = raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  if (!n) throw new ConvexError("Project name cannot be empty");
  return n;
}

/**
 * The ONE Project authorization helper. Every Project read and write goes
 * through it, so there is a single place where ownership is decided.
 *
 * Ownership is checked BEFORE workspace membership, exactly as
 * requireThreadAccess does, and EVERY non-owner gets "Not found" — a
 * same-workspace peer and a complete outsider alike — so the error is never an
 * existence oracle for someone else's projectId.
 *
 * The requireMember call is therefore unreachable for outsiders; it exists to
 * catch the OWNER who has since been removed from the workspace, and only ever
 * throws "Forbidden" for that case.
 *
 * Lifecycle is deliberately NOT filtered here: an archived Project must stay
 * readable so it can be listed, opened and unarchived. Callers that require an
 * ACTIVE Project (only thread creation, in Phase 1) assert that themselves.
 */
export async function requireProjectAccess(
  ctx: QueryCtx,
  userId: Id<"users">,
  projectId: Id<"projects">,
): Promise<Doc<"projects">> {
  const project = await ctx.db.get(projectId);
  if (!project || project.userId !== userId) {
    throw new ConvexError("Not found");
  }
  await requireMember(ctx, userId, project.workspaceId);
  return project;
}

/**
 * Resolve a projectId that arrived as a RAW STRING from a URL or query param.
 *
 * It must not reach a v.id() validator: a typo'd id throws
 * ArgumentValidationError, which the Convex client logs via console.error,
 * which fails every e2e script's zero-console-error assertion. normalizeId
 * returns null instead, and null collapses into the same "Not found" that every
 * other failure produces.
 */
export async function requireProjectAccessByString(
  ctx: QueryCtx,
  userId: Id<"users">,
  raw: string,
): Promise<Doc<"projects">> {
  const id = ctx.db.normalizeId("projects", raw);
  if (!id) throw new ConvexError("Not found");
  return requireProjectAccess(ctx, userId, id);
}

/** Shape returned to the client. Never spreads the document. */
function toProject(p: Doc<"projects">) {
  return {
    _id: p._id,
    name: p.name,
    status: p.status,
    workspaceId: p.workspaceId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
    instructions: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, args.workspaceId);

    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      workspaceId: args.workspaceId,
      // Ownership is ALWAYS the authenticated caller. There is no owner
      // argument, so no caller can create a Project belonging to someone else.
      userId,
      name: cleanName(args.name),
      ...(args.instructions
        ? { instructions: args.instructions.slice(0, MAX_INSTRUCTIONS) }
        : {}),
      // Lifecycle is never client-supplied.
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await audit(ctx, args.workspaceId, userId, "project.create", { projectId });
    return projectId;
  },
});

/**
 * projectId arrives as a raw string from the URL — v.string() + normalizeId,
 * never v.id(). Returns null rather than throwing so a bad or foreign id
 * renders a friendly empty state instead of a console error.
 */
export const get = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const uid = await getUserIdOrNull(ctx);
    if (!uid) return null;
    const id = ctx.db.normalizeId("projects", projectId);
    if (!id) return null;
    const project = await ctx.db.get(id);
    // "Not found" and "not yours" are the same observable outcome.
    if (!project || project.userId !== uid) return null;
    await requireMember(ctx, uid, project.workspaceId);
    return { ...toProject(project), instructions: project.instructions ?? null };
  },
});

export const list = query({
  args: {
    workspaceId: v.id("workspaces"),
    status: v.optional(
      v.union(
        v.literal("active"),
        v.literal("archived"),
        v.literal("trashed"),
      ),
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const uid = await getUserIdOrNull(ctx);
    if (!uid) return EMPTY_PAGE;
    await requireMember(ctx, uid, args.workspaceId);
    const status = args.status ?? "active";
    const res = await ctx.db
      .query("projects")
      .withIndex("by_user_ws_status_updated", (q) =>
        q
          .eq("userId", uid)
          .eq("workspaceId", args.workspaceId)
          .eq("status", status),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...res, page: res.page.map(toProject) };
  },
});

export const rename = mutation({
  args: { projectId: v.id("projects"), name: v.string() },
  handler: async (ctx, { projectId, name }) => {
    const userId = await requireUserId(ctx);
    const project = await requireProjectAccess(ctx, userId, projectId);
    await ctx.db.patch(projectId, {
      name: cleanName(name),
      updatedAt: Date.now(),
    });
    await audit(ctx, project.workspaceId, userId, "project.rename", {
      projectId,
    });
  },
});

/**
 * Stored only. Nothing reads this until Phase 5 wires instruction precedence,
 * which is why the Phase 1 UI does not expose it.
 */
export const setInstructions = mutation({
  args: {
    projectId: v.id("projects"),
    instructions: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { projectId, instructions }) => {
    const userId = await requireUserId(ctx);
    await requireProjectAccess(ctx, userId, projectId);
    await ctx.db.patch(projectId, {
      instructions: instructions?.slice(0, MAX_INSTRUCTIONS) ?? undefined,
      updatedAt: Date.now(),
    });
  },
});

/**
 * The ONLY lifecycle transition in Phase 1, and it is reversible both ways.
 *
 * There is deliberately no delete/trash: destroying a Project raises the
 * cross-resource question "what happens to its chats?", and that state machine
 * belongs to Phase 6. Shipping a delete button whose cascade is unfinished
 * would be worse than shipping none.
 */
export const archive = mutation({
  args: { projectId: v.id("projects"), archived: v.boolean() },
  handler: async (ctx, { projectId, archived }) => {
    const userId = await requireUserId(ctx);
    const project = await requireProjectAccess(ctx, userId, projectId);
    // A trashed Project is not archivable, and — more importantly —
    // archive(false) must not be an undocumented restore. Without this it would
    // set status back to "active" while leaving trashedAt set, producing a row
    // the purge cron still believes is deleted.
    if (project.status === "trashed") {
      throw new ConvexError("This project is deleted");
    }
    await ctx.db.patch(projectId, {
      status: archived ? "archived" : "active",
      updatedAt: Date.now(),
    });
    await audit(
      ctx,
      project.workspaceId,
      userId,
      archived ? "project.archive" : "project.unarchive",
      { projectId },
    );
  },
});

/**
 * The chats inside a Project. Server-side, paginated and indexed — never
 * "fetch every chat and filter in React".
 *
 * Note what this does NOT take: a workspaceId. It is derived from the
 * authorized Project row, which removes an attacker-controlled input and makes
 * a Project/workspace mismatch unrepresentable rather than something to
 * validate.
 *
 * `status` is pinned on the index, so a hidden status="scheduled" thread can
 * never appear here as a conversation.
 */
export const listThreads = query({
  args: {
    projectId: v.string(),
    status: v.optional(v.union(v.literal("active"), v.literal("archived"))),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const uid = await getUserIdOrNull(ctx);
    if (!uid) return EMPTY_PAGE;
    const id = ctx.db.normalizeId("projects", args.projectId);
    if (!id) return EMPTY_PAGE;
    const project = await ctx.db.get(id);
    if (!project || project.userId !== uid) return EMPTY_PAGE;
    await requireMember(ctx, uid, project.workspaceId);

    const status = args.status ?? "active";
    const res = await ctx.db
      .query("chatThreads")
      .withIndex("by_user_ws_project_status_updated", (q) =>
        q
          .eq("userId", uid)
          .eq("workspaceId", project.workspaceId)
          .eq("projectId", project._id)
          .eq("status", status),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...res,
      page: res.page.map((t) => ({
        _id: t._id,
        title: t.title,
        pinned: t.pinned,
        status: t.status,
        model: t.model,
        messageCount: t.messageCount,
        lastMessageAt: t.lastMessageAt,
        updatedAt: t.updatedAt,
        isStreaming: t.streamingMessageId !== undefined,
      })),
    };
  },
});

/**
 * Move a chat into a Project, between Projects, or out of one entirely.
 *
 * ONE mutation covers all three transitions, because they are the same
 * operation with a different target and must not drift apart. `projectId: null`
 * means "remove from its Project"; the chat stays a perfectly ordinary chat.
 *
 * It rewrites the RELATIONSHIP AND NOTHING ELSE. Same thread _id, same
 * messages, attachments, artifacts, summary, model and nextSeq — a move must
 * never be a copy, or history silently forks. One Convex mutation is one
 * transaction, so this is atomic by construction.
 *
 * Note the deliberate asymmetry: the TARGET Project is validated, the SOURCE
 * one is not. That is what lets a chat always be pulled out of a Project the
 * user has since archived — the escape hatch. An ARCHIVED thread can also be
 * moved; requireThreadAccess already refuses trashed ones.
 */
export const moveThread = mutation({
  args: {
    threadId: v.id("chatThreads"),
    projectId: v.union(v.id("projects"), v.null()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const thread = await requireThreadAccess(ctx, userId, args.threadId);

    // A scheduled task's execution thread is an internal history mechanism, not
    // a conversation. Same guard, and the same non-committal error, that
    // assertCanGenerate uses to keep interactive turns out of them.
    if (thread.status === "scheduled") throw new ConvexError("Not found");

    // Refuse mid-generation. Today the Project is not part of dispatchPayload
    // so a move would be harmless, but Phase 3 puts project-derived retrieval
    // scope INTO that payload — at which point moving mid-flight would silently
    // change what the model can see partway through its own answer. Cheaper to
    // close now than to debug later.
    if (thread.streamingMessageId) {
      throw new ConvexError("This conversation is already generating a reply");
    }

    const target = args.projectId ?? undefined;
    // Already there: return without bumping updatedAt, which would otherwise
    // jump the chat to the top of both lists for a no-op.
    if (thread.projectId === target) return;

    if (target) {
      const project = await requireProjectAccess(ctx, userId, target);
      // The same user can belong to two workspaces; a thread must never be
      // linked to a Project across that boundary.
      if (project.workspaceId !== thread.workspaceId) {
        throw new ConvexError("Not found");
      }
      // An archived Project accepts no new work, and adopting a chat is work.
      if (project.status !== "active") {
        throw new ConvexError("This project is archived or deleted");
      }
    }

    await ctx.db.patch(args.threadId, {
      projectId: target,
      updatedAt: Date.now(),
    });
    await audit(ctx, thread.workspaceId, userId, "chat.thread.move", {
      threadId: args.threadId,
      projectId: target ?? null,
    });
  },
});

// ---------------------------------------------------------------- files
//
// Project membership for knowledge-base files.
//
// TWO boundaries are checked on every one of these, never one: the Project must
// be the caller's (requireProjectAccess) AND the file must be the caller's. A
// caller who owns the Project but not the file, or the file but not the Project,
// is refused with the same "Not found" everything else here uses.

/** Owner-checked userFiles row, same non-committal error as everywhere else. */
async function requireFileAccess(
  ctx: QueryCtx,
  userId: Id<"users">,
  fileId: Id<"userFiles">,
): Promise<Doc<"userFiles">> {
  const file = await ctx.db.get(fileId);
  if (!file || file.userId !== userId) throw new ConvexError("Not found");
  await requireMember(ctx, userId, file.workspaceId);
  return file;
}

/**
 * Add a file to a Project.
 *
 * Idempotent: linking a file that is already linked returns quietly rather than
 * creating a second edge. That matters because uploads DEDUP — re-uploading a
 * file you already own returns the existing userFiles row, so "upload into this
 * Project" and "attach an existing file" converge on this same mutation.
 */
export const linkFile = mutation({
  args: { projectId: v.id("projects"), fileId: v.id("userFiles") },
  handler: async (ctx, { projectId, fileId }) => {
    const userId = await requireUserId(ctx);
    const project = await requireProjectAccess(ctx, userId, projectId);
    const file = await requireFileAccess(ctx, userId, fileId);

    // The same user can belong to two workspaces; a Project must never pull in a
    // file from a different one. Mirrors the thread/Project invariant in
    // threads.create.
    if (file.workspaceId !== project.workspaceId) {
      throw new ConvexError("Not found");
    }
    // An archived Project takes no new work, and adopting a file is work.
    if (project.status !== "active") {
      throw new ConvexError("This project is archived or deleted");
    }

    const existing = await ctx.db
      .query("projectFiles")
      .withIndex("by_project_file", (q) =>
        q.eq("projectId", projectId).eq("fileId", fileId),
      )
      .unique();
    if (existing) return;

    await ctx.db.insert("projectFiles", {
      projectId,
      fileId,
      userId,
      addedAt: Date.now(),
    });
    await audit(ctx, project.workspaceId, userId, "project.file.link", {
      projectId,
      fileId,
    });
  },
});

/**
 * Remove a file from a Project.
 *
 * Drops the EDGE only. The file, its Postgres blob and its chunks all survive —
 * dedup means the very same row may still be a member of another Project or be
 * reachable as an ordinary account file. Deleting the file itself is
 * userFiles.remove, a different and more destructive operation.
 *
 * Not gated on Project status: a file must always be removable from a Project
 * the user has since archived.
 */
export const unlinkFile = mutation({
  args: { projectId: v.id("projects"), fileId: v.id("userFiles") },
  handler: async (ctx, { projectId, fileId }) => {
    const userId = await requireUserId(ctx);
    const project = await requireProjectAccess(ctx, userId, projectId);
    const edge = await ctx.db
      .query("projectFiles")
      .withIndex("by_project_file", (q) =>
        q.eq("projectId", projectId).eq("fileId", fileId),
      )
      .unique();
    if (!edge) return;
    await ctx.db.delete(edge._id);
    await audit(ctx, project.workspaceId, userId, "project.file.unlink", {
      projectId,
      fileId,
    });
  },
});

/** The Project's sources. Server-side and paginated — never "fetch every file
 *  and filter in React". */
export const listFiles = query({
  args: { projectId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const uid = await getUserIdOrNull(ctx);
    if (!uid) return EMPTY_PAGE;
    const id = ctx.db.normalizeId("projects", args.projectId);
    if (!id) return EMPTY_PAGE;
    const project = await ctx.db.get(id);
    if (!project || project.userId !== uid) return EMPTY_PAGE;
    await requireMember(ctx, uid, project.workspaceId);

    const res = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) => q.eq("projectId", id))
      .order("desc")
      .paginate(args.paginationOpts);

    const page = [];
    for (const edge of res.page) {
      const file = await ctx.db.get(edge.fileId);
      // Re-check ownership on the file itself rather than trusting the edge.
      if (!file || file.userId !== uid) continue;
      page.push({
        _id: file._id,
        name: file.name,
        size: file.size,
        contentType: file.contentType,
        status: file.status,
        error: file.error ?? null,
        stage: file.stage ?? null,
        progress: file.progress ?? null,
        addedAt: edge.addedAt,
        // storageId and ingestId are deliberately absent: ingestId is a
        // capability and the retrieval scope, and must never reach a browser.
      });
    }
    return { ...res, page };
  },
});

/**
 * THE RETRIEVAL SCOPE. Internal-only.
 *
 * Returns the Postgres file ids (== Convex ingestIds) for this Project's READY
 * files. `ready` only, matching the account-wide gate: a file still parsing has
 * no chunks, and a failed one has nothing trustworthy.
 *
 * The caller (chat/stream.dispatchPayload) sends this straight to Python. It is
 * never returned to a browser — ingestIds are capabilities.
 */
export async function projectFileIngestIds(
  ctx: QueryCtx,
  projectId: Id<"projects">,
): Promise<string[]> {
  const edges = await ctx.db
    .query("projectFiles")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  const out: string[] = [];
  // Same current-entitlement rule as the account scope (audit F-08): a linked
  // file from a workspace its owner no longer belongs to is out of scope.
  const entitled = new Map<string, boolean>();
  for (const edge of edges) {
    const file = await ctx.db.get(edge.fileId);
    if (!file || file.status !== "ready") continue;
    let ok = entitled.get(file.workspaceId);
    if (ok === undefined) {
      ok = await hasWorkspaceAccess(ctx, file.userId, file.workspaceId);
      entitled.set(file.workspaceId, ok);
    }
    if (ok) out.push(file.ingestId);
  }
  return out;
}

/** Drop every Project edge pointing at a file being deleted. Called from
 *  userFiles.remove so a deleted file leaves no dangling association. */
export async function unlinkFileEverywhere(
  ctx: MutationCtx,
  fileId: Id<"userFiles">,
): Promise<void> {
  const edges = await ctx.db
    .query("projectFiles")
    .withIndex("by_file", (q) => q.eq("fileId", fileId))
    .collect();
  for (const e of edges) await ctx.db.delete(e._id);
}

// ---------------------------------------------------------------- memory
//
// Project memory management. The RUNTIME boundary (which memories reach the
// model, and which a turn may forget) lives in memories.ts; this is the
// user-facing surface for seeing and pruning what a Project has learned.
//
// Note the deliberate asymmetry with memories.remove/update: those check only
// userId, and that is correct — a user managing their OWN memory is legitimate
// whatever scope it sits in. The Project check here is about not letting a
// LISTING enumerate a Project the caller does not own.

/** What a Project has learned. Server-scoped; never a client-side filter. */
export const listMemories = query({
  args: { projectId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const uid = await getUserIdOrNull(ctx);
    if (!uid) return EMPTY_PAGE;
    const id = ctx.db.normalizeId("projects", args.projectId);
    if (!id) return EMPTY_PAGE;
    const project = await ctx.db.get(id);
    if (!project || project.userId !== uid) return EMPTY_PAGE;
    await requireMember(ctx, uid, project.workspaceId);

    const res = await ctx.db
      .query("userMemories")
      .withIndex("by_user_project_status", (q) =>
        q.eq("userId", uid).eq("projectId", id).eq("status", "active"),
      )
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...res,
      page: res.page.map((m) => ({
        _id: m._id,
        kind: m.kind,
        content: m.content,
        source: m.source,
        updatedAt: m.updatedAt,
      })),
    };
  },
});

// ------------------------------------------------------------- lifecycle
//
// active <-> archived -> trashed -> purged.
//
// The shape mirrors chat/threads.ts (soft status, bounded re-entrant purge, a
// TTL cron) with ONE deliberate divergence: threads.remove schedules its purge
// with runAfter(0), so a "trashed" thread is destroyed immediately and restore
// only ever wins a race. A Project waits out the TTL instead, because Delete
// here is advertised as recoverable and therefore has to actually be.

/** How long a trashed Project survives before the purge cron reclaims it. */
const PROJECT_TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Bound every cascade pass so a large Project cannot blow the transaction. */
const PURGE_BATCH = 200;

/**
 * Scheduled tasks belonging to a Project. Bounded by MAX_TASKS_PER_USER (50),
 * so a by_user scan needs no dedicated index — adding one would be speculative.
 */
async function tasksForProject(
  ctx: MutationCtx,
  userId: Id<"users">,
  projectId: Id<"projects">,
) {
  const rows = await ctx.db
    .query("scheduledTasks")
    .withIndex("by_user_updated", (q) => q.eq("userId", userId))
    .collect();
  return rows.filter((t) => t.projectId === projectId);
}

/**
 * Delete a Project (soft).
 *
 * Its chats are NOT destroyed: the purge unassigns them and they carry on as
 * ordinary conversations. Deleting a container should not delete the work done
 * inside it, and the same principle already governs unlinking a file.
 *
 * Scheduled tasks are PAUSED rather than cancelled, so work already created
 * stays durable and suppressed, and a restore is not preceded by data loss.
 */
export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const userId = await requireUserId(ctx);
    const project = await requireProjectAccess(ctx, userId, projectId);
    if (project.status === "trashed") return;

    const now = Date.now();
    await ctx.db.patch(projectId, {
      status: "trashed",
      trashedAt: now,
      updatedAt: now,
    });

    // Stop unattended work at once. Every write path already refuses a
    // non-active Project, so trashing blocks new chats, file links and tasks
    // without needing a lifecycle check inside requireProjectAccess.
    for (const task of await tasksForProject(ctx, userId, projectId)) {
      if (task.status !== "active") continue;
      await ctx.db.patch(task._id, {
        status: "paused",
        pausedAt: now,
        updatedAt: now,
      });
      await holdOpenForTask(ctx, task._id);
    }

    // NO runAfter(0, purge) — see the note above. The cron reclaims it, which
    // is what makes the 30 days real rather than decorative.
    await audit(ctx, project.workspaceId, userId, "project.delete", {
      projectId,
    });
  },
});

/**
 * Undo a delete. Tasks stay PAUSED: silently resuming unattended work the user
 * believed was gone would be a worse surprise than an explicit Resume.
 */
export const restore = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const userId = await requireUserId(ctx);
    const project = await requireProjectAccess(ctx, userId, projectId);
    if (project.status !== "trashed") return;
    await ctx.db.patch(projectId, {
      status: "active",
      trashedAt: undefined,
      updatedAt: Date.now(),
    });
    await audit(ctx, project.workspaceId, userId, "project.restore", {
      projectId,
    });
  },
});

/**
 * Reclaim a trashed Project in bounded batches, DETACHING BEFORE DESTROYING.
 *
 * The order is the contract: every dependent is detached or soft-deleted before
 * the row disappears, so a crash mid-purge can never leave a chat, edge or task
 * pointing at a Project that is gone. Re-entrant and idempotent — it reschedules
 * itself while work remains and is safe to run twice.
 */
export const purge = internalMutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const project = await ctx.db.get(projectId);
    if (!project || project.status !== "trashed") return;

    // 1. CHATS SURVIVE. Unassign rather than delete: the conversation belongs to
    //    the person who had it, not to the container it was filed under.
    const threads = await ctx.db
      .query("chatThreads")
      .withIndex("by_user_ws_project_status_updated", (q) =>
        q
          .eq("userId", project.userId)
          .eq("workspaceId", project.workspaceId)
          .eq("projectId", projectId),
      )
      .take(PURGE_BATCH);
    for (const t of threads) {
      await ctx.db.patch(t._id, { projectId: undefined });
    }
    if (threads.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.projects.purge, { projectId });
      return;
    }

    // 2. FILE EDGES ONLY. The userFiles row and its Postgres blob survive: the
    //    same physical file may be a member of another Project, and dedup means
    //    re-uploading it would return this very row.
    const edges = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .take(PURGE_BATCH);
    for (const e of edges) await ctx.db.delete(e._id);
    if (edges.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.projects.purge, { projectId });
      return;
    }

    // 3. Project memories across EVERY status. The index is prefixed on
    //    userId+projectId only, so disabled and superseded rows are reached too;
    //    an active-only sweep would strand them.
    const memories = await ctx.db
      .query("userMemories")
      .withIndex("by_user_project_status", (q) =>
        q.eq("userId", project.userId).eq("projectId", projectId),
      )
      .take(PURGE_BATCH);
    for (const m of memories) await ctx.db.delete(m._id);
    if (memories.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.projects.purge, { projectId });
      return;
    }

    // 4. Scheduled tasks are SOFT-deleted, exactly as scheduled.tasks.remove
    //    does. Hard-deleting them would break the existing invariant that
    //    occurrence history keeps resolving to a real task row and revision.
    const now = Date.now();
    for (const task of await tasksForProject(ctx, project.userId, projectId)) {
      if (task.status === "deleted") continue;
      await ctx.db.patch(task._id, {
        status: "deleted",
        terminalReason: "deleted",
        updatedAt: now,
      });
      await cancelOpenForTask(ctx, task._id, "task_deleted");
    }

    // 5. Nothing references it any more.
    await ctx.db.delete(projectId);
  },
});

/** Cron: reclaim Projects that have sat in the trash past the retention TTL. */
export const purgeTrashed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - PROJECT_TRASH_TTL_MS;
    const stale = await ctx.db
      .query("projects")
      .filter((q) =>
        q.and(
          q.eq(q.field("status"), "trashed"),
          q.lt(q.field("trashedAt"), cutoff),
        ),
      )
      .take(25);
    for (const row of stale) {
      await ctx.scheduler.runAfter(0, internal.projects.purge, {
        projectId: row._id,
      });
    }
    return stale.length;
  },
});
