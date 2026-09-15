/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

/**
 * MCP credential storage — the Convex half of the Phase 4 vault.
 *
 * WHAT IS ACTUALLY UNDER TEST HERE, and what is NOT. The cryptography lives in
 * Python (`app/mcp/vault/`) and is tested there against the full invalid-envelope
 * matrix. Convex never holds a key and never decrypts. So these tests assert the
 * OTHER half of the design — the half encryption cannot provide:
 *
 *   1. No public surface returns `envelope`. A ciphertext an attacker can read
 *      is a ciphertext they can attack offline, forever, with no rate limit.
 *   2. Ownership is re-checked on WRITE, not trusted from the ingress body. The
 *      Python plane holds the ingress secret, so it *could* claim any tenant;
 *      this is what stops a bug there binding a credential to the wrong user.
 *   3. A secret never outlives the connection that authorizes it.
 *   4. Compare-and-set actually loses. Refresh-token rotation means a stale
 *      writer overwriting a newer row costs the user a re-authorization.
 *
 * The trust model is CHAT'S, not the workspace's, exactly as for connections: a
 * same-workspace peer is refused, and every non-owner gets the same answer as a
 * non-existent id so the error is never an existence oracle.
 */

const ENVELOPE = "v1.1.AAAAAAAAAAAAAAAA.Y2lwaGVydGV4dA";

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test" });
    const peer = await ctx.db.insert("users", { email: "peer@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    for (const [userId, role] of [
      [owner, "owner"],
      [peer, "member"],
    ] as const) {
      await ctx.db.insert("members", {
        workspaceId: ws,
        userId,
        role,
        createdAt: Date.now(),
      });
    }
    return { owner, peer, ws };
  });
}

async function connectionFor(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  ws: Id<"workspaces">,
  serverName = "acme.test/server",
) {
  return t.withIdentity(as(userId)).mutation(api.mcp.connections.create, {
    workspaceId: ws,
    serverName,
    slug: "acme",
    version: "1.0.0",
    versionMode: "latest_at_connect",
    transport: "streamable-http",
    authKind: "oauth",
  });
}

/** The scoped read the plane performs (H-17): it names whose credential. */
async function load(
  t: ReturnType<typeof convexTest>,
  base: {
    userId: Id<"users">;
    workspaceId: Id<"workspaces">;
    connectionId: Id<"mcpConnections">;
  },
  resource = "https://acme.test/mcp",
) {
  return t.query(internal.mcp.credentials.loadCredential, {
    connectionId: base.connectionId,
    resource,
    kind: "oauth_token" as const,
    userId: base.userId,
    workspaceId: base.workspaceId,
  });
}

async function mark(
  t: ReturnType<typeof convexTest>,
  base: {
    userId: Id<"users">;
    workspaceId: Id<"workspaces">;
    connectionId: Id<"mcpConnections">;
  },
  status: "active" | "expired" | "refresh_failed" | "revoked" | "unreadable",
  credentialId = "cred_1",
) {
  return t.mutation(internal.mcp.credentials.markCredential, {
    credentialId,
    status,
    userId: base.userId,
    workspaceId: base.workspaceId,
    connectionId: base.connectionId,
  });
}

type SaveOverrides = Partial<{
  credentialId: string;
  userId: Id<"users">;
  workspaceId: Id<"workspaces">;
  connectionId: Id<"mcpConnections">;
  serverName: string;
  resource: string;
  envelope: string;
  expiresAt: number;
  scope: string;
  status: "active" | "expired" | "refresh_failed" | "revoked" | "unreadable";
  rev: number;
  expectedRev: number;
}>;

async function save(
  t: ReturnType<typeof convexTest>,
  base: {
    userId: Id<"users">;
    workspaceId: Id<"workspaces">;
    connectionId: Id<"mcpConnections">;
  },
  overrides: SaveOverrides = {},
) {
  return t.mutation(internal.mcp.credentials.saveCredential, {
    credentialId: "cred_1",
    userId: base.userId,
    workspaceId: base.workspaceId,
    connectionId: base.connectionId,
    serverName: "acme.test/server",
    resource: "https://acme.test/mcp",
    kind: "oauth_token" as const,
    envelope: ENVELOPE,
    keyVersion: 1,
    status: "active" as const,
    rev: 1,
    expectedRev: 0,
    ...overrides,
  });
}

