import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  internalMutation,
  mutation,
  type MutationCtx,
  query,
} from "../_generated/server";
import { audit } from "../auditLog";
import { bump } from "../counters";
import { requireMember } from "../orgs";
import { clampText } from "./settings";
import { requireProjectAccessByString } from "../projects";
import { deleteResearchRunsForThread } from "../researchRuns";
import { deleteMutationsForThread } from "../seoMutations";
import {
  DEFAULT_MODEL,
  assertAllowedModel,
  getUserIdOrNull,
  requireThreadAccess,
  requireThreadAccessIncludingTrashed,
  requireUserId,
} from "./authz";

const EMPTY_PAGE = { page: [], isDone: true, continueCursor: "" };

/** Trash retention before a thread is hard-purged. */
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Bound every cascade batch so a big thread can't blow the transaction. */
const PURGE_BATCH = 200;

const MAX_TITLE = 200;

function cleanTitle(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  if (!t) throw new ConvexError("Title cannot be empty");
  return t;
}

/**
 * Derive a first-pass title from the opening message. The Python service
 * replaces this with a model-generated one unless the user renamed it.
 */
export function titleFromText(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "New chat";
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

/** Shape returned to the sidebar. Never leaks another user's rows. */
/**
 * A row of `list` — ONLY what its two consumers render (the rail: title, pin,
 * recency; Settings → Archived: title, recency, project).
 *
 * Deliberately NOT `toListItem`. Convex re-sends a query's whole result when
 * any of it changes, and `isStreaming`, `messageCount`, `lastMessageAt` and
 * `model` all change the moment a message is sent — so returning them made
 * every turn push the entire first page (30 rows, ~7.9 KB) at send, again at
 * finalize, for fields nothing in the list displays. The streaming dot now
 * comes from `streaming` below; `updatedAt` still changes at finalize, which
 * is a real reorder and is still pushed.
 */
function toRailRow(t: {
  _id: Id<"chatThreads">;
  title: string;
  pinned: boolean;
  updatedAt: number;
}) {
  return { _id: t._id, title: t.title, pinned: t.pinned, updatedAt: t.updatedAt };
}

/** Stream states that mean "this conversation is generating a reply". */
const ACTIVE_STREAM_STATES = ["queued", "running", "waiting_approval"] as const;
/** Far above MAX_CONCURRENT_STREAMS; only bounds a pathological backlog. */
const ACTIVE_STREAM_CAP = 20;

function toListItem(t: {
  _id: Id<"chatThreads">;
  title: string;
  pinned: boolean;
  status: string;
  model: string;
  messageCount: number;
  lastMessageAt: number;
  updatedAt: number;
  streamingMessageId?: Id<"chatMessages">;
}) {
  return {
    _id: t._id,
    title: t.title,
    pinned: t.pinned,
    status: t.status,
    model: t.model,
    messageCount: t.messageCount,
    lastMessageAt: t.lastMessageAt,
    updatedAt: t.updatedAt,
    isStreaming: t.streamingMessageId !== undefined,
  };
}

export const list = query({
  args: {
    workspaceId: v.id("workspaces"),
    status: v.optional(
      v.union(v.literal("active"), v.literal("archived"), v.literal("trashed")),
    ),
    /**
     * Return ONLY chats that belong to no Project (the conversation rail).
     *
     * Phase 2 decision: a chat placed in a Project leaves the rail and lives on
     * its Project page, so the same conversation is not listed twice. Served by
     * the Phase 1 index with an equality on an ABSENT field — Convex indexes a
     * missing optional as `undefined`, so this is a normal indexed range, not a
     * scan, and pagination/ordering are unchanged.
     *
     * Opt-IN rather than the default, so Settings -> Archived Chats keeps
     * listing every archived chat including Project ones. Excluding them there
     * would strand them: the Project page has no archived view.
     */
    unassignedOnly: v.optional(v.boolean()),
    /**
     * Resolve each row's Project name.
     *
     * Only Settings -> Archived Chats asks for this. Restoring an archived
     * Project chat returns it to its PROJECT, not to the rail, so without a
     * visible Project label that restore looks like it silently failed.
     *
     * Off by default because it costs one read per distinct Project, and the
     * rail is the hot path. The `project` key is always present so the return
     * type stays uniform; it is simply never resolved unless asked for.
     */
    withProject: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const uid = await getUserIdOrNull(ctx);
    if (!uid) return EMPTY_PAGE;
    await requireMember(ctx, uid, args.workspaceId);
    const status = args.status ?? "active";

    const res = args.unassignedOnly
      ? await ctx.db
          .query("chatThreads")
          .withIndex("by_user_ws_project_status_updated", (q) =>
            q
              .eq("userId", uid)
              .eq("workspaceId", args.workspaceId)
              .eq("projectId", undefined)
              .eq("status", status),
          )
          .order("desc")
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("chatThreads")
          .withIndex("by_user_ws_status_updated", (q) =>
            q
              .eq("userId", uid)
              .eq("workspaceId", args.workspaceId)
              .eq("status", status),
          )
          .order("desc")
          .paginate(args.paginationOpts);

    if (!args.withProject) {
      return { ...res, page: res.page.map((t) => ({ ...toRailRow(t), project: null })) };
    }

    // Memoised per page: several archived chats commonly share one Project.
    const names = new Map<Id<"projects">, string>();
    const page = [];
    for (const t of res.page) {
      let project: { _id: Id<"projects">; name: string } | null = null;
      if (t.projectId) {
        let name = names.get(t.projectId);
        if (name === undefined) {
          const row = await ctx.db.get(t.projectId);
          // Ownership re-checked on the project row itself: a thread must never
          // surface metadata for a Project the caller does not own.
          if (row && row.userId === uid) {
            name = row.name;
            names.set(t.projectId, name);
          }
        }
        if (name !== undefined) project = { _id: t.projectId, name };
      }
      page.push({ ...toRailRow(t), project });
    }
    return { ...res, page };
  },
});

/**
 * The caller's conversations that are generating a reply right now — the
 * rail's streaming dot, split out of `list` so a turn no longer re-sends the
 * whole conversation list just to show and hide that dot.
 *
 * Read from `chatStreams`, whose active states flip in the SAME transactions
 * that set and clear `chatThreads.streamingMessageId` (send, finalize, stop),
 * so it is exactly the old `isStreaming`. Tiny by construction: at most a few
 * ids, one indexed range per state.
 */
export const streaming = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const uid = await getUserIdOrNull(ctx);
    if (!uid) return [];
    await requireMember(ctx, uid, workspaceId);
    const ids = new Set<Id<"chatThreads">>();
    for (const status of ACTIVE_STREAM_STATES) {
      const rows = await ctx.db
        .query("chatStreams")
        .withIndex("by_user_status", (q) => q.eq("userId", uid).eq("status", status))
        .take(ACTIVE_STREAM_CAP);
      for (const s of rows) if (s.workspaceId === workspaceId) ids.add(s.threadId);
    }
    return [...ids];
  },
});

