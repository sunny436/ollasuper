import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery, query } from "../_generated/server";
import { getUserIdOrNull } from "../chat/authz";

/**
 * MCP credential storage — ciphertext in, ciphertext out.
 *
 * WHAT THIS FILE IS NOT: a place any plaintext secret ever exists. The Python
 * plane encrypts with AES-256-GCM before anything crosses, so every write here
 * carries an `envelope` string and non-secret metadata. There is no code path
 * in this module that could log or return a token, because one never arrives.
 *
 * WHY ENCRYPTION IS NOT ENOUGH ON ITS OWN. Ciphertext protects a leaked backup;
 * it does nothing about an authenticated caller reading somebody else's row. So
 * the reads below are owner-checked exactly like `mcpConnections`, and the only
 * PUBLIC query returns a safe projection with no `envelope` at all. Encryption
 * is defence-in-depth behind that, never a replacement for it.
 *
 * THE WRITES ARE INTERNAL ONLY. They are reached from the `/ai/ingress` handler,
 * which the Python plane calls with `AI_INGRESS_SECRET`. That is the established
 * path for Python-initiated writes (artifacts, SEO runs, scheduled deliveries),
 * and it is necessary here because `TokenStorage.set_tokens` fires deep inside a
 * token refresh, mid-tool-call, with no Convex action in the loop.
 */

/** Bounded so a hostile or malfunctioning server cannot bloat a row. */
const MAX_ENVELOPE_CHARS = 64 * 1024;
const MAX_SCOPE_CHARS = 2000;

const KIND = v.union(
  v.literal("oauth_token"),
  v.literal("api_key"),
  v.literal("bearer"),
);

const STATUS = v.union(
  v.literal("active"),
  v.literal("expired"),
  v.literal("refresh_failed"),
  v.literal("revoked"),
  v.literal("unreadable"),
);

/**
 * The shape the Python plane reads back.
 *
 * Hand-mapped rather than returning the raw document, so a field added to the
 * table later cannot silently start crossing the plane boundary.
 */
