import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { action } from "../_generated/server";

/**
 * MCP OAuth — the browser's three verbs: start, status, disconnect.
 *
 * WHAT THIS FILE IS. A tenancy gate in front of the Python plane's OAuth
 * routes, and nothing else. The protocol itself — discovery, PKCE, the token
 * exchange, refresh, rotation — is the official MCP SDK's, running in Python.
 * There is deliberately no second OAuth implementation here.
 *
 * THE ONE THING IT MUST GET RIGHT: `user_id` and `workspace_id` come from the
 * SESSION, never from the caller's arguments. The Python routes sit behind
 * `require_service_key` and trust whatever tenant they are told, which is safe
 * ONLY because this file resolves the tenant itself and re-checks ownership of
 * the connection first. An argument-supplied user id here would hand any
 * signed-in user someone else's credential.
 *
 * NOT `"use node"`, for the same measured reason as `mcp/connections.ts`: a
 * Node-runtime action calling `ctx.runQuery` fails on this self-hosted Convex
 * 1.19 with "Transient error while running query". The default V8 runtime has
 * both `fetch` and `runQuery`.
 *
 * NOTHING CREDENTIAL-SHAPED CROSSES THIS FILE. The only value that reaches the
 * browser is the authorization URL, which is public by construction — its PKCE
 * value is a hash and its `state` is a routing token. No response below can
 * carry an access token, a refresh token, a client secret, an authorization
 * code or a PKCE verifier, because the Python routes never return one.
 */

/** The states Phase 7 renders. Frozen here so the UI has one vocabulary. */
const UNCONFIGURED = {
  auth_state: "ERROR",
  detail: "the AI service is not configured",
} as const;

type Tenant = {
  userId: Id<"users">;
  workspaceId: Id<"workspaces">;
  serverName: string;
  version: string | null;
};

/**
 * Resolve the caller and the connection they own, or throw "Not found".
 *
 * Same refusal for "no such connection" and "somebody else's connection": the
 * error must not become an existence oracle, exactly as in `connections.ts`.
 */
async function tenantFor(
  ctx: ActionCtx,
  connectionId: Id<"mcpConnections">,
): Promise<Tenant> {
  // Live session + active account, via the one helper every other surface
  // uses. The subject alone is a bare cast that a revoked session still carries.
  const userId: Id<"users"> | null = await ctx.runQuery(
    internal.accountState.activeCallerId,
    {},
  );
  if (userId === null) throw new ConvexError("Not authenticated");

  const row = await ctx.runQuery(internal.mcp.connections.resolveForOperation, {
    connectionId,
    userId,
  });
  if (!row) throw new ConvexError("Not found");

  return {
    userId,
    workspaceId: row.workspaceId,
    serverName: row.serverName,
    version: row.versionMode === "pinned" ? row.version : null,
  };
}

/**
 * POST one of the Python OAuth routes.
 *
 * RETURNS A REPORT, NEVER THROWS ON A REMOTE FAILURE — the same rule as
 * `runOperation` in `connections.ts`. A provider being down is information the
 * UI must render, not an exception that logs a `console.error` and fails every
 * e2e script.
 */
async function callPlane(
  route: "start" | "status" | "disconnect",
  connectionId: Id<"mcpConnections">,
  tenant: Tenant,
): Promise<Record<string, unknown>> {
  const base = process.env.AI_BASE_URL;
  const key = process.env.AI_SERVICE_KEY;
  if (!base || !key) return { ...UNCONFIGURED };

  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/v1/mcp/oauth/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-key": key },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        connection_id: connectionId,
        server_name: tenant.serverName,
        user_id: tenant.userId,
        workspace_id: tenant.workspaceId,
        version: tenant.version,
      }),
    });
    if (!res.ok) {
      // 503 is the vault or the flag being off — a deployment state, not a
      // user error, and it must read differently from a provider refusal.
      return {
        auth_state: "ERROR",
        detail:
          res.status === 503
            ? "authorization is not available on this deployment"
            : `the AI service answered ${res.status}`,
      };
    }
    return (await res.json()) as Record<string, unknown>;
  } catch {
    // Never echo the exception: it can carry an internal hostname.
    return { auth_state: "ERROR", detail: "the AI service could not be reached" };
  }
}

export const start = action({
  args: { connectionId: v.id("mcpConnections") },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const tenant = await tenantFor(ctx, args.connectionId);
    // TIGHTEST OF THE THREE WINDOWS, and charged after ownership. A loop here
    // is visible to the PROVIDER as abuse of our client, and their remedy is to
    // block it for every user of this deployment — not just the one looping.
    await ctx.runMutation(internal.mcp.limits.consume, { kind: "mcpAuth" });
    const report = await callPlane("start", args.connectionId, tenant);

    // AUTHORIZING, not "ready": a URL was minted, nothing has been granted. The
    // connection row records that an authorization is in flight so a refresh of
    // the page does not present the connection as simply broken.
    if (typeof report.authorization_url === "string") {
      await ctx.runMutation(internal.mcp.connections.recordOutcome, {
        connectionId: args.connectionId,
        status: "configured",
        lastError: undefined,
        lastErrorKind: undefined,
        userActionRequired: true,
      });
      await ctx.runMutation(internal.mcp.audit.record, {
        connectionId: args.connectionId,
        action: "mcp.oauth_started",
      });
    } else {
      // A start that minted no URL is a failure the operator needs to see: it
      // means discovery, registration or the deployment guard refused.
      await ctx.runMutation(internal.mcp.audit.record, {
        connectionId: args.connectionId,
        action: "mcp.oauth_failed",
        status: typeof report.auth_state === "string" ? report.auth_state : undefined,
      });
    }
    return report;
  },
});

export const status = action({
  args: { connectionId: v.id("mcpConnections") },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const tenant = await tenantFor(ctx, args.connectionId);
    return await callPlane("status", args.connectionId, tenant);
  },
});

export const disconnect = action({
  args: { connectionId: v.id("mcpConnections") },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const tenant = await tenantFor(ctx, args.connectionId);
    const report = await callPlane("disconnect", args.connectionId, tenant);

    // FAIL CLOSED (audit H-04). Only once the plane has CONFIRMED the live
    // session is gone does the row change: the credential rows are purged, the
    // connection is marked disconnected and the audit line is written — in ONE
    // mutation, so there is no state in which the UI says "disconnected" while
    // a session is still open and a refresh can still land. An earlier version
    // marked the row disconnected whatever the plane said, which is exactly the
    // half-closed state a late refresh resurrected. A plane that could not be
    // reached leaves the row as it was and tells the user so.
    if (report.session_discarded !== true) {
      return {
        ok: false,
        auth_state: "ERROR",
        detail:
          typeof report.detail === "string"
            ? report.detail
            : "the connector could not be disconnected; try again",
      };
    }
    // THE most important line in the MCP audit trail: this is the event an
    // incident review reads to establish when OllaSuper's access to somebody's
    // provider account was withdrawn. `revoked_remotely` distinguishes "the
    // provider accepted the revocation" from "we deleted our copy"; both are
    // recorded, because only one of them is under our control.
    await ctx.runMutation(internal.mcp.connections.completeDisconnect, {
      connectionId: args.connectionId,
      userId: tenant.userId,
      revokedRemotely: report.revoked_remotely === true,
    });
    return { ...report, ok: true, deleted_locally: true };
  },
});