describe("ciphertext never reaches a public surface", () => {
  test("statusForConnection returns state and scope, never the envelope", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    await save(
      t,
      { userId: owner, workspaceId: ws, connectionId },
      { scope: "mcp:read mcp:write" },
    );

    const status = await t
      .withIdentity(as(owner))
      .query(api.mcp.credentials.statusForConnection, { connectionId });

    expect(status?.authState).toBe("CONNECTED");
    expect(status?.scope).toBe("mcp:read mcp:write");
    // The whole point. If this key ever appears, the ciphertext is reachable by
    // anyone who can sign in, which makes it offline-attackable at leisure.
    expect(JSON.stringify(status)).not.toContain("envelope");
    expect(JSON.stringify(status)).not.toContain(ENVELOPE);
    expect(JSON.stringify(status)).not.toContain("keyVersion");
  });

  test("listWithAuth carries auth state for every row and no ciphertext", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const a = await connectionFor(t, owner, ws, "a.test/server");
    const b = await connectionFor(t, owner, ws, "b.test/server");
    // The save names the connection's own server (a mismatch is refused).
    await save(
      t,
      { userId: owner, workspaceId: ws, connectionId: a },
      { serverName: "a.test/server" },
    );

    const rows = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.listWithAuth, {});

    const byId = new Map(rows.map((r) => [r._id, r]));
    expect(byId.get(a)?.auth.authState).toBe("CONNECTED");
    // No credential at all is AUTHORIZATION_REQUIRED, not an error and not
    // "connected" — the UI must be able to tell "never authorized" apart from
    // "authorized and broken".
    expect(byId.get(b)?.auth.authState).toBe("AUTHORIZATION_REQUIRED");
    expect(JSON.stringify(rows)).not.toContain(ENVELOPE);
  });

  test("a peer in the same workspace sees nothing", async () => {
    // The read boundary is the USER. A connection is a personal account, so a
    // same-workspace peer is refused exactly as they are for a chat thread.
    const t = convexTest(schema, modules);
    const { owner, peer, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    await save(t, { userId: owner, workspaceId: ws, connectionId });

    const status = await t
      .withIdentity(as(peer))
      .query(api.mcp.credentials.statusForConnection, { connectionId });
    expect(status).toBeNull();

    const rows = await t
      .withIdentity(as(peer))
      .query(api.mcp.connections.listWithAuth, {});
    expect(rows).toHaveLength(0);
  });

  test("a signed-out caller sees nothing", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    await save(t, { userId: owner, workspaceId: ws, connectionId });

    expect(
      await t.query(api.mcp.credentials.statusForConnection, { connectionId }),
    ).toBeNull();
    expect(await t.query(api.mcp.connections.listWithAuth, {})).toHaveLength(0);
  });
});

describe("ownership is re-checked on write", () => {
  test("a credential cannot be bound to a user who does not own the connection", async () => {
    // The scenario: a bug (or a compromise) in the Python plane sends the right
    // connection with the WRONG tenant. Encryption cannot catch that — the
    // ingress secret is legitimate and the envelope is well-formed. Only this
    // check can.
    const t = convexTest(schema, modules);
    const { owner, peer, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);

    const result = await save(
      t,
      { userId: peer, workspaceId: ws, connectionId },
      { credentialId: "cred_hijack" },
    );
    expect(result.stored).toBe(false);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("mcpCredentials").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  test("a credential for a deleted connection is not stored", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    await t.run(async (ctx) => ctx.db.delete(connectionId));

    const result = await save(t, {
      userId: owner,
      workspaceId: ws,
      connectionId,
    });
    expect(result.stored).toBe(false);
  });

  test("an oversized envelope is refused", async () => {
    // A credential envelope is ~110 characters. Anything this large is
    // corruption or abuse, and a row the UI renders must stay bounded.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);

    const result = await save(
      t,
      { userId: owner, workspaceId: ws, connectionId },
      { envelope: "v".repeat(64 * 1024 + 1) },
    );
    expect(result.stored).toBe(false);
  });
});

describe("compare-and-set", () => {
  test("a stale writer loses and the newer row survives", async () => {
    // Refresh-token rotation invalidates the old refresh token as it issues the
    // new one. A stale writer clobbering the newer row costs the user a
    // re-authorization, so the loser must lose LOUDLY (stored:false) rather
    // than silently overwrite.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    const base = { userId: owner, workspaceId: ws, connectionId };

    expect((await save(t, base, { rev: 1, expectedRev: 0 })).stored).toBe(true);
    expect(
      (await save(t, base, { rev: 2, expectedRev: 1, envelope: "v1.1.BBBBBBBBBBBBBBBB.bmV3ZXI" }))
        .stored,
    ).toBe(true);

    // The stale writer still believes rev 1 is current.
    const stale = await save(t, base, {
      rev: 2,
      expectedRev: 1,
      envelope: "v1.1.CCCCCCCCCCCCCCCC.c3RhbGU",
    });
    expect(stale.stored).toBe(false);

    const row = await t.run(async (ctx) =>
      ctx.db.query("mcpCredentials").first(),
    );
    expect(row?.envelope).toBe("v1.1.BBBBBBBBBBBBBBBB.bmV3ZXI");
    expect(row?.rev).toBe(2);
  });

  test("the first write needs no predecessor", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    const result = await save(
      t,
      { userId: owner, workspaceId: ws, connectionId },
      { rev: 7, expectedRev: 99 },
    );
    // No existing row means no revision to lose against — an insert must not be
    // blocked by an expectedRev that describes nothing.
    expect(result.stored).toBe(true);
  });
});

