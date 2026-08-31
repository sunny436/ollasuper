import { v } from "convex/values";
import { mutation, query, internalMutation } from "../_generated/server";
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
  ambience: null as number | null,
  // Memory is on unless explicitly turned off (null = default-on at read time).
  memoryEnabled: null as boolean | null,
  updatedAt: 0,
};

const clampAmbience = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

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
      ambience: row.ambience ?? null,
      memoryEnabled: row.memoryEnabled ?? null,
      updatedAt: row.updatedAt,
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
    ambience: v.optional(v.union(v.number(), v.null())),
    memoryEnabled: v.optional(v.union(v.boolean(), v.null())),
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
      memoryEnabled:
        args.memoryEnabled !== undefined
          ? (args.memoryEnabled ?? undefined)
          : existing?.memoryEnabled,
      ambience:
        args.ambience !== undefined
          ? args.ambience === null
            ? undefined
            : clampAmbience(args.ambience)
          : existing?.ambience,
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

/**
 * Move settings off a model the provider has stopped serving.
 *
 * Changing DEFAULT_MODEL only helps users who never picked one. Anyone with a
 * stored `defaultModel` keeps using it, and `assertAllowedModel` will not
 * rescue them: the dead ids are still in the catalogue — they are valid models
 * that happen to be failing upstream — so they pass the membership check and
 * then 502 on every turn.
 *
 * Deliberately narrow. It rewrites ONLY the ids passed in, only when they match
 * exactly, and it never touches a row that has chosen anything else. Someone's
 * model choice is theirs; this is for the case where the thing they chose no
 * longer exists to choose.
 */
export const remapDeadModels = internalMutation({
  args: { from: v.array(v.string()), to: v.string() },
  handler: async (ctx, { from, to }): Promise<{ scanned: number; moved: number }> => {
    const dead = new Set(from);
    const rows = await ctx.db.query("chatSettings").collect();
    let moved = 0;
    for (const row of rows) {
      if (!dead.has(row.defaultModel)) continue;
      await ctx.db.patch(row._id, { defaultModel: to, updatedAt: Date.now() });
      moved++;
    }
    return { scanned: rows.length, moved };
  },
});

/**
 * The same for threads already created against a dead model.
 *
 * A scheduled task's execution thread is created ONCE and reused, so without
 * this an existing task keeps dispatching to the dead model forever — the
 * settings fix would only reach tasks created afterwards.
 */
export const remapDeadThreadModels = internalMutation({
  args: { from: v.array(v.string()), to: v.string() },
  handler: async (ctx, { from, to }): Promise<{ scanned: number; moved: number }> => {
    const dead = new Set(from);
    const rows = await ctx.db.query("chatThreads").take(2000);
    let moved = 0;
    for (const row of rows) {
      if (!dead.has(row.model)) continue;
      await ctx.db.patch(row._id, { model: to });
      moved++;
    }
    return { scanned: rows.length, moved };
  },
});
