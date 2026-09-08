import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

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
