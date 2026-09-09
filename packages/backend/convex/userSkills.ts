import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, mutation, query } from "./_generated/server";
import { audit } from "./auditLog";
import { getUserIdOrNull, requireUserId } from "./chat/authz";
import { requireMember } from "./orgs";
import {
  MAX_SKILLS_PER_USER,
  validateCapabilities,
  validateSkill,
} from "./skillPolicy";

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
    capabilities: s.capabilities ?? [],
    enabled: s.enabled,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/**
 * Phase 4 — the RUNTIME snapshot of one skill, as the inference plane sees it.
 *
 * Deliberately NOT `toClient`. This crosses a service boundary into a process
 * that composes model prompts, so it carries only what that job needs plus the
 * two fields the receiver re-checks:
 *
 *   `ownerId`  so Python can assert the row belongs to the request's caller.
 *              Redundant with the query below — which is the point. If a future
 *              edit to this file ever widens the read, the assertion downstream
 *              turns a silent cross-user leak into a logged, dropped skill.
 *   `enabled`  same reasoning: the query already filters, and the receiver
 *              re-checks rather than trusting the sender.
 *
 * `revision` is `updatedAt`. There is no separate version column and inventing
 * one would be a second thing to keep in sync — the row's last write time IS
 * its revision, it is already monotonic, and it is what telemetry needs to say
 * WHICH text influenced a turn.
 *
 * Not sent: `workspaceId` (skills are user-scoped; shipping it would invite
 * someone to scope on it and quietly reintroduce a boundary the data does not
 * have), `createdAt`, `_creationTime`.
 */
export type DispatchSkill = {
  id: Id<"userSkills">;
  ownerId: Id<"users">;
  revision: number;
  name: string;
  description: string;
  instructions: string;
  constraints: string;
  capabilities: string[];
  enabled: boolean;
};

/**
 * LIFECYCLE CONTRACT (Phase 7) — read this before adding a version column.
 *
 * THE QUESTION: does a run need a pinned snapshot of the skills it started
 * with? The answer is NO, and it is no for reasons in the code rather than by
 * preference.
 *
 * 1. A RUN IS ALREADY IMMUTABLE. `dispatchPayload` reads these rows once and
 *    ships them BY VALUE. `run_generation` reads `req.customSkills` exactly
 *    once and never mutates `req`. So an edit during a running generation
 *    cannot reach it — the GenerateRequest IS the snapshot, and a durable one
 *    would be a second copy of something already fixed.
 *
 * 2. NOTHING HOLDS A REFERENCE. No table anywhere carries a `v.id("userSkills")`.
 *    A deleted skill therefore cannot dangle: there is no pointer to break,
 *    only content that stops being sent on the next dispatch.
 *
 * 3. ACROSS ATTEMPTS, LATEST WINS — deliberately, and consistently. A retry or
 *    a resume re-runs `dispatchPayload`, so it sees current rows. That is
 *    exactly how every other piece of user-owned configuration behaves on the
 *    same turn: `projectInstructions` ("read fresh from the project row on
 *    EVERY dispatch, deliberately NOT snapshotted"), `memories`,
 *    `personalization`. Pinning skills alone would give one input a guarantee
 *    its neighbours do not have, which is harder to explain than either rule
 *    on its own and would still not make a resumed turn reproducible.
 *
 * WHAT SCHEDULED TASKS PIN, AND WHY SKILLS ARE NOT IT.
 * `scheduledTaskRevisions` pins a task's MEANING — prompt, spec, and which
 * Project — so "a task that later moves Project does not retroactively change
 * what an already-scheduled run meant". It pins the BINDING, not the content
 * behind it: the pinned `projectId` still resolves to that Project's current
 * instructions at dispatch. Skills have no binding to pin. A task cannot name
 * a skill; skills apply because the run belongs to their owner. So there is no
 * reference to freeze, and the content question is the same one answered above.
 *
 * THE USER-VISIBLE RULE, which the Settings copy already states: a change
 * applies from your next message. Edit, disable and delete all behave that way,
 * and an in-flight turn finishes under what it started with.
 *
 * THE ONE PLACE THIS IS NOT ENOUGH is an approved-but-unrun tool, because
 * consent was given for a specific call and an unrelated edit must not discard
 * it. That is handled in the runner, where `approvedPending` tool ids are
 * re-seeded into the reservation set — see the comment there.
 */