function toWire(row: Doc<"mcpCredentials">) {
  return {
    credentialId: row.credentialId,
    userId: row.userId,
    workspaceId: row.workspaceId,
    connectionId: row.connectionId,
    serverName: row.serverName,
    resource: row.resource,
    kind: row.kind,
    envelope: row.envelope,
    keyVersion: row.keyVersion,
    expiresAt: row.expiresAt,
    scope: row.scope,
    status: row.status,
    rev: row.rev,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

// ------------------------------------------------------------------ reads
export const loadCredential = internalQuery({
  args: {
    connectionId: v.id("mcpConnections"),
    resource: v.string(),
    kind: KIND,
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mcpCredentials")
      .withIndex("by_connection_resource", (q) =>
        q
          .eq("connectionId", args.connectionId)
          .eq("resource", args.resource)
          .eq("kind", args.kind),
      )
      .first();
    return row ? toWire(row) : null;
  },
});

export const loadClient = internalQuery({
  args: { serverName: v.string(), issuer: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_server_issuer", (q) =>
        q.eq("serverName", args.serverName).eq("issuer", args.issuer),
      )
      .first();
    if (!row) return null;
    return {
      clientRecordId: row.clientRecordId,
      serverName: row.serverName,
      issuer: row.issuer,
      envelope: row.envelope,
      keyVersion: row.keyVersion,
      registrationMode: row.registrationMode,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  },
});

// ----------------------------------------------------------------- writes
export const saveCredential = internalMutation({
  args: {
    credentialId: v.string(),
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    connectionId: v.id("mcpConnections"),
    serverName: v.string(),
    resource: v.string(),
    kind: KIND,
    envelope: v.string(),
    keyVersion: v.number(),
    expiresAt: v.optional(v.number()),
    scope: v.optional(v.string()),
    status: STATUS,
    rev: v.number(),
    expectedRev: v.number(),
  },
  handler: async (ctx, args): Promise<{ stored: boolean }> => {
    if (args.envelope.length > MAX_ENVELOPE_CHARS) {
      // A credential envelope is ~100 characters. Something this large is
      // corruption or abuse, not a token.
      return { stored: false };
    }

    // OWNERSHIP IS RE-CHECKED HERE, not trusted from the body. The Python plane
    // holds the ingress secret, so it *could* claim any tenant; this is what
    // stops a bug there from writing a credential onto someone else's
    // connection.
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.userId !== args.userId) {
      return { stored: false };
    }

    const existing = await ctx.db
      .query("mcpCredentials")
      .withIndex("by_connection_resource", (q) =>
        q
          .eq("connectionId", args.connectionId)
          .eq("resource", args.resource)
          .eq("kind", args.kind),
      )
      .first();

    const now = Date.now();
    const scope = args.scope?.slice(0, MAX_SCOPE_CHARS);

    if (!existing) {
      await ctx.db.insert("mcpCredentials", {
        credentialId: args.credentialId,
        userId: args.userId,
        workspaceId: args.workspaceId,
        connectionId: args.connectionId,
        serverName: args.serverName,
        resource: args.resource,
        kind: args.kind,
        envelope: args.envelope,
        keyVersion: args.keyVersion,
        expiresAt: args.expiresAt,
        scope,
        status: args.status,
        rev: args.rev,
        createdAt: now,
        updatedAt: now,
      });
      return { stored: true };
    }

    // COMPARE-AND-SET. Refresh-token rotation means the authorization server
    // invalidates the old refresh token as it issues the new one, so a stale
    // writer overwriting a newer row costs the user a re-authorization. Reading
    // through the index inside this mutation puts the row in the transaction's
    // read set, so a concurrent write conflicts and retries — the same
    // mechanism scheduledDeliveries uses for its dedupe key.
    if (existing.rev !== args.expectedRev) {
      return { stored: false };
    }

    await ctx.db.patch(existing._id, {
      envelope: args.envelope,
      keyVersion: args.keyVersion,
      expiresAt: args.expiresAt,
      scope,
      status: args.status,
      rev: args.rev,
      updatedAt: now,
      lastUsedAt: now,
    });
    return { stored: true };
  },
});

export const saveClient = internalMutation({
  args: {
    clientRecordId: v.string(),
    serverName: v.string(),
    issuer: v.string(),
    envelope: v.string(),
    keyVersion: v.number(),
    registrationMode: v.union(
      v.literal("dcr"),
      v.literal("cimd"),
      v.literal("preregistered"),
    ),
  },
  handler: async (ctx, args): Promise<null> => {
    if (args.envelope.length > MAX_ENVELOPE_CHARS) return null;
    const now = Date.now();
    const existing = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_server_issuer", (q) =>
        q.eq("serverName", args.serverName).eq("issuer", args.issuer),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        envelope: args.envelope,
        keyVersion: args.keyVersion,
        registrationMode: args.registrationMode,
        updatedAt: now,
      });
      return null;
    }
    await ctx.db.insert("mcpOAuthClients", {
      clientRecordId: args.clientRecordId,
      serverName: args.serverName,
      issuer: args.issuer,
      envelope: args.envelope,
      keyVersion: args.keyVersion,
      registrationMode: args.registrationMode,
      createdAt: now,
      updatedAt: now,
    });
    return null;
  },
});

export const markCredential = internalMutation({
  args: { credentialId: v.string(), status: STATUS },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db
      .query("mcpCredentials")
      .withIndex("by_credential_id", (q) =>
        q.eq("credentialId", args.credentialId),
      )
      .first();
    if (!row) return null;
    await ctx.db.patch(row._id, {
      status: args.status,
      updatedAt: Date.now(),
      ...(args.status === "revoked" ? { revokedAt: Date.now() } : {}),
    });
    return null;
  },
});

export const deleteCredential = internalMutation({
  args: { credentialId: v.string() },
  handler: async (ctx, args): Promise<{ deleted: boolean }> => {
    const row = await ctx.db
      .query("mcpCredentials")
      .withIndex("by_credential_id", (q) =>
        q.eq("credentialId", args.credentialId),
      )
      .first();
    if (!row) return { deleted: false };
    // A real delete, not a status change: disconnect must remove the secret
    // material. Non-secret audit metadata lives in the connection row, which
    // survives.
    await ctx.db.delete(row._id);
    return { deleted: true };
  },
});