describe("a secret does not outlive what it authorizes", () => {
  test("removing a connection deletes its credentials", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    await save(t, { userId: owner, workspaceId: ws, connectionId });

    await t
      .withIdentity(as(owner))
      .mutation(api.mcp.connections.remove, { connectionId });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("mcpCredentials").collect(),
    );
    // Left behind, the row would be an encrypted token with no owner-checked
    // path left to reach or remove it.
    expect(rows).toHaveLength(0);
  });

  test("a failed remove leaves the credential alone", async () => {
    // The peer's remove must throw BEFORE the purge runs — a refused delete
    // that still destroyed the owner's credential would be a denial of service
    // wearing an authorization check.
    const t = convexTest(schema, modules);
    const { owner, peer, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    await save(t, { userId: owner, workspaceId: ws, connectionId });

    await expect(
      t
        .withIdentity(as(peer))
        .mutation(api.mcp.connections.remove, { connectionId }),
    ).rejects.toThrow();

    const rows = await t.run(async (ctx) =>
      ctx.db.query("mcpCredentials").collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("there is no delete op for the plane at all", async () => {
    // H-17. `deleteCredential` used to be reachable with the ingress secret,
    // by credentialId alone. Rows are now purged only by `completeDisconnect`
    // and `connections.remove`, both owner-authenticated.
    // `internal.*` is a proxy that names anything; the MODULE is the truth.
    const credentials = (await import("./mcp/credentials")) as Record<string, unknown>;
    expect(credentials.deleteCredential).toBeUndefined();
  });
});

describe("every op is scoped to (user, workspace, connection) — H-17", () => {
  test("a read for another user's connection returns nothing", async () => {
    const t = convexTest(schema, modules);
    const { owner, peer, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    await save(t, { userId: owner, workspaceId: ws, connectionId });

    expect(await load(t, { userId: owner, workspaceId: ws, connectionId })).not.toBeNull();
    expect(await load(t, { userId: peer, workspaceId: ws, connectionId })).toBeNull();
  });

  test("a read under another workspace returns nothing", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const other = await t.run(async (ctx) =>
      ctx.db.insert("workspaces", { name: "Other", ownerId: owner, createdAt: Date.now() }),
    );
    const connectionId = await connectionFor(t, owner, ws);
    await save(t, { userId: owner, workspaceId: ws, connectionId });
    expect(await load(t, { userId: owner, workspaceId: other, connectionId })).toBeNull();
  });

  test("a mark by another user, or for another connection, is refused", async () => {
    const t = convexTest(schema, modules);
    const { owner, peer, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    const otherConnection = await connectionFor(t, owner, ws, "acme.test/other");
    await save(t, { userId: owner, workspaceId: ws, connectionId });

    expect(await mark(t, { userId: peer, workspaceId: ws, connectionId }, "revoked")).toEqual({ ok: false });
    expect(
      await mark(t, { userId: owner, workspaceId: ws, connectionId: otherConnection }, "revoked"),
    ).toEqual({ ok: false });
    const row = await t.run(async (ctx) => ctx.db.query("mcpCredentials").first());
    expect(row?.status).toBe("active");

    expect(await mark(t, { userId: owner, workspaceId: ws, connectionId }, "revoked")).toEqual({ ok: true });
  });

  test("a save under another workspace or server is refused, not stored", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const other = await t.run(async (ctx) =>
      ctx.db.insert("workspaces", { name: "Other", ownerId: owner, createdAt: Date.now() }),
    );
    const connectionId = await connectionFor(t, owner, ws);
    expect(await save(t, { userId: owner, workspaceId: other, connectionId })).toMatchObject({
      stored: false,
      refused: true,
      reason: "forbidden",
    });
    expect(
      await save(t, { userId: owner, workspaceId: ws, connectionId }, { serverName: "evil.test/server" }),
    ).toMatchObject({ stored: false, refused: true, reason: "server_mismatch" });
    expect(await t.run(async (ctx) => ctx.db.query("mcpCredentials").collect())).toHaveLength(0);
  });

  test("saves and marks leave an audit line", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    await save(t, { userId: owner, workspaceId: ws, connectionId });
    await mark(t, { userId: owner, workspaceId: ws, connectionId }, "revoked");
    const actions = (await t.run(async (ctx) => ctx.db.query("auditLogs").collect())).map(
      (r) => r.action,
    );
    expect(actions).toContain("mcp.credential_saved");
    expect(actions).toContain("mcp.credential_marked");
  });
});

describe("nothing lands after a disconnect — H-04", () => {
  test("a save for a disconnected connection is refused and the row stays gone", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    await save(t, { userId: owner, workspaceId: ws, connectionId });

    const done = await t.mutation(internal.mcp.connections.completeDisconnect, {
      connectionId,
      userId: owner,
      revokedRemotely: false,
    });
    expect(done.purged).toBe(1);
    expect(await t.run(async (ctx) => ctx.db.query("mcpCredentials").collect())).toHaveLength(0);

    // The late refresh: the token exchange finished after the user clicked
    // Disconnect. It must not resurrect the credential.
    const late = await save(t, { userId: owner, workspaceId: ws, connectionId }, { rev: 1, expectedRev: 0 });
    expect(late).toMatchObject({ stored: false, refused: true, reason: "disconnected" });
    expect(await t.run(async (ctx) => ctx.db.query("mcpCredentials").collect())).toHaveLength(0);
    // And nothing can be read or marked through it either.
    expect(await load(t, { userId: owner, workspaceId: ws, connectionId })).toBeNull();
    expect(await mark(t, { userId: owner, workspaceId: ws, connectionId }, "active")).toEqual({ ok: false });
  });

  test("completeDisconnect refuses another user's connection", async () => {
    const t = convexTest(schema, modules);
    const { owner, peer, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    await save(t, { userId: owner, workspaceId: ws, connectionId });
    const done = await t.mutation(internal.mcp.connections.completeDisconnect, {
      connectionId,
      userId: peer,
      revokedRemotely: false,
    });
    expect(done.purged).toBe(0);
    expect(await t.run(async (ctx) => ctx.db.query("mcpCredentials").collect())).toHaveLength(1);
    const row = await t.run(async (ctx) => ctx.db.get(connectionId));
    expect(row?.status).not.toBe("disconnected");
  });
});

describe("status projection", () => {
  test("an elapsed expiry reads as TOKEN_EXPIRED, not as an error", async () => {
    // A refresh token may still recover this with the user doing nothing at
    // all, so it must not be presented as a failure.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    await save(
      t,
      { userId: owner, workspaceId: ws, connectionId },
      { expiresAt: Date.now() - 1000 },
    );
    const status = await t
      .withIdentity(as(owner))
      .query(api.mcp.credentials.statusForConnection, { connectionId });
    expect(status?.authState).toBe("TOKEN_EXPIRED");
  });

  test("an unreadable row asks for re-authorization", async () => {
    // `unreadable` means the envelope would not decrypt — a retired key, a
    // corrupted row. The only recovery is a fresh authorization, and saying so
    // is better than a generic error.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    await save(t, { userId: owner, workspaceId: ws, connectionId });
    await mark(t, { userId: owner, workspaceId: ws, connectionId }, "unreadable");
    const status = await t
      .withIdentity(as(owner))
      .query(api.mcp.credentials.statusForConnection, { connectionId });
    expect(status?.authState).toBe("REAUTHORIZATION_REQUIRED");
  });

  test("revoked outranks an unexpired token", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    await save(
      t,
      { userId: owner, workspaceId: ws, connectionId },
      { expiresAt: Date.now() + 3_600_000 },
    );
    await mark(t, { userId: owner, workspaceId: ws, connectionId }, "revoked");
    const status = await t
      .withIdentity(as(owner))
      .query(api.mcp.credentials.statusForConnection, { connectionId });
    expect(status?.authState).toBe("REVOKED");

    const row = await t.run(async (ctx) =>
      ctx.db.query("mcpCredentials").first(),
    );
    expect(row?.revokedAt).toBeGreaterThan(0);
  });

  test("marking a credential that does not exist is a refused no-op", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    await expect(
      mark(t, { userId: owner, workspaceId: ws, connectionId }, "revoked", "nope"),
    ).resolves.toEqual({ ok: false });
  });
});

