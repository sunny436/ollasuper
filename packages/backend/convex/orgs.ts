import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { audit } from "./auditLog";
import { bump } from "./counters";
import { requireDevSeed } from "./devGuard";
import { notify } from "./notifications";
import { activeUserId, isActiveUser } from "./accountState";

type Role = "owner" | "admin" | "member";

/**
 * The roles an invitation or a role change may ever confer.
 *
 * OWNERSHIP IS CONFERRED ONLY BY CREATING A WORKSPACE. `changeRole` always
 * enforced that; `invite` validated nothing, and `acceptInviteImpl` inserted the
 * STORED role verbatim — so an invite row written before this check could still
 * confer ownership when accepted, and issuance-side validation alone would not
 * have reached rows already sitting in a live database. The allowlist lives here
 * once so the three callers cannot drift apart again.
 */
const ASSIGNABLE_ROLES: readonly string[] = ["admin", "member"];

function assertAssignableRole(role: string): void {
  if (!ASSIGNABLE_ROLES.includes(role)) throw new ConvexError("Invalid role");
}

/**
 * How long an invitation stays redeemable. A grant is a standing capability to
 * join; one issued months ago must not still work (audit F-11).
 */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function membership(
  ctx: QueryCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
) {
  return ctx.db
    .query("members")
    .withIndex("by_user_workspace", (q) =>
      q.eq("userId", userId).eq("workspaceId", workspaceId),
    )
    .unique();
}

export async function requireRole(
  ctx: QueryCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
  roles: Role[],
) {
  // SUSPENSION IS A KILL SWITCH, and it has to bite here. accountStatus was
  // enforced only on sign-in and in chat/authz.ts, so a suspended (or deleted)
  // user's EXISTING session kept full access to files, projects, scheduled tasks,
  // workspace members and API keys — every surface funnels through requireRole,
  // and none of them checked. Same "Forbidden" as a non-member: a suspended
  // account is not entitled to a more informative answer.
  if (!(await isActiveUser(ctx, userId))) throw new ConvexError("Forbidden");
  // A membership row does not prove the workspace exists: an account-deletion
  // sweep used to delete the workspace while rows pointing at it survived, and
  // an orphan invite could then recreate membership against nothing (audit
  // F-12). A missing or deleting workspace grants nothing.
  const ws = await ctx.db.get(workspaceId);
  if (!ws || ws.deletingAt !== undefined) throw new ConvexError("Forbidden");
  const m = await membership(ctx, userId, workspaceId);
  if (!m || !roles.includes(m.role as Role)) throw new ConvexError("Forbidden");
  return m;
}

/**
 * Non-throwing CURRENT-entitlement check, for read paths that must degrade to
 * "nothing" rather than throw (a thrown query logs a console.error, which every
 * e2e run fails on). Same predicate as requireMember - one definition, so a
 * list endpoint cannot drift from its detail endpoint again (audit F-08).
 */
export async function hasWorkspaceAccess(
  ctx: QueryCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
): Promise<boolean> {
  try {
    await requireMember(ctx, userId, workspaceId);
    return true;
  } catch {
    return false;
  }
}

export async function requireMember(
  ctx: QueryCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
) {
  return requireRole(ctx, userId, workspaceId, ["owner", "admin", "member"]);
}

async function createWorkspaceImpl(
  ctx: MutationCtx,
  userId: Id<"users">,
  name: string,
) {
  const now = Date.now();
  const workspaceId = await ctx.db.insert("workspaces", {
    name,
    ownerId: userId,
    createdAt: now,
  });
  await ctx.db.insert("members", {
    workspaceId,
    userId,
    role: "owner",
    createdAt: now,
  });
  await audit(ctx, workspaceId, userId, "workspace.create", { name });
  await bump(ctx, workspaceId, "members", 1);
  return workspaceId;
}

export const createWorkspace = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const userId = await activeUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return createWorkspaceImpl(ctx, userId, name);
  },
});

export const createWorkspaceForUser = internalMutation({
  args: { userId: v.id("users"), name: v.string() },
  handler: async (ctx, { userId, name }) => {
    requireDevSeed();
    return createWorkspaceImpl(ctx, userId, name);
  },
});

export const ensureWorkspace = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await activeUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const existing = await ctx.db
      .query("members")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) return existing.workspaceId;
    return createWorkspaceImpl(ctx, userId, "Personal");
  },
});

export const myWorkspaces = query({
  args: {},
  handler: async (ctx) => {
    const userId = await activeUserId(ctx);
    if (!userId) return [];
    const mems = await ctx.db
      .query("members")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    // Parallel, not sequential: this query is subscribed on every page in the
    // app, and each membership was costing a serialised round trip.
    const rows = await Promise.all(
      mems.map(async (m) => {
        const ws = await ctx.db.get(m.workspaceId);
        return ws && ws.deletingAt === undefined ? { ...ws, role: m.role } : null;
      }),
    );
    return rows.filter((w) => w !== null);
  },
});

