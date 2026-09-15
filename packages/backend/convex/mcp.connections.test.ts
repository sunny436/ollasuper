/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

/**
 * MCP connection authorization.
 *
 * THE MODEL UNDER TEST, and why it is not the one used everywhere else in this
 * codebase: an MCP connection is a PERSONAL ACCOUNT — someone's GitHub, their
 * mailbox, their Notion. Everywhere else a workspace is the read boundary and
 * any member reads any row; here a same-workspace peer must be refused, exactly
 * as chat threads refuse one. `workspaceId` is carried for tenancy and checked
 * with requireMember on creation, but it is never the read boundary.
 *
 * AND THE ERROR MUST NOT BE AN ORACLE. Every non-owner gets "Not found", never
 * "Forbidden": a distinguishable error would let a caller probe for other
 * people's connection ids.
 */

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test" });
    const peer = await ctx.db.insert("users", { email: "peer@t.test" });
    const outsider = await ctx.db.insert("users", { email: "out@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    const other = await ctx.db.insert("workspaces", {
      name: "Other",
      ownerId: outsider,
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
    await ctx.db.insert("members", {
      workspaceId: other,
      userId: outsider,
      role: "owner",
      createdAt: Date.now(),
    });
    return { owner, peer, outsider, ws, other };
  });
}

const CONNECTION = {
  serverName: "acme.test/server",
  slug: "acme",
  version: "1.0.0",
  versionMode: "latest_at_connect" as const,
  transport: "streamable-http" as const,
  authKind: "none",
};

async function createFor(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  ws: Id<"workspaces">,
  overrides: Partial<typeof CONNECTION> = {},
) {
  return t
    .withIdentity(as(userId))
    .mutation(api.mcp.connections.create, {
      workspaceId: ws,
      ...CONNECTION,
      ...overrides,
    });
}

describe("creation", () => {
  test("a member can create a connection in their workspace", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    const row = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.get, { connectionId: id });
    expect(row?.serverName).toBe(CONNECTION.serverName);
  });

  test("a new connection is CONFIGURED, never ready", async () => {
    // A row existing is not a connection. Nothing has been contacted.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    const row = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.get, { connectionId: id });
    expect(row?.status).toBe("configured");
    expect(row?.lastConnectedAt).toBeUndefined();
  });

  test("a non-member cannot create a connection in someone else's workspace", async () => {
    const t = convexTest(schema, modules);
    const { outsider, ws } = await seed(t);
    await expect(createFor(t, outsider, ws)).rejects.toThrow();
  });

  test("a signed-out caller cannot create a connection", async () => {
    const t = convexTest(schema, modules);
    const { ws } = await seed(t);
    await expect(
      t.mutation(api.mcp.connections.create, { workspaceId: ws, ...CONNECTION }),
    ).rejects.toThrow();
  });

  test("creating the same server twice returns the same row", async () => {
    // Two rows for one account would give the pool two keys for one session and
    // make "disconnect" ambiguous.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const first = await createFor(t, owner, ws);
    const second = await createFor(t, owner, ws);
    expect(second).toBe(first);
  });

  test("a local server may only be connected by a workspace admin or owner", async () => {
    // Audit H-11. A local server runs code on the operator's box.
    const t = convexTest(schema, modules);
    const { owner, peer, ws } = await seed(t);
    await expect(
      t.withIdentity(as(peer)).mutation(api.mcp.connections.create, {
        workspaceId: ws,
        serverName: "local/filesystem",
        slug: "filesystem",
        version: "1.0.0",
        versionMode: "latest_at_connect",
        transport: "streamable-http",
        authKind: "none",
      }),
    ).rejects.toThrow("Forbidden");
    const id = await t.withIdentity(as(owner)).mutation(api.mcp.connections.create, {
      workspaceId: ws,
      serverName: "local/filesystem",
      slug: "filesystem",
      version: "1.0.0",
      versionMode: "latest_at_connect",
      transport: "streamable-http",
      authKind: "none",
    });
    expect(id).toBeTruthy();
  });

  test("two different users may each connect the same server", async () => {
    const t = convexTest(schema, modules);
    const { owner, peer, ws } = await seed(t);
    const a = await createFor(t, owner, ws);
    const b = await createFor(t, peer, ws);
    expect(a).not.toBe(b);
  });
});

