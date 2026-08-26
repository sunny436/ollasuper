import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, mutation, query } from "../_generated/server";
import { audit } from "../auditLog";
import { bump } from "../counters";
import { requireMember } from "../orgs";
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
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const uid = await getUserIdOrNull(ctx);
    if (!uid) return EMPTY_PAGE;
    await requireMember(ctx, uid, args.workspaceId);
    const status = args.status ?? "active";
    const res = await ctx.db
      .query("chatThreads")
      .withIndex("by_user_ws_status_updated", (q) =>
        q
          .eq("userId", uid)
          .eq("workspaceId", args.workspaceId)
          .eq("status", status),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...res, page: res.page.map(toListItem) };
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
    return {
      ...toListItem(thread),
      systemPrompt: thread.systemPrompt ?? null,
      tokensIn: thread.tokensIn,
      tokensOut: thread.tokensOut,
      createdAt: thread.createdAt,
    };
  },
});

export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    title: v.optional(v.string()),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, args.workspaceId);

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
      pinned: false,
      model,
      systemPrompt: settings?.systemPrompt,
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
  },
});

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
      systemPrompt: systemPrompt?.slice(0, 8000) ?? undefined,
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

    // Phase 3 — SEO report rows are persistent too (their downloadable blobs are the
    // chatArtifacts reclaimed just above); reclaim the rows here.
    const reports = await ctx.db
      .query("seoReports")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .take(PURGE_BATCH);
    for (const r of reports) await ctx.db.delete(r._id);
    if (reports.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.chat.threads.purge, {
        threadId,
      });
      return;
    }

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
