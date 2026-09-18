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

/**
 * The canonical shape, mirrored by the Convex validator on `upsert` and by
 * `Personalization` in the Python contract. One name, three enforcement points.
 */
export type Personalization = {
  version: number;
  enabled: boolean;
  baseStyle: "default" | "friendly" | "concise" | "formal" | "playful";
  characteristics: ("warm" | "enthusiastic" | "headers" | "emoji")[];
  responseSpeed: "fast" | "balanced" | "thorough";
  responseLanguage: string;
};

/** Product defaults. Reset returns exactly this, and nothing else. */
export const PERSONALIZATION_DEFAULTS: Personalization = {
  version: 1,
  enabled: true,
  baseStyle: "default",
  characteristics: [],
  responseSpeed: "balanced",
  responseLanguage: "auto",
};

/**
 * Clamp by CODE POINT, not UTF-16 unit.
 *
 * `String.prototype.slice` cuts code units, so slicing mid-emoji stores a lone
 * surrogate — invalid text that then travels into the model request. Spreading
 * iterates code points, so a character is either kept whole or dropped whole.
 */
export function clampText(s: string, max: number): string {
  const points = [...s];
  return points.length <= max ? s : points.slice(0, max).join("");
}

/**
 * The LEGACY prose string, derived from the canonical object.
 *
 * Written only so a rollback to a Python build that predates
 * `personalization` still styles replies. Python's compiler is authoritative
 * and its wording may differ; this is a compatibility artefact, not a second
 * source of truth, which is why it is short and never read back by the client.
 */
export function legacyStyleString(p: Personalization): string | null {
  if (!p.enabled) return null;
  const out: string[] = [];
  if (p.baseStyle !== "default") out.push(`Tone: ${p.baseStyle}.`);
  if (p.characteristics.includes("warm")) out.push("Be warm and encouraging.");
  if (p.characteristics.includes("enthusiastic"))
    out.push("Be enthusiastic and energetic.");
  if (p.characteristics.includes("headers"))
    out.push("Use headers and lists to structure responses.");
  if (p.characteristics.includes("emoji")) out.push("Use emoji where appropriate.");
  if (p.responseSpeed === "fast")
    out.push("Prefer fast, concise answers over exhaustive detail.");
  if (p.responseSpeed === "thorough")
    out.push("Cover the edge cases that matter.");
  const lang = (p.responseLanguage ?? "").trim();
  if (lang && lang.toLowerCase() !== "auto") out.push(`Answer in ${lang}.`);
  return out.length ? out.join(" ") : null;
}

const DEFAULTS = {
  defaultModel: DEFAULT_MODEL,
  systemPrompt: null as string | null,
  customInstructionsAbout: null as string | null,
  customInstructionsStyle: null as string | null,
  personalization: PERSONALIZATION_DEFAULTS,
  sendOnEnter: true,
  ambience: null as number | null,
  // Absent means "product default" (blue), resolved on the client.
  accentColor: null as string | null,
  // Memory is on unless explicitly turned off (null = default-on at read time).
  memoryEnabled: null as boolean | null,
  updatedAt: 0,
};

const clampAmbience = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

/**
 * The accent names the product ships. Duplicated from the frontend's ACCENTS on
 * purpose: this is a TRUST BOUNDARY, and a server that imports its allowlist from
 * the client is not validating anything. An unknown name is stored as null —
 * "no preference" — rather than rejected, so a newer client naming an accent this
 * deployment does not have degrades to the default instead of failing the write.
 */
const ACCENT_NAMES = new Set([
  "blue",
  "green",
  "yellow",
  "pink",
  "orange",
  "purple",
  "neutral",
]);
const cleanAccent = (v: string | null) =>
  v !== null && ACCENT_NAMES.has(v) ? v : null;

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
      // A row written before this field existed reads as product defaults —
      // no migration, no backfill, no behaviour change for those users.
      personalization: row.personalization ?? PERSONALIZATION_DEFAULTS,
      sendOnEnter: row.sendOnEnter,
      ambience: row.ambience ?? null,
      accentColor: row.accentColor ?? null,
      memoryEnabled: row.memoryEnabled ?? null,
      updatedAt: row.updatedAt,
    };
  },
});

