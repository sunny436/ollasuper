import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { audit } from "../auditLog";
import { getUserIdOrNull, requireUserId } from "../chat/authz";
import { requireMember } from "../orgs";
import { consumeWindow } from "../quotas";
import { auditRemoval } from "./audit";
// `clamp` MOVED to ./text to break the cycle this file now has with
// ./audit. Re-exported so `catalogue.ts`, which already imports it from
// here, is unchanged by the move.
import { clamp } from "./text";

export { clamp } from "./text";
import {
  type CredentialStatus,
  credentialStatusFor,
  purgeCredentialsForConnection,
} from "./credentials";

/**
 * MCP connections — the control plane for "which curated MCP server may this
 * user reach, and is it working right now?".
 *
 * WHY THIS LIVES IN CONVEX AT ALL. The AI plane owns the MCP protocol; Convex
 * owns tenancy, authorization and reactive transport. A connection record is
 * pure tenancy: who owns it, in which workspace, at which version, in what
 * state. Putting it beside the catalogue in Postgres would mean rebuilding
 * `requireUserId` + `requireMember` there, and Phase 7's UI would have to poll
 * instead of subscribing.
 *
 * THE TRUST MODEL IS CHAT'S. A connection is a personal account — someone's
 * GitHub, their mailbox — so a same-workspace peer is refused, and every
 * non-owner gets "Not found" rather than "Forbidden": the error must not become
 * an existence oracle for somebody else's connection id. `workspaceId` is
 * carried for tenancy and checked with requireMember, but it is never the read
 * boundary.
 *
 * NOT `"use node"`, DELIBERATELY. A Node-runtime action calling `ctx.runQuery`
 * fails on this self-hosted Convex 1.19 with "Transient error while running
 * query" — measured on production during the D-series work. The default V8
 * runtime supports `fetch` AND `runQuery`/`runMutation`, which is the pattern
 * `chat/models.ts` already runs in production. So the actions below live here,
 * in the same default-runtime module as the queries they depend on.
 *
 * WHAT NEVER APPEARS IN THIS FILE: a token, an API key, an Authorization
 * header. Phase 4 owns credentials, in a vault keyed per user. The Python plane
 * attaches them at connect time; nothing credential-shaped crosses this
 * boundary in either direction.
 */

/** Bounded so a hostile server's error text cannot bloat a row the UI renders. */
const MAX_ERROR_CHARS = 400;
const MAX_CAPABILITIES_CHARS = 4000;
/** How many tool names a row may carry, and how long each may be. A server can
 *  advertise up to 256 tools; storing them all would put ~15KB of third-party
 *  strings on a row. `toolCount` keeps the true total, so the UI can say "and
 *  N more" rather than under-reporting. */
const MAX_TOOL_NAMES = 64;
const MAX_TOOL_NAME_CHARS = 80;

type ConnectionStatus = Doc<"mcpConnections">["status"];

const STATUS = v.union(
  v.literal("configured"),
  v.literal("ready"),
  v.literal("degraded"),
  v.literal("failed"),
  v.literal("disconnected"),
  v.literal("unsupported"),
);

const TRANSPORT = v.union(v.literal("streamable-http"), v.literal("sse"));


/**
 * Load a connection the CALLER owns, or throw "Not found".
 *
 * One helper, used by every path, so there is exactly one place where the
 * ownership rule lives. Returning the same error for "does not exist" and
 * "belongs to someone else" is what stops a caller probing for other people's
 * connection ids.
 */
async function ownedConnection(
  ctx: { db: { get: (id: Id<"mcpConnections">) => Promise<Doc<"mcpConnections"> | null> } },
  userId: Id<"users">,
  connectionId: Id<"mcpConnections">,
): Promise<Doc<"mcpConnections">> {
  const row = await ctx.db.get(connectionId);
  if (!row || row.userId !== userId) throw new ConvexError("Not found");
  return row;
}

// ----------------------------------------------------------------- queries
export const list = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args): Promise<Doc<"mcpConnections">[]> => {
    // Soft for a signed-out read, matching files.listPaged: a logged-out render
    // returns nothing rather than throwing, because every e2e script fails on a
    // console.error.
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("mcpConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    if (!args.workspaceId) return rows;
    return rows.filter((r) => r.workspaceId === args.workspaceId);
  },
});

