import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { audit } from "../auditLog";
import { clamp } from "./text";

/**
 * The MCP security trail.
 *
 * WHY THIS FILE HAD TO EXIST. `auditLog.ts::audit` is used by files, api keys
 * and orgs — and `grep "audit(" convex/mcp/` returned NOTHING. Connecting a
 * third-party server, authorizing it with someone's provider account, and
 * revoking that authorization all left no record at all. Those are exactly the
 * events an operator needs after an incident, and they are the ones this
 * program has spent six phases making safe.
 *
 * WHY NOT `audit.ts::record`. That internal entry point is gated by
 * `requireDevSeed()` — it exists for automation and testing, and calling it
 * from a production path would either fail or require weakening that guard.
 *
 * WHY A HOP AT ALL. `audit()` takes a `MutationCtx`, and MCP's lifecycle
 * surfaces are ACTIONS (they make HTTP calls to the Python plane). An action
 * reaches a mutation through `ctx.runMutation`, so this is the seam. Mutations
 * that already have a `MutationCtx` — `connections.create` and
 * `connections.remove` — call `audit()` directly and do not come through here.
 *
 * THE TENANT IS DERIVED FROM THE ROW, NEVER PASSED IN. An internal mutation is
 * reachable by any action in this deployment, so accepting a caller-supplied
 * `userId` would make the audit trail forgeable by the one class of code most
 * likely to be wrong about identity. The connection id is the only argument
 * that matters and `ctx.db.get` resolves the rest.
 *
 * WHAT NEVER REACHES `meta`: a token, a refresh token, an `Authorization`
 * header, a client secret, an authorization URL (it carries `state`), a
 * `code_verifier`, or a resource body. The fields below are an ALLOWLIST for
 * that reason — a future caller cannot add one by passing it.
 */

/** Bounded the same way `lastError` is: this text originates on a third party's
 *  server and is written to a row an operator reads. */
const MAX_META_CHARS = 200;

/** The vocabulary. Frozen here so a typo cannot silently create a new event
 *  class that no query or alert knows to look for. */
const ACTION = v.union(
  v.literal("mcp.connection_created"),
  v.literal("mcp.connection_removed"),
  v.literal("mcp.connected"),
  v.literal("mcp.connect_failed"),
  v.literal("mcp.disconnected"),
  v.literal("mcp.refreshed"),
  v.literal("mcp.oauth_started"),
  v.literal("mcp.oauth_completed"),
  v.literal("mcp.oauth_failed"),
  v.literal("mcp.credential_revoked"),
);

export const record = internalMutation({
  args: {
    connectionId: v.id("mcpConnections"),
    action: ACTION,
    // An ALLOWLIST, not a free-form object. Each of these is either an
    // OllaSuper-side classification or a public identifier; none can carry a
    // credential even if a caller tried.
    status: v.optional(v.string()),
    errorKind: v.optional(v.string()),
    toolCount: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.connectionId);
    // Deleted mid-operation. Nothing to attribute the event to, and inventing a
    // tenant would be worse than losing one line — `connection_removed` is
    // written by `remove` itself, BEFORE the delete, for exactly this reason.
    if (!row) return null;

    await audit(ctx, row.workspaceId, row.userId, args.action, {
      // The server's public identity, which is what an operator searches by.
      serverName: clamp(row.serverName, MAX_META_CHARS),
      slug: clamp(row.slug, MAX_META_CHARS),
      status: clamp(args.status, MAX_META_CHARS),
      errorKind: clamp(args.errorKind, MAX_META_CHARS),
      toolCount: args.toolCount,
    });
    return null;
  },
});

/**
 * The same event, for a row that is about to stop existing.
 *
 * `connections.remove` deletes the row and its credentials in one transaction,
 * so an audit written afterwards would find nothing to attribute. It is a
 * mutation and already holds the verified tenant, so it calls `audit()`
 * directly — this helper just keeps the shape identical to the one above so
 * both events read the same in the log.
 */
export async function auditRemoval(
  ctx: Parameters<typeof audit>[0],
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  row: { serverName: string; slug: string; status: string },
): Promise<void> {
  await audit(ctx, workspaceId, userId, "mcp.connection_removed", {
    serverName: clamp(row.serverName, MAX_META_CHARS),
    slug: clamp(row.slug, MAX_META_CHARS),
    status: clamp(row.status, MAX_META_CHARS),
  });
}
