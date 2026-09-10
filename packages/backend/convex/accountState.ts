import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";

/**
 * Is this account entitled to act at all?
 *
 * A LEAF module on purpose: `orgs.ts` (workspace trust) and `chat/authz.ts`
 * (user trust) both need this, and chat/authz.ts exists precisely so it does not
 * import orgs.ts. Putting the predicate in a third file that imports neither
 * keeps one definition without reintroducing that cycle.
 *
 * Absent status means active — every pre-migration row predates the column.
 */
export async function isActiveUser(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const user = await ctx.db.get(userId);
  // A token whose user row is gone is NOT active. getAuthUserId is a bare cast
  // of the JWT subject with no database lookup, so a deleted account keeps a
  // usable access token until it expires; deleting its sessions kills the
  // refresh, and this closes the remainder.
  if (!user) return false;
  return !user.accountStatus || user.accountStatus === "active";
}

/**
 * The caller's id, but null unless the account is ACTIVE.
 *
 * The drop-in replacement for a bare `getAuthUserId` in a query or mutation.
 * `getAuthUserId` is a cast of the JWT subject with no lookup, so on its own it
 * cannot tell an active account from a suspended or deleted one: suspension
 * revokes sessions and refresh tokens, but the access token already issued stays
 * valid until it expires (≤1h — see the note in authSessions.heartbeat), and
 * every callsite that only asked `getAuthUserId` kept honouring it for that
 * whole window.
 *
 * Returning NULL rather than throwing is what makes this a safe swap: every
 * such callsite already guards with `if (!userId) …`, so the existing branch —
 * throw here, empty list there — now covers suspended callers too, with no
 * change to any signed-out behaviour and no new console.error.
 *
 * chat/authz.ts has `getUserIdOrNull` with the same semantics, but it is not
 * reachable from orgs.ts: chat/authz.ts imports orgs.ts, so importing it back
 * would recreate the exact cycle that file was split out to avoid. This module
 * imports neither.
 */
export async function activeUserId(
  ctx: QueryCtx,
): Promise<Id<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  return (await isActiveUser(ctx, userId)) ? userId : null;
}

/**
 * The active caller's id, for ACTIONS — which cannot read the database.
 *
 * `getAuthUserId` works inside an action, but it is a bare cast of the JWT
 * subject with no lookup, so on its own it cannot tell an active account from a
 * suspended or deleted one. An action therefore has to hop through a query to
 * ask, exactly as scheduled/parse.ts hops through `gate` for its membership and
 * budget check. This is the read-only half of that pattern, for actions that
 * need identity but write nothing.
 *
 * RETURNS NULL rather than throwing. The two current callers
 * (chat/capabilities.list, skillCapabilities.list) already contract to return
 * null on any failure so their menus degrade to the static list instead of
 * rendering empty; throwing here would turn a signed-out render into a
 * console.error, which every e2e script asserts against.
 */
export const activeCallerId = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"users"> | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return (await isActiveUser(ctx, userId)) ? userId : null;
  },
});
