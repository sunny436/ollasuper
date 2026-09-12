import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { action } from "../_generated/server";

/**
 * MCP resources and prompts — the four verbs Phase 7's UI needs.
 *
 * WHY THESE EXIST AND TOOLS HAVE NO EQUIVALENT. A tool reaches the model through
 * the ordinary chat turn, so nothing needs to list them for a browser. Resources
 * and prompts are USER-CHOSEN: somebody has to see what a connection offers
 * before picking one, and a prompt is invoked explicitly rather than by the
 * model. That is the whole reason they are not tools.
 *
 * THE TENANCY RULE IS `mcp/oauth.ts`'s, VERBATIM: `user_id` and `workspace_id`
 * come from the SESSION, never from arguments, and the connection is re-checked
 * against the caller before anything is forwarded. The Python routes sit behind
 * `require_service_key` and trust whatever tenant they are told, which is safe
 * only because this file resolves it.
 *
 * NOT `"use node"`, for the measured reason in `mcp/connections.ts`: a
 * Node-runtime action calling `ctx.runQuery` fails on this self-hosted Convex
 * 1.19 with "Transient error while running query".
 *
 * NOTHING CREDENTIAL-SHAPED CROSSES. A resource body and a prompt's messages are
 * third-party CONTENT, not instructions — the Python plane normalizes prompt
 * messages to user/assistant roles before they get here, and nothing in this
 * file can promote them.
 */

type Tenant = {
  userId: Id<"users">;
  workspaceId: Id<"workspaces">;
  serverName: string;
  version: string | null;
};

async function tenantFor(
  ctx: ActionCtx,
  connectionId: Id<"mcpConnections">,
): Promise<Tenant> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new ConvexError("Not authenticated");
  const userId = String(identity.subject).split("|")[0] as Id<"users">;

  const row = await ctx.runQuery(internal.mcp.connections.resolveForOperation, {
    connectionId,
    userId,
  });
  // Same refusal for "no such connection" and "somebody else's": the error must
  // not become an existence oracle.
  if (!row) throw new ConvexError("Not found");

  return {
    userId,
    workspaceId: row.workspaceId,
    serverName: row.serverName,
    version: row.versionMode === "pinned" ? row.version : null,
  };
}

async function callPlane(
  path: string,
  connectionId: Id<"mcpConnections">,
  tenant: Tenant,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const base = process.env.AI_BASE_URL;
  const key = process.env.AI_SERVICE_KEY;
  if (!base || !key) {
    return { error: "the AI service is not configured" };
  }

  try {
    const res = await fetch(
      `${base.replace(/\/$/, "")}/v1/mcp/connections/${connectionId}/${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-service-key": key },
        body: JSON.stringify({
          connection_id: connectionId,
          server_name: tenant.serverName,
          user_id: tenant.userId,
          workspace_id: tenant.workspaceId,
          version: tenant.version,
          ...extra,
        }),
      },
    );
    if (!res.ok) {
      // The Python plane's `detail` is already bounded and classified — a 400
      // naming a missing prompt argument is the whole point of validating there
      // rather than letting the MCP server answer "Internal server error".
      const body = (await res.json().catch(() => ({}))) as { detail?: string };
      return {
        error:
          body.detail ??
          (res.status === 503
            ? "MCP connections are not available on this deployment"
            : `the AI service answered ${res.status}`),
      };
    }
    return (await res.json()) as Record<string, unknown>;
  } catch {
    // Never echo the exception: it can carry an internal hostname.
    return { error: "the AI service could not be reached" };
  }
}

export const resources = action({
  args: { connectionId: v.id("mcpConnections") },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const tenant = await tenantFor(ctx, args.connectionId);
    await ctx.runMutation(internal.mcp.limits.consume, {
      kind: "mcpCapability",
    });
    return await callPlane("resources", args.connectionId, tenant);
  },
});

export const readResource = action({
  args: { connectionId: v.id("mcpConnections"), uri: v.string() },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const tenant = await tenantFor(ctx, args.connectionId);
    await ctx.runMutation(internal.mcp.limits.consume, {
      kind: "mcpCapability",
    });
    // The URI is NOT validated here, deliberately. It is matched against what
    // this connection actually advertised, which only the Python plane knows —
    // and a scheme check here would imply a safety this layer cannot provide.
    return await callPlane("resources/read", args.connectionId, tenant, {
      uri: args.uri,
    });
  },
});

export const prompts = action({
  args: { connectionId: v.id("mcpConnections") },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const tenant = await tenantFor(ctx, args.connectionId);
    await ctx.runMutation(internal.mcp.limits.consume, {
      kind: "mcpCapability",
    });
    return await callPlane("prompts", args.connectionId, tenant);
  },
});

export const getPrompt = action({
  args: {
    connectionId: v.id("mcpConnections"),
    promptName: v.string(),
    // String-valued because that is the protocol: `GetPromptRequest` carries
    // `dict[str, str]`. Validated against the server's own `required` flags in
    // Python, before anything is sent.
    arguments: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const tenant = await tenantFor(ctx, args.connectionId);
    await ctx.runMutation(internal.mcp.limits.consume, {
      kind: "mcpCapability",
    });
    return await callPlane("prompts/get", args.connectionId, tenant, {
      prompt_name: args.promptName,
      arguments: args.arguments ?? {},
    });
  },
});