describe("credentials are scoped per resource", () => {
  test("two resources on one connection hold separate rows", async () => {
    // The resource is the audience. RFC 8707 binds a token to one, and the AAD
    // binds the ciphertext to it too, so a token minted for resource A must
    // never be found when resource B is asked for.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    const base = { userId: owner, workspaceId: ws, connectionId };

    await save(t, base, {
      credentialId: "cred_a",
      resource: "https://acme.test/mcp",
    });
    await save(t, base, {
      credentialId: "cred_b",
      resource: "https://acme.test/other",
      envelope: "v1.1.DDDDDDDDDDDDDDDD.b3RoZXI",
    });

    const a = await load(t, base, "https://acme.test/mcp");
    const b = await load(t, base, "https://acme.test/other");
    expect(a?.credentialId).toBe("cred_a");
    expect(b?.credentialId).toBe("cred_b");
    expect(a?.envelope).not.toBe(b?.envelope);
  });

  test("an unknown resource loads nothing rather than the nearest match", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const connectionId = await connectionFor(t, owner, ws);
    await save(t, { userId: owner, workspaceId: ws, connectionId });

    const found = await load(
      t,
      { userId: owner, workspaceId: ws, connectionId },
      "https://evil.test/mcp",
    );
    expect(found).toBeNull();
  });
});