/**
 * Orphan cleanup: a connection deleted while its credential remained.
 *
 * Secrets must not outlive the thing they authorize.
 *
 * A PLAIN FUNCTION, not only a mutation, because `connections.remove` is itself
 * a mutation and a mutation cannot `runMutation`. Both call this, so the delete
 * rule has exactly one implementation and the two cannot drift apart — which
 * matters more here than anywhere else in the file, since drift would leave a
 * live secret behind with nothing left pointing at it.
 */
export async function purgeCredentialsForConnection(
  ctx: MutationCtx,
  connectionId: Id<"mcpConnections">,
): Promise<number> {
  const rows = await ctx.db
    .query("mcpCredentials")
    .withIndex("by_connection_resource", (q) =>
      q.eq("connectionId", connectionId),
    )
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

export const deleteForConnection = internalMutation({
  args: { connectionId: v.id("mcpConnections") },
  handler: async (ctx, args): Promise<{ deleted: number }> => ({
    deleted: await purgeCredentialsForConnection(ctx, args.connectionId),
  }),
});

// ----------------------------------------------------- the only public read
/** The safe projection a UI may see. Never carries `envelope` or `keyVersion`. */
export type CredentialStatus = {
  authState:
    | "AUTHORIZATION_REQUIRED"
    | "REVOKED"
    | "REAUTHORIZATION_REQUIRED"
    | "TOKEN_EXPIRED"
    | "CONNECTED";
  scope: string | null;
  expiresAt: number | null;
  updatedAt: number | null;
};

/**
 * Derive the auth state of a connection from its stored credential.
 *
 * A PLAIN FUNCTION so `statusForConnection` and `connections.listWithAuth`
 * cannot disagree about what "connected" means. **It performs NO ownership
 * check** — every caller must have done that already, and each one below has.
 */
export async function credentialStatusFor(
  ctx: QueryCtx,
  connectionId: Id<"mcpConnections">,
): Promise<CredentialStatus> {
  const rows = await ctx.db
    .query("mcpCredentials")
    .withIndex("by_connection_resource", (q) =>
      q.eq("connectionId", connectionId),
    )
    .collect();

  // Destructured rather than indexed: `apps/app` typechecks with
  // `noUncheckedIndexedAccess`, so `rows[0]` is `T | undefined` there even
  // after a length check — and this module is imported into that build.
  const [row] = rows;
  if (!row) {
    return {
      authState: "AUTHORIZATION_REQUIRED",
      scope: null,
      expiresAt: null,
      updatedAt: null,
    };
  }

  const expired = row.expiresAt !== undefined && row.expiresAt <= Date.now();
  return {
    // A SAFE PROJECTION. No `envelope`, no `keyVersion`, nothing that would
    // help an attacker who reached this query. Scope and expiry are not
    // secrets and are what a UI needs to explain the state.
    authState:
      row.status === "revoked"
        ? "REVOKED"
        : row.status === "unreadable" || row.status === "refresh_failed"
          ? "REAUTHORIZATION_REQUIRED"
          : expired
            ? "TOKEN_EXPIRED"
            : "CONNECTED",
    scope: row.scope ?? null,
    expiresAt: row.expiresAt ?? null,
    updatedAt: row.updatedAt,
  };
}

export const statusForConnection = query({
  args: { connectionId: v.id("mcpConnections") },
  handler: async (ctx, args): Promise<CredentialStatus | null> => {
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return null;
    const connection = await ctx.db.get(args.connectionId);
    // Same refusal as a non-existent id: the error must not become an existence
    // oracle for somebody else's connection.
    if (!connection || connection.userId !== userId) return null;
    return await credentialStatusFor(ctx, args.connectionId);
  },
});

/** Resolve a connection for the ingress path, having re-checked ownership. */
export const connectionForIngress = internalQuery({
  args: { connectionId: v.id("mcpConnections"), userId: v.id("users") },
  handler: async (ctx, args): Promise<Id<"mcpConnections"> | null> => {
    const row = await ctx.db.get(args.connectionId);
    return row && row.userId === args.userId ? row._id : null;
  },
});
