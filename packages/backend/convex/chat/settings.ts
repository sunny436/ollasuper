import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireMember } from "../orgs";
import {
  DEFAULT_MODEL,
  assertAllowedModel,
  getUserIdOrNull,
  requireUserId,
} from "./authz";

/**
 * Per-user, per-workspace chat preferences. Custom instructions here are
 * prepended to the system prompt by the Python service.
 */

const MAX_SYSTEM_PROMPT = 8000;
const MAX_INSTRUCTION = 2000;

const DEFAULTS = {
  defaultModel: DEFAULT_MODEL,
  systemPrompt: null as string | null,
  customInstructionsAbout: null as string | null,
  customInstructionsStyle: null as string | null,
  sendOnEnter: true,
};

/**
 * Returns defaults when no row exists — a query must never insert. The row is
 * created lazily by upsert() on the first actual change.
 */
export const get = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return DEFAULTS;
    await requireMember(ctx, userId, workspaceId);
    const row = await ctx.db
      .query("chatSettings")
      .withIndex("by_user_workspace", (q) =>
        q.eq("userId", userId).eq("workspaceId", workspaceId),
      )
      .unique();
    if (!row) return DEFAULTS;
    return {
      defaultModel: row.defaultModel,
      systemPrompt: row.systemPrompt ?? null,
      customInstructionsAbout: row.customInstructionsAbout ?? null,
      customInstructionsStyle: row.customInstructionsStyle ?? null,
      sendOnEnter: row.sendOnEnter,
    };
  },
});

export const upsert = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    defaultModel: v.optional(v.string()),
    systemPrompt: v.optional(v.union(v.string(), v.null())),
    customInstructionsAbout: v.optional(v.union(v.string(), v.null())),
    customInstructionsStyle: v.optional(v.union(v.string(), v.null())),
    sendOnEnter: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, args.workspaceId);

    const existing = await ctx.db
      .query("chatSettings")
      .withIndex("by_user_workspace", (q) =>
        q.eq("userId", userId).eq("workspaceId", args.workspaceId),
      )
      .unique();

    // Only fields the caller actually supplied are touched; `null` clears.
    const next = {
      defaultModel:
        args.defaultModel !== undefined
          ? await assertAllowedModel(ctx, args.defaultModel, {
              explicit: true,
            })
          : existing?.defaultModel ?? DEFAULT_MODEL,
      systemPrompt:
        args.systemPrompt !== undefined
          ? args.systemPrompt?.slice(0, MAX_SYSTEM_PROMPT) ?? undefined
          : existing?.systemPrompt,
      customInstructionsAbout:
        args.customInstructionsAbout !== undefined
          ? args.customInstructionsAbout?.slice(0, MAX_INSTRUCTION) ?? undefined
          : existing?.customInstructionsAbout,
      customInstructionsStyle:
        args.customInstructionsStyle !== undefined
          ? args.customInstructionsStyle?.slice(0, MAX_INSTRUCTION) ?? undefined
          : existing?.customInstructionsStyle,
      sendOnEnter: args.sendOnEnter ?? existing?.sendOnEnter ?? true,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, next);
      return existing._id;
    }
    return await ctx.db.insert("chatSettings", {
      workspaceId: args.workspaceId,
      userId,
      ...next,
    });
  },
});

export const reset = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, workspaceId);
    const existing = await ctx.db
      .query("chatSettings")
      .withIndex("by_user_workspace", (q) =>
        q.eq("userId", userId).eq("workspaceId", workspaceId),
      )
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