/**
 * The same list, each row carrying its credential's auth state.
 *
 * A SEPARATE QUERY rather than a field added to `list`. Phase 7 needs "is this
 * connected?" for every row at once, and doing it with one `statusForConnection`
 * per connection would be N subscriptions. `list` keeps its exact shape so
 * nothing already reading it changes behaviour.
 *
 * The projection is `credentialStatusFor`'s, so it cannot disagree with
 * `statusForConnection`, and it carries no `envelope` and no `keyVersion`.
 */
export const listWithAuth = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (
    ctx,
    args,
  ): Promise<(Doc<"mcpConnections"> & { auth: CredentialStatus })[]> => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("mcpConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const scoped = args.workspaceId
      ? rows.filter((r) => r.workspaceId === args.workspaceId)
      : rows;
    // Ownership is already established by the index above: every row here
    // belongs to the caller, which is what lets `credentialStatusFor` skip its
    // own check.
    return await Promise.all(
      scoped.map(async ({ toolNames: _toolNames, ...row }) => ({
        // `toolNames` IS DROPPED HERE, on purpose. This is a list query, and
        // Convex re-sends its whole result to every subscriber on any write —
        // so carrying up to 64 names per row across 30 rows would make every
        // connection status change re-transmit ~100KB. The detail page reads
        // one row through `get`, which is where the names belong.
        ...row,
        auth: await credentialStatusFor(ctx, row._id),
      })),
    );
  },
});

export const get = query({
  args: { connectionId: v.id("mcpConnections") },
  handler: async (ctx, args): Promise<Doc<"mcpConnections"> | null> => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return null;
    const row = await ctx.db.get(args.connectionId);
    // Null, not a throw: a query that threw would log a console.error in a
    // legitimately-racing UI (a connection deleted in another tab).
    return row && row.userId === userId ? row : null;
  },
});

// --------------------------------------------------------------- mutations
export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    serverName: v.string(),
    slug: v.string(),
    version: v.string(),
    versionMode: v.union(v.literal("pinned"), v.literal("latest_at_connect")),
    transport: TRANSPORT,
    authKind: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"mcpConnections">> => {
    const userId = await requireUserId(ctx);
    // Inline rather than through `mcp/limits.ts`: this is already a mutation,
    // so it holds the ctx `consumeWindow` needs and the hop would be noise.
    const gate = await consumeWindow(ctx, userId, "mcpConnect", 60, 60 * 60 * 1000);
    if (!gate.ok) {
      const mins = Math.ceil(gate.retryInMs / 60_000);
      throw new ConvexError(
        `Too many connection attempts — try again in ${mins} minute${mins === 1 ? "" : "s"}`,
      );
    }
    // Workspace membership is checked even though the READ boundary is the
    // user: a connection is billed and audited against a workspace, so creating
    // one inside a workspace you are not a member of must fail.
    await requireMember(ctx, userId, args.workspaceId);

    // One connection per (user, server). A second row for the same server would
    // give the pool two keys for one account and make "disconnect" ambiguous.
    const existing = await ctx.db
      .query("mcpConnections")
      .withIndex("by_user_server", (q) =>
        q.eq("userId", userId).eq("serverName", args.serverName),
      )
      .first();
    if (existing) return existing._id;

    const now = Date.now();
    const connectionId = await ctx.db.insert("mcpConnections", {
      userId,
      workspaceId: args.workspaceId,
      serverName: args.serverName,
      slug: args.slug,
      version: args.version,
      versionMode: args.versionMode,
      transport: args.transport,
      authKind: args.authKind,
      // CONFIGURED, never "ready": a row exists, nothing has been contacted.
      status: "configured",
      createdAt: now,
      updatedAt: now,
    });
    // A mutation already holds the verified tenant, so it audits directly —
    // no `ctx.runMutation` hop (see mcp/audit.ts).
    await audit(ctx, args.workspaceId, userId, "mcp.connection_created", {
      serverName: clamp(args.serverName, 200),
      slug: clamp(args.slug, 200),
    });
    return connectionId;
  },
});

