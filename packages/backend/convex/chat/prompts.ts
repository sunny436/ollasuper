import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { requireMember } from "../orgs";
import {
  getUserIdOrNull,
  requireOwnedPrompt,
  requirePromptReadAccess,
  requireUserId,
} from "./authz";

/**
 * Prompt library. Prompts are the ONE chat entity where workspace sharing is
 * sane: they are authored artefacts, not private conversations. Sharing is
 * opt-in and defaults to false.
 *
 * Deliberately no search index (unlike threads/messages): a prompt library is
 * O(100) per user and fully resident in the sidebar, so client-side filtering
 * is correct. The deciding factor is whether the corpus is already on the
 * client — for conversations it never is, for prompts it always is.
 */

const MAX_PROMPTS = 200;
const MAX_TITLE = 120;
const MAX_BODY = 8000;
const MAX_TAGS = 8;

function cleanTitle(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  if (!t) throw new ConvexError("Title cannot be empty");
  return t;
}

function cleanBody(raw: string): string {
  const b = raw.trim().slice(0, MAX_BODY);
  if (!b) throw new ConvexError("Prompt body cannot be empty");
  return b;
}

function cleanTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  return Array.from(
    new Set(
      tags
        .map((t) => t.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 32))
        .filter(Boolean),
    ),
  ).slice(0, MAX_TAGS);
}

function toItem(p: Doc<"chatPrompts">, viewerId: Id<"users">) {
  return {
    _id: p._id,
    title: p.title,
    body: p.body,
    description: p.description ?? null,
    tags: p.tags,
    shared: p.shared,
    usageCount: p.usageCount,
    updatedAt: p.updatedAt,
    isOwn: p.userId === viewerId,
  };
}

/** Own prompts plus anything shared in this workspace, deduped, newest first. */
export const list = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return [];
    await requireMember(ctx, userId, workspaceId);

    const [mine, shared] = await Promise.all([
      ctx.db
        .query("chatPrompts")
        .withIndex("by_user_ws_updated", (q) =>
          q.eq("userId", userId).eq("workspaceId", workspaceId),
        )
        .order("desc")
        .take(MAX_PROMPTS),
      ctx.db
        .query("chatPrompts")
        .withIndex("by_ws_shared_updated", (q) =>
          q.eq("workspaceId", workspaceId).eq("shared", true),
        )
        .order("desc")
        .take(MAX_PROMPTS),
    ]);

    const seen = new Set<string>();
    const out: ReturnType<typeof toItem>[] = [];
    for (const p of [...mine, ...shared]) {
      if (seen.has(p._id)) continue;
      seen.add(p._id);
      out.push(toItem(p, userId));
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  },
});

export const get = query({
  args: { promptId: v.id("chatPrompts") },
  handler: async (ctx, { promptId }) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return null;
    const p = await requirePromptReadAccess(ctx, userId, promptId);
    return toItem(p, userId);
  },
});

export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    title: v.string(),
    body: v.string(),
    description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    shared: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, args.workspaceId);

    const existing = await ctx.db
      .query("chatPrompts")
      .withIndex("by_user_ws_updated", (q) =>
        q.eq("userId", userId).eq("workspaceId", args.workspaceId),
      )
      .take(MAX_PROMPTS + 1);
    if (existing.length > MAX_PROMPTS) {
      throw new ConvexError("Prompt limit reached");
    }

    const now = Date.now();
    return await ctx.db.insert("chatPrompts", {
      workspaceId: args.workspaceId,
      userId,
      title: cleanTitle(args.title),
      body: cleanBody(args.body),
      description: args.description?.slice(0, 300),
      tags: cleanTags(args.tags),
      shared: args.shared ?? false,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    promptId: v.id("chatPrompts"),
    title: v.optional(v.string()),
    body: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireOwnedPrompt(ctx, userId, args.promptId);
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.title !== undefined) patch.title = cleanTitle(args.title);
    if (args.body !== undefined) patch.body = cleanBody(args.body);
    if (args.description !== undefined) {
      patch.description = args.description?.slice(0, 300) ?? undefined;
    }
    if (args.tags !== undefined) patch.tags = cleanTags(args.tags);
    await ctx.db.patch(args.promptId, patch);
  },
});

export const setShared = mutation({
  args: { promptId: v.id("chatPrompts"), shared: v.boolean() },
  handler: async (ctx, { promptId, shared }) => {
    const userId = await requireUserId(ctx);
    await requireOwnedPrompt(ctx, userId, promptId);
    await ctx.db.patch(promptId, { shared, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { promptId: v.id("chatPrompts") },
  handler: async (ctx, { promptId }) => {
    const userId = await requireUserId(ctx);
    await requireOwnedPrompt(ctx, userId, promptId);
    await ctx.db.delete(promptId);
  },
});

/**
 * Bump the usage counter when a prompt is inserted into the composer. Read
 * access is enough — using someone's shared prompt is a legitimate action, and
 * it must not require ownership.
 */
export const recordUse = mutation({
  args: { promptId: v.id("chatPrompts") },
  handler: async (ctx, { promptId }) => {
    const userId = await requireUserId(ctx);
    const prompt = await requirePromptReadAccess(ctx, userId, promptId);
    // Note: does NOT touch updatedAt — using a prompt shouldn't reorder the list.
    await ctx.db.patch(promptId, { usageCount: prompt.usageCount + 1 });
  },
});