export const members = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await activeUserId(ctx);
    if (!userId) return [];
    await requireMember(ctx, userId, workspaceId);
    const mems = await ctx.db
      .query("members")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const out = [];
    for (const m of mems) {
      const u = await ctx.db.get(m.userId);
      out.push({
        _id: m._id,
        role: m.role,
        email: u?.email,
        name: u?.name ?? u?.username,
      });
    }
    return out;
  },
});

// --- Invites ---

export const invite = mutation({
  args: { workspaceId: v.id("workspaces"), email: v.string(), role: v.string() },
  handler: async (ctx, { workspaceId, email, role }) => {
    const userId = await activeUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await requireRole(ctx, userId, workspaceId, ["owner", "admin"]);
    assertAssignableRole(role);
    const address = email.toLowerCase();
    const invitee = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", address))
      .unique();
    // An invitation to someone who is ALREADY a member is never needed, and it
    // is exactly the grant that outlives their removal and lets them walk back
    // in (audit F-11) - including an admin's self-invite. Refuse it.
    if (invitee && (await membership(ctx, invitee._id, workspaceId))) {
      throw new ConvexError("Already a member of this workspace");
    }
    // One pending grant per address: a re-invite refreshes it rather than
    // stacking a second one that would survive the first being revoked.
    const pending = await ctx.db
      .query("invites")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .filter((q) =>
        q.and(q.eq(q.field("email"), address), q.eq(q.field("accepted"), false)),
      )
      .first();
    let id: Id<"invites">;
    if (pending) {
      await ctx.db.patch(pending._id, {
        role,
        invitedBy: userId,
        createdAt: Date.now(),
      });
      id = pending._id;
    } else {
      id = await ctx.db.insert("invites", {
        workspaceId,
        email: address,
        role,
        invitedBy: userId,
        accepted: false,
        createdAt: Date.now(),
      });
    }
    await audit(ctx, workspaceId, userId, "member.invite", {
      email: address,
      role,
    });
    if (invitee) {
      await notify(
        ctx,
        invitee._id,
        "invite",
        "Workspace invitation",
        `You were invited as ${role}`,
        // Re-inviting the same person must not stack duplicate rows. There is
        // no accept surface in the app yet, so this carries no deep link.
        { dedupeKey: `invite:${workspaceId}:${invitee._id}` },
      );
    }
    return id;
  },
});

export const inviteForUser = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    invitedBy: v.id("users"),
    email: v.string(),
    role: v.string(),
  },
  handler: async (ctx, a) => {
    requireDevSeed();
    return ctx.db.insert("invites", {
      workspaceId: a.workspaceId,
      email: a.email.toLowerCase(),
      role: a.role,
      invitedBy: a.invitedBy,
      accepted: false,
      createdAt: Date.now(),
    });
  },
});

/** Pending invites for a workspace (admin view). */
export const pendingInvites = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await activeUserId(ctx);
    if (!userId) return [];
    await requireRole(ctx, userId, workspaceId, ["owner", "admin"]);
    return ctx.db
      .query("invites")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .filter((q) => q.eq(q.field("accepted"), false))
      .collect();
  },
});

/** Pending invites addressed to the signed-in user's email. */
export const myInvites = query({
  args: {},
  handler: async (ctx) => {
    const userId = await activeUserId(ctx);
    if (!userId) return [];
    const u = await ctx.db.get(userId);
    if (!u?.email) return [];
    const invs = await ctx.db
      .query("invites")
      .withIndex("by_email", (q) =>
        q.eq("email", (u.email as string).toLowerCase()),
      )
      .filter((q) => q.eq(q.field("accepted"), false))
      .collect();
    const out = [];
    for (const inv of invs) {
      // Only grants that acceptInvite would honour - never a dead one.
      if (!(await inviteIsLive(ctx, inv))) continue;
      const ws = await ctx.db.get(inv.workspaceId);
      out.push({
        _id: inv._id,
        role: inv.role,
        workspaceId: inv.workspaceId,
        workspaceName: ws?.name,
      });
    }
    return out;
  },
});

/**
 * Would this invitation still grant anything? (audit F-11/F-12)
 *
 * A grant is only as good as the state it was issued in. It dies with time
 * (INVITE_TTL_MS), with its workspace (missing or being deleted), and with its
 * ISSUER's authority: an invite from someone who has since been removed,
 * demoted, suspended or deleted confers nothing - which is also what stops a
 * pre-removal self-invite, or an orphan invite surviving an account-deletion
 * sweep, from restoring access.
 */