export const listPinned = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const uid = await getUserIdOrNull(ctx);
    if (!uid) return [];
    await requireMember(ctx, uid, args.workspaceId);
    const rows = await ctx.db
      .query("chatThreads")
      .withIndex("by_user_ws_pinned_updated", (q) =>
        q
          .eq("userId", uid)
          .eq("workspaceId", args.workspaceId)
          .eq("pinned", true),
      )
      .order("desc")
      .take(20);
    return rows.filter((t) => t.status === "active").map(toListItem);
  },
});

/**
 * threadId arrives as a raw string from the URL, so it MUST NOT hit a v.id()
 * validator — a typo'd URL would throw ArgumentValidationError, which the
 * Convex client logs via console.error, which fails every e2e script's
 * zero-console-error assertion. normalizeId returns null instead.
 */
export const get = query({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const uid = await getUserIdOrNull(ctx);
    if (!uid) return null;
    const id = ctx.db.normalizeId("chatThreads", threadId);
    if (!id) return null;
    const thread = await ctx.db.get(id);
    // Return null rather than throwing: "not found" and "not yours" are the
    // same observable outcome, and the UI renders a friendly empty state.
    if (!thread || thread.userId !== uid || thread.status === "trashed") {
      return null;
    }
    await requireMember(ctx, uid, thread.workspaceId);

    // Project context for the chat header. Re-verify ownership on the project
    // row rather than trusting the denormalised link: a thread must never be
    // able to surface metadata for a Project the caller does not own.
    //
    // Exposed from get() ONLY, never from toListItem -- that helper also backs
    // threads.list, which is the sidebar hot path and has no use for it. Same
    // rule the suggestions field below follows.
    let project: { _id: Id<"projects">; name: string; status: string } | null =
      null;
    if (thread.projectId) {
      const row = await ctx.db.get(thread.projectId);
      if (row && row.userId === uid) {
        project = { _id: row._id, name: row.name, status: row.status };
      }
    }

    return {
      ...toListItem(thread),
      project,
      systemPrompt: thread.systemPrompt ?? null,
      tokensIn: thread.tokensIn,
      tokensOut: thread.tokensOut,
      createdAt: thread.createdAt,
      // Exposed HERE only, never from toListItem — that helper is shared with
      // threads.list, which backs the sidebar, and the sidebar has no use for
      // composer chips.
      suggestions: thread.suggestions ?? [],
    };
  },
});