describe("isolation", () => {
  test("a same-workspace peer cannot read another user's connection", async () => {
    const t = convexTest(schema, modules);
    const { owner, peer, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    const seen = await t
      .withIdentity(as(peer))
      .query(api.mcp.connections.get, { connectionId: id });
    expect(seen).toBeNull();
  });

  test("a peer's list never contains another user's connection", async () => {
    const t = convexTest(schema, modules);
    const { owner, peer, ws } = await seed(t);
    await createFor(t, owner, ws);
    const rows = await t
      .withIdentity(as(peer))
      .query(api.mcp.connections.list, {});
    expect(rows).toEqual([]);
  });

  test("a peer cannot delete another user's connection", async () => {
    const t = convexTest(schema, modules);
    const { owner, peer, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    await expect(
      t
        .withIdentity(as(peer))
        .mutation(api.mcp.connections.remove, { connectionId: id }),
    ).rejects.toThrow("Not found");

    // And it really is still there.
    const still = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.get, { connectionId: id });
    expect(still).not.toBeNull();
  });

  test("the refusal is Not found, never Forbidden", async () => {
    // A distinguishable error would let a caller probe for other people's
    // connection ids.
    const t = convexTest(schema, modules);
    const { owner, peer, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    await expect(
      t
        .withIdentity(as(peer))
        .mutation(api.mcp.connections.remove, { connectionId: id }),
    ).rejects.toThrow(/Not found/);
  });

  test("an owner CAN delete their own connection", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    await t
      .withIdentity(as(owner))
      .mutation(api.mcp.connections.remove, { connectionId: id });
    const gone = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.get, { connectionId: id });
    expect(gone).toBeNull();
  });

  test("a signed-out read returns empty rather than throwing", async () => {
    // Every e2e script fails on a console.error, and a thrown query logs one.
    const t = convexTest(schema, modules);
    await seed(t);
    expect(await t.query(api.mcp.connections.list, {})).toEqual([]);
  });

  test("the internal resolver refuses a connection the caller does not own", async () => {
    // The action forwards user_id/workspace_id to the Python plane THROUGH this
    // resolver, so it is the last place ownership can be enforced before a
    // tenant identity crosses the plane boundary.
    const t = convexTest(schema, modules);
    const { owner, peer, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    const mine = await t.run(async (ctx) =>
      ctx.runQuery(internal.mcp.connections.resolveForOperation, {
        connectionId: id,
        userId: owner,
      }),
    );
    const theirs = await t.run(async (ctx) =>
      ctx.runQuery(internal.mcp.connections.resolveForOperation, {
        connectionId: id,
        userId: peer,
      }),
    );
    expect(mine).not.toBeNull();
    expect(theirs).toBeNull();
  });
});

describe("outcome recording", () => {
  test("a successful connect records capabilities and clears the error", async () => {
    // A stale error next to a working connection is worse than no error.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);

    await t.run(async (ctx) =>
      ctx.runMutation(internal.mcp.connections.recordOutcome, {
        connectionId: id,
        status: "failed",
        lastError: "the server was unreachable",
        lastErrorKind: "unreachable",
        userActionRequired: false,
      }),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.mcp.connections.recordOutcome, {
        connectionId: id,
        status: "ready",
        capabilities: JSON.stringify({ tool_count: 3 }),
        toolCount: 3,
      }),
    );

    const row = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.get, { connectionId: id });
    expect(row?.status).toBe("ready");
    expect(row?.lastError).toBeUndefined();
    expect(row?.lastErrorKind).toBeUndefined();
    expect(row?.toolCount).toBe(3);
    expect(row?.lastConnectedAt).toBeGreaterThan(0);
  });

  test("an auth failure is flagged as needing a human", async () => {
    // The difference between "retrying..." and "your token expired".
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    await t.run(async (ctx) =>
      ctx.runMutation(internal.mcp.connections.recordOutcome, {
        connectionId: id,
        status: "failed",
        lastError: "the credential was rejected",
        lastErrorKind: "auth_failed",
        userActionRequired: true,
      }),
    );
    const row = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.get, { connectionId: id });
    expect(row?.userActionRequired).toBe(true);
    expect(row?.lastFailureAt).toBeGreaterThan(0);
  });

  test("error text is bounded and control characters are stripped", async () => {
    // This text originates on a third party's server and is rendered in a
    // browser and written to logs.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    await t.run(async (ctx) =>
      ctx.runMutation(internal.mcp.connections.recordOutcome, {
        connectionId: id,
        status: "failed",
        lastError: `${"x".repeat(5000)}\u0000\u001B[31m`,
      }),
    );
    const row = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.get, { connectionId: id });
    expect(row?.lastError?.length).toBeLessThanOrEqual(400);
    expect(row?.lastError).not.toContain("\u0000");
    expect(row?.lastError).not.toContain("\u001B");
  });

  test("the version actually used is written down", async () => {
    // So a later catalogue change cannot retroactively rewrite what this
    // connection ran against.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    await t.run(async (ctx) =>
      ctx.runMutation(internal.mcp.connections.recordOutcome, {
        connectionId: id,
        status: "ready",
        version: "2.5.1",
      }),
    );
    const row = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.get, { connectionId: id });
    expect(row?.version).toBe("2.5.1");
  });

  test("a ready outcome overwrites the client-supplied labels with the plane's", async () => {
    // Audit M-06. `create` takes slug/transport/authKind from the browser; the
    // plane resolves the curated row by serverName and reports what it dialled.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    const before = await t.withIdentity(as(owner)).query(api.mcp.connections.get, { connectionId: id });
    expect(before?.slug).toBe("acme");
    await t.run(async (ctx) =>
      ctx.runMutation(internal.mcp.connections.recordOutcome, {
        connectionId: id,
        status: "ready",
        slug: "acme-official",
        transport: "sse",
        authKind: "oauth",
      }),
    );
    const row = await t.withIdentity(as(owner)).query(api.mcp.connections.get, { connectionId: id });
    expect(row?.slug).toBe("acme-official");
    expect(row?.transport).toBe("sse");
    expect(row?.authKind).toBe("oauth");
    // A FAILED outcome carrying labels does not touch them.
    await t.run(async (ctx) =>
      ctx.runMutation(internal.mcp.connections.recordOutcome, {
        connectionId: id,
        status: "failed",
        slug: "should-not-land",
      }),
    );
    const after = await t.withIdentity(as(owner)).query(api.mcp.connections.get, { connectionId: id });
    expect(after?.slug).toBe("acme-official");
  });

  test("recording against a deleted connection is a no-op, not a crash", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    await t
      .withIdentity(as(owner))
      .mutation(api.mcp.connections.remove, { connectionId: id });
    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.mcp.connections.recordOutcome, {
          connectionId: id,
          status: "ready",
        }),
      ),
    ).resolves.toBeNull();
  });
});

