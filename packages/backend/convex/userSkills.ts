import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, mutation, query } from "./_generated/server";
import { audit } from "./auditLog";
import { getUserIdOrNull, requireUserId } from "./chat/authz";
import { requireMember } from "./orgs";
import { MAX_SKILLS_PER_USER, validateSkill } from "./skillPolicy";

/**
 * Phase 1 — persistence + authorization for USER-AUTHORED CUSTOM SKILLS.
 *
 * A skill is private declarative guidance its owner wrote. This module owns
 * storage and access; it deliberately contains NO runtime behaviour — nothing
 * here loads a skill into a prompt, and no field implies executable behaviour.
 *
 * OWNERSHIP IS THE USER. Skills follow the person across workspaces, the same
 * shape `userMemories` already has for scope "user" and the same way
 * `memories.list` already reads ("the user's OWN memories across workspaces").
 * `workspaceId` on the row is creation context: it satisfies `audit()` and the
 * membership check on writes, and NO read filters on it.
 *
 * THE THREE PROPERTIES THIS FILE EXISTS TO GUARANTEE:
 *
 *   1. Ownership cannot be forged. There is no owner argument anywhere; every
 *      write derives the owner from `requireUserId`, which also refuses a
 *      suspended account.
 *   2. A non-owner cannot read, update, enable, disable or delete. Every
 *      by-id path goes through `ownedSkill`, which reports "Not found" for
 *      missing AND for not-yours — so the error is not an existence oracle for
 *      somebody else's skill id.
 *   3. No query can enumerate. Every index pins `userId` first and every read
 *      here opens with `.eq("userId", userId)`; there is no listing shape that
 *      returns another person's rows, in this workspace or any other.
 */

/** The client-facing shape. Explicit, so a future column cannot leak by spread. */
function toClient(s: Doc<"userSkills">) {
  return {
    _id: s._id,
    name: s.name,
    description: s.description,
    instructions: s.instructions,
    constraints: s.constraints ?? "",
    enabled: s.enabled,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/**
 * Resolve a skill that belongs to THIS caller, or refuse.
 *
 * The identical message for "does not exist" and "is not yours" is the point:
 * distinguishing them would let anyone probe skill ids for existence.
 */
async function ownedSkill(
  ctx: QueryCtx,
  userId: Id<"users">,
  skillId: Id<"userSkills">,
): Promise<Doc<"userSkills">> {
  const s = await ctx.db.get(skillId);
  if (!s || s.userId !== userId) throw new ConvexError("Not found");
  return s;
}

/**
 * The caller's own skills, newest first — across every workspace they belong to.
 *
 * Returns an empty page rather than throwing when signed out: a rejected query
 * logs console.error, and every e2e script asserts zero of those.
 */
export const list = query({
  args: {
    workspaceId: v.id("workspaces"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };
    // Proves the caller is a member of SOME workspace they claim — it does not
    // scope the read, which is deliberately user-wide.
    await requireMember(ctx, userId, args.workspaceId);
    const res = await ctx.db
      .query("userSkills")
      .withIndex("by_user_updated", (q) => q.eq("userId", userId))
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...res, page: res.page.map(toClient) };
  },
});

/**
 * One skill by id.
 *
 * `skillId` is `v.string()` + `normalizeId`, never `v.id()`: a malformed id from
 * a URL would otherwise throw ArgumentValidationError, which the Convex client
 * logs via console.error and which fails every e2e script. Returns null for
 * malformed, missing and not-yours alike.
 */
export const get = query({
  args: { skillId: v.string() },
  handler: async (ctx, { skillId }) => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return null;
    const id = ctx.db.normalizeId("userSkills", skillId);
    if (!id) return null;
    const s = await ctx.db.get(id);
    if (!s || s.userId !== userId) return null;
    return toClient(s);
  },
});

export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
    description: v.string(),
    instructions: v.string(),
    constraints: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, args.workspaceId);

    // Counted across ALL workspaces, because the cap is per PERSON — a
    // workspace-local count would let the same user hold 50 per workspace.
    const existing = await ctx.db
      .query("userSkills")
      .withIndex("by_user_updated", (q) => q.eq("userId", userId))
      .take(MAX_SKILLS_PER_USER + 1);
    if (existing.length >= MAX_SKILLS_PER_USER) {
      throw new ConvexError(
        `You can have at most ${MAX_SKILLS_PER_USER} custom skills. Delete one to make room.`,
      );
    }

    const clean = validateSkill(args);
    const now = Date.now();
    const skillId = await ctx.db.insert("userSkills", {
      // Ownership is ALWAYS the authenticated caller. There is no owner
      // argument, so no caller can create a skill belonging to someone else.
      userId,
      workspaceId: args.workspaceId,
      name: clean.name,
      description: clean.description,
      instructions: clean.instructions,
      ...(clean.constraints ? { constraints: clean.constraints } : {}),
      // A new skill starts ON: the user just wrote it deliberately. Never
      // client-supplied, so `enabled` cannot be forged past validation.
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    // The NAME only — never the instructions. Audit rows are widely readable
    // within a workspace, and a private skill's body is not workspace data.
    await audit(ctx, args.workspaceId, userId, "skill.create", {
      skillId,
      name: clean.name,
    });
    return skillId;
  },
});

export const update = mutation({
  args: {
    skillId: v.id("userSkills"),
    name: v.string(),
    description: v.string(),
    instructions: v.string(),
    constraints: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const skill = await ownedSkill(ctx, userId, args.skillId);
    await requireMember(ctx, userId, skill.workspaceId);
    const clean = validateSkill(args);
    await ctx.db.patch(args.skillId, {
      name: clean.name,
      description: clean.description,
      instructions: clean.instructions,
      // Cleared explicitly when emptied, rather than left stale.
      constraints: clean.constraints || undefined,
      updatedAt: Date.now(),
    });
    await audit(ctx, skill.workspaceId, userId, "skill.update", {
      skillId: args.skillId,
      name: clean.name,
    });
    return { ok: true };
  },
});

/**
 * Enable or disable. Disabling IGNORES a skill; it never deletes it, and the
 * body is kept untouched so re-enabling restores exactly what was written.
 */
export const setEnabled = mutation({
  args: { skillId: v.id("userSkills"), enabled: v.boolean() },
  handler: async (ctx, { skillId, enabled }) => {
    const userId = await requireUserId(ctx);
    const skill = await ownedSkill(ctx, userId, skillId);
    await requireMember(ctx, userId, skill.workspaceId);
    await ctx.db.patch(skillId, { enabled, updatedAt: Date.now() });
    await audit(
      ctx,
      skill.workspaceId,
      userId,
      enabled ? "skill.enable" : "skill.disable",
      { skillId },
    );
    return { ok: true };
  },
});

/**
 * HARD delete, deliberately.
 *
 * The requirement is that a deleted skill can never reach runtime discovery. A
 * row that does not exist cannot, whereas a soft-deleted one makes every future
 * query responsible for remembering a status filter — and forgetting it once is
 * a silent leak. `memories.remove` already deletes outright for the same
 * reason. There is no revision history to preserve in v1, so nothing is lost
 * that the user did not choose to lose.
 */
export const remove = mutation({
  args: { skillId: v.id("userSkills") },
  handler: async (ctx, { skillId }) => {
    const userId = await requireUserId(ctx);
    const skill = await ownedSkill(ctx, userId, skillId);
    await requireMember(ctx, userId, skill.workspaceId);
    await ctx.db.delete(skillId);
    await audit(ctx, skill.workspaceId, userId, "skill.delete", {
      skillId,
      name: skill.name,
    });
    return { ok: true };
  },
});