/** Validator shared by `create` and messages.createAndSend. */
export const createThreadArgs = {
  workspaceId: v.id("workspaces"),
  title: v.optional(v.string()),
  model: v.optional(v.string()),
  // A STRING, not v.id("projects"): this value originates in a ?project= URL
  // query param, so a malformed one must not reach a v.id() validator --
  // that throws ArgumentValidationError, which the Convex client logs via
  // console.error, which fails every e2e run. Resolved below instead.
  projectId: v.optional(v.string()),
};

export const create = mutation({
  args: createThreadArgs,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await createThreadForUser(ctx, userId, args);
  },
});

/**
 * The body of `create`, for an already-authenticated caller. Also the first
 * half of messages.createAndSend, which creates the thread and sends the first
 * message in ONE round trip; this is the same code path, not a second one.
 */
export async function createThreadForUser(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: {
    workspaceId: Id<"workspaces">;
    title?: string;
    model?: string;
    projectId?: string;
  },
): Promise<Id<"chatThreads">> {
  await requireMember(ctx, userId, args.workspaceId);

  // Resolve the Project BEFORE creating anything. A bad, foreign or archived
  // project THROWS rather than silently producing an unassigned chat -- the
  // user asked for a chat inside a Project, and quietly giving them one
  // outside it would be a lie they cannot see.
  let projectId: Id<"projects"> | undefined;
  if (args.projectId) {
    const project = await requireProjectAccessByString(
      ctx,
      userId,
      args.projectId,
    );
    // The same user can belong to two workspaces; a thread must never be
    // linked to a Project across that boundary.
    if (project.workspaceId !== args.workspaceId) {
      throw new ConvexError("Not found");
    }
    // An archived Project accepts no NEW work. Its existing chats keep
    // working exactly like any other chat.
    if (project.status !== "active") {
      throw new ConvexError("This project is archived or deleted");
    }
    projectId = project._id;
  }

  const settings = await ctx.db
    .query("chatSettings")
    .withIndex("by_user_workspace", (q) =>
      q.eq("userId", userId).eq("workspaceId", args.workspaceId),
    )
    .unique();

  // explicit only when the caller named a model: a stale saved default
  // should re-home rather than block thread creation outright.
  const model = await assertAllowedModel(
    ctx,
    args.model ?? settings?.defaultModel ?? DEFAULT_MODEL,
    { explicit: args.model !== undefined },
  );
  const now = Date.now();
  const threadId = await ctx.db.insert("chatThreads", {
    workspaceId: args.workspaceId,
    userId,
    title: args.title ? cleanTitle(args.title) : "New chat",
    titleSource: "auto",
    status: "active",
    ...(projectId ? { projectId } : {}),
    pinned: false,
    model,
    // NOT snapshotted from settings any more.
    //
    // Copying the global prompt in here made every new thread carry its own
    // copy, and `stream.ts` resolves `thread.systemPrompt ?? settings...` —
    // so the copy always won and a later change to the global prompt never
    // reached any existing chat. Leaving it unset means "follow the global
    // setting", and the field now means what its name says: a deliberate
    // per-chat OVERRIDE, written only by setSystemPrompt.
    //
    // Threads created before this keep their copy; nothing is rewritten.
    nextSeq: 0,
    messageCount: 0,
    tokensIn: 0,
    tokensOut: 0,
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await bump(ctx, args.workspaceId, "chatThreads", 1);
  await audit(ctx, args.workspaceId, userId, "chat.thread.create", {
    threadId,
  });
  return threadId;
}

export const rename = mutation({
  args: { threadId: v.id("chatThreads"), title: v.string() },
  handler: async (ctx, { threadId, title }) => {
    const userId = await requireUserId(ctx);
    await requireThreadAccess(ctx, userId, threadId);
    // titleSource "user" makes the auto-titler leave it alone forever.
    await ctx.db.patch(threadId, {
      title: cleanTitle(title),
      titleSource: "user",
      updatedAt: Date.now(),
    });
  },
});

export const setPinned = mutation({
  args: { threadId: v.id("chatThreads"), pinned: v.boolean() },
  handler: async (ctx, { threadId, pinned }) => {
    const userId = await requireUserId(ctx);
    await requireThreadAccess(ctx, userId, threadId);
    await ctx.db.patch(threadId, { pinned, updatedAt: Date.now() });
  },
});

export const setModel = mutation({
  args: { threadId: v.id("chatThreads"), model: v.string() },
  handler: async (ctx, { threadId, model }) => {
    const userId = await requireUserId(ctx);
    await requireThreadAccess(ctx, userId, threadId);
    await ctx.db.patch(threadId, {
      model: await assertAllowedModel(ctx, model, { explicit: true }),
      updatedAt: Date.now(),
    });
  },
});

export const setSystemPrompt = mutation({
  args: {
    threadId: v.id("chatThreads"),
    systemPrompt: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { threadId, systemPrompt }) => {
    const userId = await requireUserId(ctx);
    await requireThreadAccess(ctx, userId, threadId);
    await ctx.db.patch(threadId, {
      // Code-point safe: `.slice` cuts UTF-16 units and would store a lone
      // surrogate when the cut lands mid-emoji.
      systemPrompt:
        systemPrompt === null ? undefined : clampText(systemPrompt, 8000),
      updatedAt: Date.now(),
    });
  },
});

export const archive = mutation({
  args: { threadId: v.id("chatThreads"), archived: v.boolean() },
  handler: async (ctx, { threadId, archived }) => {
    const userId = await requireUserId(ctx);
    await requireThreadAccess(ctx, userId, threadId);
    await ctx.db.patch(threadId, {
      status: archived ? "archived" : "active",
      updatedAt: Date.now(),
    });
  },
});

/**
 * Soft delete. A 500-message thread cannot be cascade-deleted inside one
 * transaction safely, so we flip status and let a scheduled purge do the work
 * in bounded batches.
 */
export const remove = mutation({
  args: { threadId: v.id("chatThreads") },
  handler: async (ctx, { threadId }) => {
    const userId = await requireUserId(ctx);
    const thread = await requireThreadAccess(ctx, userId, threadId);
    const now = Date.now();
    await ctx.db.patch(threadId, {
      status: "trashed",
      trashedAt: now,
      pinned: false,
      streamingMessageId: undefined,
      updatedAt: now,
    });
    await bump(ctx, thread.workspaceId, "chatThreads", -1);
    await audit(ctx, thread.workspaceId, userId, "chat.thread.delete", {
      threadId,
    });
    await ctx.scheduler.runAfter(0, internal.chat.threads.purge, { threadId });
  },
});

export const restore = mutation({
  args: { threadId: v.id("chatThreads") },
  handler: async (ctx, { threadId }) => {
    const userId = await requireUserId(ctx);
    const thread = await requireThreadAccessIncludingTrashed(
      ctx,
      userId,
      threadId,
    );
    if (thread.status !== "trashed") return;
    await ctx.db.patch(threadId, {
      status: "active",
      trashedAt: undefined,
      updatedAt: Date.now(),
    });
    await bump(ctx, thread.workspaceId, "chatThreads", 1);
  },
});

/**
 * Cascade-delete a trashed thread's rows in bounded batches, re-scheduling
 * itself while work remains. Deletes children first so a crash mid-purge never
 * leaves orphans pointing at a missing thread.
 */
export const purge = internalMutation({
  args: { threadId: v.id("chatThreads") },
  handler: async (ctx, { threadId }) => {
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.status !== "trashed") return;

    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread_seq", (q) => q.eq("threadId", threadId))
      .take(PURGE_BATCH);

    for (const m of messages) {
      const chunks = await ctx.db
        .query("chatStreamChunks")
        .withIndex("by_message_seq", (q) => q.eq("messageId", m._id))
        .collect();
      for (const c of chunks) await ctx.db.delete(c._id);
      // Any live typed-event rows (Phase 3) — folded events live on the message,
      // which is deleted below; these are only stragglers on an unfinalized turn.
      const events = await ctx.db
        .query("chatStreamEvents")
        .withIndex("by_message_seq", (q) => q.eq("messageId", m._id))
        .collect();
      for (const e of events) await ctx.db.delete(e._id);
      const stream = await ctx.db
        .query("chatStreams")
        .withIndex("by_message", (q) => q.eq("messageId", m._id))
        .unique();
      if (stream) await ctx.db.delete(stream._id);
      await ctx.db.delete(m._id);
    }

    if (messages.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.chat.threads.purge, {
        threadId,
      });
      return;
    }

    const attachments = await ctx.db
      .query("chatAttachments")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .take(PURGE_BATCH);
    for (const a of attachments) {
      await ctx.storage.delete(a.storageId);
      await ctx.db.delete(a._id);
    }
    if (attachments.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.chat.threads.purge, {
        threadId,
      });
      return;
    }

    // File Generation System — generated files are persistent (not deleted at
    // finalize), so a purged thread must reclaim their blobs too.
    const artifacts = await ctx.db
      .query("chatArtifacts")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .take(PURGE_BATCH);
    for (const a of artifacts) {
      await ctx.storage.delete(a.storageId).catch(() => {});
      await ctx.db.delete(a._id);
    }
    if (artifacts.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.chat.threads.purge, {
        threadId,
      });
      return;
    }


    // Phase 7: the SEO mutation ledger is user-scoped + persistent; reclaim this thread's rows.
    await deleteMutationsForThread(ctx, threadId);
    // Deep Research: research runs are user-scoped + persistent; reclaim this thread's rows.
    await deleteResearchRunsForThread(ctx, threadId);
    await ctx.db.delete(threadId);
  },
});

/** Cron: hard-purge anything that has sat in the trash past the TTL. */
export const purgeTrashed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - TRASH_TTL_MS;
    const stale = await ctx.db
      .query("chatThreads")
      .withIndex("by_trashed", (q) =>
        q.eq("status", "trashed").lt("trashedAt", cutoff),
      )
      .take(25);
    for (const t of stale) {
      await ctx.scheduler.runAfter(0, internal.chat.threads.purge, {
        threadId: t._id,
      });
    }
    return stale.length;
  },
});