/**
 * Every ENABLED skill this user owns, for one turn.
 *
 * THE CAP IS THE PRODUCT CAP, on purpose. A smaller dispatch cap would be a
 * silent cliff: a user with more skills than the cap would have some that never
 * apply and no way to find out which. `MAX_SKILLS_PER_USER` is already the hard
 * ceiling on what anyone can own, so bounding by it means the payload is bounded
 * AND every enabled skill is always a candidate. What reaches the model is
 * bounded separately, in Python, by relevance and a character budget.
 *
 * Ordered by `updatedAt` desc so the set is deterministic — dispatch must not
 * depend on index insertion order.
 */
export async function loadSkillsForDispatch(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<DispatchSkill[]> {
  const rows = await ctx.db
    .query("userSkills")
    .withIndex("by_user_enabled", (q) =>
      q.eq("userId", userId).eq("enabled", true),
    )
    .take(MAX_SKILLS_PER_USER);
  return [...rows]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((s) => ({
      id: s._id,
      ownerId: s.userId,
      revision: s.updatedAt,
      name: s.name,
      description: s.description,
      instructions: s.instructions,
      constraints: s.constraints ?? "",
      capabilities: s.capabilities ?? [],
      enabled: s.enabled,
    }));
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
    capabilities: v.optional(v.array(v.string())),
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
    const caps = validateCapabilities(args.capabilities);
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
      // Hints only. Nothing consumes them yet; the runtime resolves meaning and
      // enforces authorization per call when it does.
      ...(caps.length ? { capabilities: caps } : {}),
      // A new skill starts ON: the user just wrote it deliberately. Never
      // client-supplied, so `enabled` cannot be forged past validation.
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    // THE ID ONLY — not the name, and never the body.
    //
    // Audit rows are WORKSPACE-scoped and `audit.recent` serves them to any
    // member of that workspace. The Settings page promises these skills are
    // "Private to you", so a name here made a peer able to read what someone
    // called their own private guidance — and a title like "Draft my
    // resignation letter" is exactly the kind that must not travel.
    //
    // Phase 2 logged the name having reasoned that only the BODY was sensitive.
    // That was the wrong half: it asked what the row contained and never asked
    // who could read it. `skillId` says which skill changed, which is all an
    // audit trail needs — the owner can resolve it and nobody else should.
    await audit(ctx, args.workspaceId, userId, "skill.create", {
      skillId,
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
    capabilities: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const skill = await ownedSkill(ctx, userId, args.skillId);
    await requireMember(ctx, userId, skill.workspaceId);
    const clean = validateSkill(args);
    const caps = validateCapabilities(args.capabilities);
    await ctx.db.patch(args.skillId, {
      name: clean.name,
      description: clean.description,
      instructions: clean.instructions,
      // Cleared explicitly when emptied, rather than left stale. The form
      // always renders this field, so empty genuinely means "remove it".
      constraints: clean.constraints || undefined,
      // OMITTED MEANS UNCHANGED, not cleared — `patch` deletes a field whose
      // value is undefined, so a caller that does not render capabilities
      // (which is every caller today) would wipe them on an unrelated rename.
      // Sending an empty array is still how you clear them, explicitly.
      ...(args.capabilities === undefined
        ? {}
        : { capabilities: caps.length ? caps : undefined }),
      updatedAt: Date.now(),
    });
    await audit(ctx, skill.workspaceId, userId, "skill.update", {
      skillId: args.skillId,
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
    });
    return { ok: true };
  },
});