describe("the schema itself", () => {
  test("a connection row carries no credential field", async () => {
    // Phase 4 owns credentials, in a vault keyed per user. A token here would
    // be readable by every code path that can read a connection.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    const row = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.get, { connectionId: id });
    const keys = Object.keys(row ?? {}).map((k) => k.toLowerCase());
    for (const forbidden of [
      "token",
      "secret",
      "apikey",
      "password",
      "credential",
      "authorization",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  test("no live session state is stored", async () => {
    // The MCP client, its transport and its session id live only in the Python
    // plane's in-memory pool.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    const row = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.get, { connectionId: id });
    const keys = Object.keys(row ?? {}).map((k) => k.toLowerCase());
    for (const forbidden of ["sessionid", "socket", "client", "transportstate"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});


describe("tool names", () => {
  test("are stored for the detail page and PROJECTED OFF the list query", async () => {
    // The list query re-sends its ENTIRE result to every subscriber on any
    // write. Carrying up to 64 third-party strings per row across 30 rows would
    // make one connection going ready re-transmit ~100KB to every open tab.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);

    await t.run(async (ctx) =>
      ctx.runMutation(internal.mcp.connections.recordOutcome, {
        connectionId: id,
        status: "ready",
        toolCount: 2,
        toolNames: ["search_repositories", "create_issue"],
      }),
    );

    const one = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.get, { connectionId: id });
    expect(one?.toolNames).toEqual(["search_repositories", "create_issue"]);

    const list = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.listWithAuth, {});
    expect(list[0]?.toolCount).toBe(2);
    expect(list[0]?.toolNames).toBeUndefined();
  });

  test("are bounded on both axes, and the true count still survives", async () => {
    // A server may advertise up to 256 tools. Truncating silently would make
    // "64 tools" a lie; `toolCount` keeps the real total so the UI can say
    // "and N more".
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);

    await t.run(async (ctx) =>
      ctx.runMutation(internal.mcp.connections.recordOutcome, {
        connectionId: id,
        status: "ready",
        toolCount: 200,
        toolNames: Array.from({ length: 200 }, (_, i) => `tool_${i}`.repeat(20)),
      }),
    );

    const row = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.get, { connectionId: id });
    expect(row?.toolNames?.length).toBe(64);
    for (const name of row?.toolNames ?? []) {
      expect(name.length).toBeLessThanOrEqual(80);
    }
    // The honest total, so the page can report what it did not show.
    expect(row?.toolCount).toBe(200);
  });

  test("control characters in a tool name are stripped", async () => {
    // These names are chosen by a third party, rendered in a browser and
    // written to logs; a crafted one must not forge log structure.
    const ESC = String.fromCharCode(27);
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);

    await t.run(async (ctx) =>
      ctx.runMutation(internal.mcp.connections.recordOutcome, {
        connectionId: id,
        status: "ready",
        toolCount: 1,
        toolNames: [`evil${ESC}[31m`, " ", "ok_tool"],
      }),
    );

    const row = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.get, { connectionId: id });
    // The ESC is gone; the printable remainder and the clean name survive. A
    // whitespace-only name is dropped entirely.
    expect(row?.toolNames).toEqual(["evil[31m", " ", "ok_tool"]);
  });
});