export const remove = mutation({
  args: { connectionId: v.id("mcpConnections") },
  handler: async (ctx, args): Promise<null> => {
    const userId = await requireUserId(ctx);
    const row = await ownedConnection(ctx, userId, args.connectionId);
    // AUDITED BEFORE THE DELETE. Written afterwards there would be no row left
    // to attribute the event to, and the removal of a connection is precisely
    // the event an incident review needs.
    await auditRemoval(ctx, row.workspaceId, userId, row);
    // CREDENTIALS FIRST, in the same transaction. A secret must not outlive the
    // thing it authorizes: deleting the connection alone would leave an
    // encrypted token row with nothing pointing at it and no owner-checked path
    // left to reach or remove it.
    //
    // This does NOT revoke at the provider — only `oauth.disconnect` can do
    // that, and it says so separately. Deleting the local copy is strictly
    // better than keeping it, so a remove still runs when revocation cannot.
    await purgeCredentialsForConnection(ctx, args.connectionId);
    await ctx.db.delete(args.connectionId);
    return null;
  },
});

/**
 * Resolve a connection for an ACTION, having re-checked ownership.
 *
 * Internal, and it exists so the action never trusts anything the client sent
 * beyond the connection id — the user id and workspace id it forwards to the
 * Python plane come from the session, through here.
 */
export const resolveForOperation = internalQuery({
  args: { connectionId: v.id("mcpConnections"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (!row || row.userId !== args.userId) return null;
    return row;
  },
});

export const recordOutcome = internalMutation({
  args: {
    connectionId: v.id("mcpConnections"),
    status: STATUS,
    version: v.optional(v.string()),
    lastError: v.optional(v.string()),
    lastErrorKind: v.optional(v.string()),
    userActionRequired: v.optional(v.boolean()),
    capabilities: v.optional(v.string()),
    toolCount: v.optional(v.number()),
    toolNames: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.connectionId);
    if (!row) return null; // deleted mid-operation; nothing to record
    const now = Date.now();
    const ready = args.status === "ready";
    await ctx.db.patch(args.connectionId, {
      status: args.status,
      // The version actually used is written down, so a later catalogue change
      // cannot retroactively rewrite what this connection ran against.
      ...(args.version ? { version: args.version } : {}),
      ...(ready ? { lastConnectedAt: now } : {}),
      ...(args.status === "failed" ? { lastFailureAt: now } : {}),
      // Cleared on success rather than left behind: a stale error next to a
      // working connection is worse than no error.
      lastError: ready ? undefined : clamp(args.lastError, MAX_ERROR_CHARS),
      lastErrorKind: ready ? undefined : args.lastErrorKind,
      userActionRequired: ready ? undefined : args.userActionRequired,
      ...(args.capabilities !== undefined
        ? {
            capabilities: clamp(args.capabilities, MAX_CAPABILITIES_CHARS),
            capabilitiesAt: now,
          }
        : {}),
      ...(args.toolCount !== undefined ? { toolCount: args.toolCount } : {}),
      ...(args.toolNames !== undefined
        ? {
            // Bounded on BOTH axes, and `clamp` strips control characters:
            // these are names a third-party server chose, rendered in a browser
            // and written to logs.
            toolNames: args.toolNames
              .slice(0, MAX_TOOL_NAMES)
              .map((n) => clamp(n, MAX_TOOL_NAME_CHARS) ?? "")
              .filter((n) => n.length > 0),
          }
        : {}),
      updatedAt: now,
    });
    return null;
  },
});

// ----------------------------------------------------------------- actions
type Operation = "connect" | "refresh" | "disconnect";

/**
 * Call the AI plane and record what came back.
 *
 * RETURNS A REPORT, NEVER THROWS ON A CONNECTION FAILURE. A server being down,
 * or a token being rejected, is information the UI must render — not an
 * exception that logs a console.error and fails every e2e script.
 */