async function inviteIsLive(
  ctx: QueryCtx,
  inv: Doc<"invites">,
): Promise<boolean> {
  if (inv.accepted) return false;
  if (Date.now() - inv.createdAt > INVITE_TTL_MS) return false;
  const ws = await ctx.db.get(inv.workspaceId);
  if (!ws || ws.deletingAt !== undefined) return false;
  if (!(await isActiveUser(ctx, inv.invitedBy))) return false;
  const issuer = await membership(ctx, inv.invitedBy, inv.workspaceId);
  return issuer !== null && (issuer.role === "owner" || issuer.role === "admin");
}

async function acceptInviteImpl(
  ctx: MutationCtx,
  userId: Id<"users">,
  inviteId: Id<"invites">,
) {
  const inv = await ctx.db.get(inviteId);
  if (!inv || inv.accepted) throw new Error("Invite not found");
  // Fail closed on a role this system may not confer, including one stored by
  // an older build that had no issuance check.
  assertAssignableRole(inv.role);
  // Same answer for expired, orphaned and issuer-revoked: not an oracle.
  if (!(await inviteIsLive(ctx, inv))) throw new ConvexError("Invite not found");
  const existing = await membership(ctx, userId, inv.workspaceId);
  if (!existing) {
    await ctx.db.insert("members", {
      workspaceId: inv.workspaceId,
      userId,
      role: inv.role,
      createdAt: Date.now(),
    });
    await bump(ctx, inv.workspaceId, "members", 1);
  }
  await ctx.db.patch(inviteId, { accepted: true });
  await audit(ctx, inv.workspaceId, userId, "member.join", { role: inv.role });
  return inv.workspaceId;
}

export const acceptInvite = mutation({
  args: { inviteId: v.id("invites") },
  handler: async (ctx, { inviteId }) => {
    const userId = await activeUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const inv = await ctx.db.get(inviteId);
    const u = await ctx.db.get(userId);
    if (!inv) throw new ConvexError("Invite not found");
    if (inv.email && u?.email && inv.email.toLowerCase() !== u.email.toLowerCase()) {
      throw new ConvexError("Invite not for you");
    }
    return acceptInviteImpl(ctx, userId, inviteId);
  },
});

export const acceptInviteForUser = internalMutation({
  args: { inviteId: v.id("invites"), userId: v.id("users") },
  handler: async (ctx, { inviteId, userId }) => {
    requireDevSeed();
    return acceptInviteImpl(ctx, userId, inviteId);
  },
});

export const removeMember = mutation({
  args: { workspaceId: v.id("workspaces"), memberId: v.id("members") },
  handler: async (ctx, { workspaceId, memberId }) => {
    const userId = await activeUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");
    await requireRole(ctx, userId, workspaceId, ["owner", "admin"]);
    const m = await ctx.db.get(memberId);
    if (!m || m.workspaceId !== workspaceId) throw new ConvexError("Not found");
    if (m.role === "owner") throw new ConvexError("Cannot remove the owner");
    await ctx.db.delete(memberId);
    await revokeGrantsOnRemoval(ctx, workspaceId, m.userId);
    await bump(ctx, workspaceId, "members", -1);
    await audit(ctx, workspaceId, userId, "member.remove", { member: m.userId });
  },
});

/**
 * Removal is a revocation boundary, so it takes every standing grant with it,
 * in the same transaction (audit F-08/F-11):
 *   - pending invitations ADDRESSED to the removed person - the duplicate or
 *     self-invite that would otherwise let them accept their way back in;
 *   - pending invitations ISSUED by them - their authority ends here;
 *   - their API keys for this workspace - a credential must not outlive the
 *     membership it speaks for (resolveByHash also re-checks, independently).
 */
async function revokeGrantsOnRemoval(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  removedUserId: Id<"users">,
): Promise<void> {
  const removed = await ctx.db.get(removedUserId);
  const address = removed?.email?.toLowerCase();
  const invites = await ctx.db
    .query("invites")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const inv of invites) {
    if (inv.accepted) continue;
    const addressedToThem = address !== undefined && inv.email === address;
    if (addressedToThem || inv.invitedBy === removedUserId) {
      await ctx.db.delete(inv._id);
    }
  }
  const keys = await ctx.db
    .query("apiKeys")
    .withIndex("by_user", (q) => q.eq("userId", removedUserId))
    .collect();
  for (const k of keys) {
    if (k.workspaceId === workspaceId && !k.revoked) {
      await ctx.db.patch(k._id, { revoked: true });
    }
  }
}

export const changeRole = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    memberId: v.id("members"),
    role: v.string(),
  },
  handler: async (ctx, { workspaceId, memberId, role }) => {
    const userId = await activeUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");
    await requireRole(ctx, userId, workspaceId, ["owner", "admin"]);
    assertAssignableRole(role);
    const m = await ctx.db.get(memberId);
    if (!m || m.workspaceId !== workspaceId) throw new ConvexError("Not found");
    if (m.role === "owner") throw new ConvexError("Cannot change the owner's role");
    await ctx.db.patch(memberId, { role });
    await audit(ctx, workspaceId, userId, "member.role", { member: m.userId, role });
  },
});