describe("the OAuth client record is deployment-scoped", () => {
  test("one client per (server, issuer), reused and updatable", async () => {
    // A DCR client is registered once per server and shared by every user. It
    // has NO owner, which is exactly why it is a separate table: putting it
    // beside the tenant-scoped credentials would make its authorization rules
    // incoherent.
    const t = convexTest(schema, modules);
    await t.mutation(internal.mcp.credentials.saveClient, {
      clientRecordId: "client_1",
      serverName: "acme.test/server",
      issuer: "https://issuer.test",
      envelope: ENVELOPE,
      keyVersion: 1,
      registrationMode: "dcr",
    });
    await t.mutation(internal.mcp.credentials.saveClient, {
      clientRecordId: "client_2",
      serverName: "acme.test/server",
      issuer: "https://issuer.test",
      envelope: "v1.2.EEEEEEEEEEEEEEEE.cmV3cmFwcGVk",
      keyVersion: 2,
      registrationMode: "dcr",
    });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("mcpOAuthClients").collect(),
    );
    expect(rows).toHaveLength(1);

    const loaded = await t.query(internal.mcp.credentials.loadClient, {
      serverName: "acme.test/server",
      issuer: "https://issuer.test",
    });
    // Re-registration REWRAPS in place; it does not mint a second client, which
    // would leave the first orphaned at the provider.
    expect(loaded?.keyVersion).toBe(2);
    expect(loaded?.clientRecordId).toBe("client_1");
  });

  test("a different issuer is a different client", async () => {
    const t = convexTest(schema, modules);
    for (const issuer of ["https://a.test", "https://b.test"]) {
      await t.mutation(internal.mcp.credentials.saveClient, {
        clientRecordId: `client_${issuer}`,
        serverName: "acme.test/server",
        issuer,
        envelope: ENVELOPE,
        keyVersion: 1,
        registrationMode: "dcr",
      });
    }
    const rows = await t.run(async (ctx) =>
      ctx.db.query("mcpOAuthClients").collect(),
    );
    expect(rows).toHaveLength(2);
  });

  test("exactly one function in the module is public", async () => {
    // There is no owner to check a client record against, so the only coherent
    // rule is that nothing public reads it at all — and the same for every
    // function that can return an `envelope`.
    //
    // ASSERTED AGAINST `isPublic`/`isInternal`, the markers Convex itself uses
    // to decide what a client may call. **Measured limitation:** `convex-test`
    // resolves functions by module path and does NOT enforce visibility — a
    // `t.query(api.mcp.credentials.loadCredential, …)` succeeds in this harness
    // and returns the ciphertext, while in production the same call is refused.
    // So calling them here would prove nothing; reading the marker is the
    // honest check, and it is the one that catches the regression that matters:
    // somebody changing an `internalQuery` to a `query`.
    const credentials = (await import("./mcp/credentials")) as unknown as Record<
      string,
      { isPublic?: boolean; isInternal?: boolean } | undefined
    >;

    const publicNames = Object.entries(credentials)
      .filter(([, fn]) => fn?.isPublic === true)
      .map(([name]) => name)
      .sort();
    expect(publicNames).toEqual(["statusForConnection"]);

    // And every ciphertext-bearing function is positively marked internal —
    // not merely absent from the list above, which a renamed export would also
    // satisfy.
    for (const name of [
      "loadCredential",
      "loadClient",
      "saveCredential",
      "saveClient",
      "markCredential",
      "deleteForConnection",
      "connectionForIngress",
    ]) {
      expect(credentials[name]?.isInternal, name).toBe(true);
    }
  });
});