async function runOperation(
  ctx: ActionCtx,
  operation: Operation,
  connectionId: Id<"mcpConnections">,
): Promise<Record<string, unknown>> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new ConvexError("Not authenticated");
  // `subject` is "<userId>|<sessionId>"; the user id is the part before the
  // separator, matching how getAuthUserId derives it.
  const userId = String(identity.subject).split("|")[0] as Id<"users">;

  const row = await ctx.runQuery(internal.mcp.connections.resolveForOperation, {
    connectionId,
    userId,
  });
  // Same error as a non-existent id: no existence oracle.
  if (!row) throw new ConvexError("Not found");

  // RATE LIMIT AFTER OWNERSHIP, before the network call. Ownership first so a
  // caller probing somebody else's connection id cannot spend that victim's
  // window; before the call because the window exists to bound outbound
  // traffic, and charging it afterwards would let a burst through.
  //
  // `disconnect` is deliberately NOT limited: it is how a user stops a
  // connection they are worried about, and rate-limiting the off switch is the
  // wrong failure direction.
  if (operation !== "disconnect") {
    await ctx.runMutation(internal.mcp.limits.consume, { kind: "mcpConnect" });
  }

  const base = process.env.AI_BASE_URL;
  const key = process.env.AI_SERVICE_KEY;
  if (!base || !key) {
    return { state: row.status, error_detail: "the AI service is not configured" };
  }

  const body = {
    connection_id: connectionId,
    server_name: row.serverName,
    user_id: userId,
    workspace_id: row.workspaceId,
    version: row.versionMode === "pinned" ? row.version : null,
  };

  let report: Record<string, unknown>;
  try {
    const res = await fetch(
      `${base.replace(/\/$/, "")}/v1/mcp/connections/${connectionId}/${operation}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-service-key": key },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      report = {
        state: "failed",
        error_kind: "unreachable",
        error_detail: `the AI service answered ${res.status}`,
      };
    } else {
      report = (await res.json()) as Record<string, unknown>;
    }
  } catch {
    // Never echo the exception: it can carry an internal hostname.
    report = {
      state: "failed",
      error_kind: "unreachable",
      error_detail: "the AI service could not be reached",
    };
  }

  const status = String(report.state ?? "failed") as ConnectionStatus;
  // AUDIT THE OUTCOME, not the attempt. `recordOutcome` runs first so the row
  // already holds the state this event reports — an audit line that disagreed
  // with the row it describes would be worse than none.
  await ctx.runMutation(internal.mcp.connections.recordOutcome, {
    connectionId,
    status,
    version: typeof report.version === "string" ? report.version : undefined,
    lastError:
      typeof report.error_detail === "string" ? report.error_detail : undefined,
    lastErrorKind:
      typeof report.error_kind === "string" ? report.error_kind : undefined,
    userActionRequired:
      typeof report.user_action_required === "boolean"
        ? report.user_action_required
        : undefined,
    capabilities: report.capabilities
      ? JSON.stringify(report.capabilities).slice(0, MAX_CAPABILITIES_CHARS)
      : undefined,
    toolCount:
      typeof report.tool_count === "number" ? report.tool_count : undefined,
    // `ConnectionReport.tools` has always carried these; they were computed on
    // every connect and dropped here, which left the UI with a number and no
    // way to say what the number was made of.
    toolNames: Array.isArray(report.tools)
      ? report.tools.filter((t): t is string => typeof t === "string")
      : undefined,
  });

  await ctx.runMutation(internal.mcp.audit.record, {
    connectionId,
    action:
      operation === "disconnect"
        ? "mcp.disconnected"
        : status === "ready"
          ? operation === "refresh"
            ? "mcp.refreshed"
            : "mcp.connected"
          : "mcp.connect_failed",
    status,
    errorKind:
      typeof report.error_kind === "string" ? report.error_kind : undefined,
    toolCount:
      typeof report.tool_count === "number" ? report.tool_count : undefined,
  });
  return report;
}

export const connect = action({
  args: { connectionId: v.id("mcpConnections") },
  handler: async (ctx, args): Promise<Record<string, unknown>> =>
    runOperation(ctx, "connect", args.connectionId),
});

export const refresh = action({
  args: { connectionId: v.id("mcpConnections") },
  handler: async (ctx, args): Promise<Record<string, unknown>> =>
    runOperation(ctx, "refresh", args.connectionId),
});

export const disconnect = action({
  args: { connectionId: v.id("mcpConnections") },
  handler: async (ctx, args): Promise<Record<string, unknown>> =>
    runOperation(ctx, "disconnect", args.connectionId),
});