/**
 * Return personalization to the product defaults.
 *
 * SCOPE IS THE WHOLE POINT. This touches the two personalization fields on this
 * user's own settings row and nothing else: memories, project instructions, the
 * model choice, ambience, sendOnEnter and every other preference are left
 * exactly as they were. "Reset" has destroyed unrelated user data in enough
 * products that the narrowness here is deliberate and worth stating.
 *
 * Custom instructions are NOT cleared: they are something the user wrote, not a
 * setting they toggled. Clearing them is a separate, explicit act.
 */
export const resetPersonalization = mutation({
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
    // No row means the user is already on defaults; writing one would only
    // create a row that says "unchanged".
    if (!existing) return null;
    await ctx.db.patch(existing._id, {
      personalization: PERSONALIZATION_DEFAULTS,
      customInstructionsStyle: legacyStyleString(PERSONALIZATION_DEFAULTS) ?? undefined,
      updatedAt: Date.now(),
    });
    return existing._id;
  },
});

export const upsert = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    defaultModel: v.optional(v.string()),
    systemPrompt: v.optional(v.union(v.string(), v.null())),
    customInstructionsAbout: v.optional(v.union(v.string(), v.null())),
    customInstructionsStyle: v.optional(v.union(v.string(), v.null())),
    // ALLOWLISTED, field by field. Nothing is spread from the client, so an
    // unknown key is a validator error and can never become a stored setting.
    personalization: v.optional(
      v.object({
        version: v.number(),
        enabled: v.boolean(),
        baseStyle: v.union(
          v.literal("default"),
          v.literal("friendly"),
          v.literal("concise"),
          v.literal("formal"),
          v.literal("playful"),
        ),
        characteristics: v.array(
          v.union(
            v.literal("warm"),
            v.literal("enthusiastic"),
            v.literal("headers"),
            v.literal("emoji"),
          ),
        ),
        responseSpeed: v.union(
          v.literal("fast"),
          v.literal("balanced"),
          v.literal("thorough"),
        ),
        responseLanguage: v.optional(v.string()),
      }),
    ),
    sendOnEnter: v.optional(v.boolean()),
    ambience: v.optional(v.union(v.number(), v.null())),
    accentColor: v.optional(v.union(v.string(), v.null())),
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
          ? args.systemPrompt === null
            ? undefined
            : clampText(args.systemPrompt, MAX_SYSTEM_PROMPT)
          : existing?.systemPrompt,
      customInstructionsAbout:
        args.customInstructionsAbout !== undefined
          ? args.customInstructionsAbout === null
            ? undefined
            : clampText(args.customInstructionsAbout, MAX_INSTRUCTION)
          : existing?.customInstructionsAbout,
      // DERIVED, never taken from the client, whenever the canonical object is
      // supplied — otherwise the rollback string could drift from the settings
      // it is supposed to mirror.
      customInstructionsStyle:
        args.personalization !== undefined
          ? (legacyStyleString({
              ...PERSONALIZATION_DEFAULTS,
              ...args.personalization,
              responseLanguage: args.personalization.responseLanguage ?? "auto",
            }) ?? undefined)
          : args.customInstructionsStyle !== undefined
            ? args.customInstructionsStyle === null
              ? undefined
              : clampText(args.customInstructionsStyle, MAX_INSTRUCTION)
            : existing?.customInstructionsStyle,
      // Canonical wins; the legacy prose string is DERIVED from it so the two
      // can never disagree. An update that does not mention personalization
      // leaves both exactly as they were.
      personalization:
        args.personalization !== undefined
          ? {
              ...args.personalization,
              responseLanguage: clampText(
                (args.personalization.responseLanguage ?? "auto").trim() || "auto",
                32,
              ),
              characteristics: [...new Set(args.personalization.characteristics)],
            }
          : existing?.personalization,
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
      accentColor:
        args.accentColor !== undefined
          ? cleanAccent(args.accentColor)
          : existing?.accentColor,
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
 * This is the other half of the trace, and the one that actually reaches the
 * user: the picker shows the CURRENT THREAD's model, so a conversation last
 * used on a retired id keeps rendering it, and the client then sends that id on
 * a NEW thread — where it no longer matches `thread.model`, so
 * `assertAllowedModel` reads it as a deliberate pick and throws
 * "Unsupported model".
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
