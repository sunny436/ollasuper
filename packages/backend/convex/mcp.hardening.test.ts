import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Phase 8: the MCP audit trail and the MCP rate limits.
 *
 * Both are things Phases 2–7 shipped WITHOUT. `grep "audit(" convex/mcp/`
 * returned nothing, so connecting a third-party server and revoking its
 * authorization left no record; and no MCP surface had a rate limit of any
 * kind, so a loop spent somebody else's API quota without bound.
 *
 * THE AUDIT TESTS ASSERT WHAT IS *NOT* IN A ROW as hard as what is. An audit
 * trail that leaked a token would be worse than none — it would put a
 * credential in a table more code can read than the vault, and keep it there.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: Id<"users">) => ({ subject: `${userId}|sess_${userId}` });

const realFetch = globalThis.fetch;
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "test-service-key";
  reply = { status: 200, body: { state: "ready", tool_count: 3 } };
  // ROUTE-AWARE, because `runOperation` writes `report.state` onto the row: a
  // stub that answered "ready" to a /disconnect would make the row claim it is
  // connected, which is a test artefact that looks exactly like a bug.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    const body = url.endsWith("/disconnect")
      ? { state: "disconnected" }
      : reply.body;
    return new Response(JSON.stringify(body), { status: reply.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_SERVICE_KEY;
});

/** The house seed, copied from `mcp.connections.test.ts` rather than invented —
 *  `workspaces` has no `slug`, and guessing produced a validator error. */
async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId: ws,
      userId: owner,
      role: "owner",
      createdAt: Date.now(),
    });
    return { owner, ws };
  });
}

const CONNECTION = {
  serverName: "test.fixture/fake",
  slug: "fake",
  version: "",
  versionMode: "latest_at_connect" as const,
  transport: "streamable-http" as const,
  authKind: "none",
};

async function createFor(
  t: ReturnType<typeof convexTest>,
  owner: Id<"users">,
  ws: Id<"workspaces">,
): Promise<Id<"mcpConnections">> {
  return await t
    .withIdentity(as(owner))
    .mutation(api.mcp.connections.create, { workspaceId: ws, ...CONNECTION });
}

const auditRows = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => await ctx.db.query("auditLogs").collect());

// ================================================================== audit
describe("the MCP audit trail", () => {
  test("creating a connection is recorded, with the tenant from the session", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    await createFor(t, owner, ws);

    const rows = await auditRows(t);
    const created = rows.find((r) => r.action === "mcp.connection_created");
    expect(created).toBeDefined();
    expect(created?.userId).toBe(owner);
    expect(created?.workspaceId).toBe(ws);
    expect((created?.meta as { slug?: string })?.slug).toBe("fake");
  });

  test("removal is recorded BEFORE the row disappears", async () => {
    // Written afterwards there would be nothing left to attribute the event to,
    // and the removal of a connection is precisely what an incident review needs.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);

    await t
      .withIdentity(as(owner))
      .mutation(api.mcp.connections.remove, { connectionId: id });

    const rows = await auditRows(t);
    const removed = rows.find((r) => r.action === "mcp.connection_removed");
    expect(removed).toBeDefined();
    expect(removed?.userId).toBe(owner);
    expect((removed?.meta as { serverName?: string })?.serverName).toBe(
      "test.fixture/fake",
    );
    // And the row really is gone, so the event could only have been written first.
    const gone = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.get, { connectionId: id });
    expect(gone).toBeNull();
  });

  test("a successful connect records mcp.connected with its tool count", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);

    await t
      .withIdentity(as(owner))
      .action(api.mcp.connections.connect, { connectionId: id });

    const rows = await auditRows(t);
    const ev = rows.find((r) => r.action === "mcp.connected");
    expect(ev).toBeDefined();
    expect((ev?.meta as { toolCount?: number })?.toolCount).toBe(3);
  });

  test("a failed connect records the error KIND, never the error text", async () => {
    // The kind is an OllaSuper classification. The detail is a third party's
    // sentence and belongs on the connection row the UI renders, not in a
    // security log an operator greps.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    reply = {
      status: 200,
      body: {
        state: "failed",
        error_kind: "auth_required",
        error_detail: "the server requires authorization",
      },
    };

    await t
      .withIdentity(as(owner))
      .action(api.mcp.connections.connect, { connectionId: id });

    const rows = await auditRows(t);
    const ev = rows.find((r) => r.action === "mcp.connect_failed");
    expect(ev).toBeDefined();
    expect((ev?.meta as { errorKind?: string })?.errorKind).toBe("auth_required");
    expect(JSON.stringify(ev?.meta)).not.toContain("requires authorization");
  });

  test("NOTHING credential-shaped can reach an audit row", async () => {
    // The hostile case: a plane response stuffed with secrets. `meta` is an
    // allowlist of four fields, so none of this has a path in even if a future
    // caller tried to pass it.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    reply = {
      status: 200,
      body: {
        state: "ready",
        access_token: "ya29.SECRET",
        refresh_token: "1//SECRET",
        client_secret: "cs_SECRET",
        authorization_url: "https://p.test/auth?state=ST4TE&client_id=abc",
      },
    };

    await t
      .withIdentity(as(owner))
      .action(api.mcp.connections.connect, { connectionId: id });

    const serialized = JSON.stringify(await auditRows(t));
    for (const needle of ["ya29", "1//SECRET", "cs_SECRET", "ST4TE", "client_id"]) {
      expect(serialized).not.toContain(needle);
    }
  });

  test("the audit tenant is derived from the row, not from the caller", async () => {
    // An internalMutation is reachable by any action in the deployment, so a
    // caller-supplied userId would make the trail forgeable by exactly the code
    // most likely to be wrong about identity.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);

    await t.run(async (ctx) =>
      ctx.runMutation(internal.mcp.audit.record, {
        connectionId: id,
        action: "mcp.disconnected",
      }),
    );

    const ev = (await auditRows(t)).find((r) => r.action === "mcp.disconnected");
    expect(ev?.userId).toBe(owner);
    expect(ev?.workspaceId).toBe(ws);
  });

  test("auditing a deleted connection is a no-op, not a crash", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);
    await t
      .withIdentity(as(owner))
      .mutation(api.mcp.connections.remove, { connectionId: id });

    await t.run(async (ctx) =>
      ctx.runMutation(internal.mcp.audit.record, {
        connectionId: id,
        action: "mcp.connected",
      }),
    );
    // Only the removal event exists; nothing invented a tenant for a dead row.
    const kinds = (await auditRows(t)).map((r) => r.action);
    expect(kinds).not.toContain("mcp.connected");
  });
});

// ============================================================ rate limits
describe("the MCP rate limits", () => {
  test("connection creation is bounded per user", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);

    // `create` is idempotent per (user, serverName), so distinct names are
    // needed to actually spend the window rather than hit the same row.
    for (let i = 0; i < 60; i++) {
      await t.withIdentity(as(owner)).mutation(api.mcp.connections.create, {
        workspaceId: ws,
        ...CONNECTION,
        serverName: `test.fixture/s${i}`,
        slug: `s${i}`,
      });
    }
    await expect(
      t.withIdentity(as(owner)).mutation(api.mcp.connections.create, {
        workspaceId: ws,
        ...CONNECTION,
        serverName: "test.fixture/s60",
        slug: "s60",
      }),
    ).rejects.toThrow(/Too many connection attempts/);
  });

  test("one user's window is not another user's", async () => {
    // The failure this guards against is a quota that is really a denial of
    // service: if the window were charged to the wrong user, anyone could lock
    // anyone else out.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const other = await t.run(async (ctx) => {
      const u = await ctx.db.insert("users", { email: "peer@t.test" });
      await ctx.db.insert("members", {
        workspaceId: ws,
        userId: u,
        role: "member",
        createdAt: Date.now(),
      });
      return u;
    });

    for (let i = 0; i < 60; i++) {
      await t.withIdentity(as(owner)).mutation(api.mcp.connections.create, {
        workspaceId: ws,
        ...CONNECTION,
        serverName: `test.fixture/s${i}`,
        slug: `s${i}`,
      });
    }
    // The other user is untouched.
    await t.withIdentity(as(other)).mutation(api.mcp.connections.create, {
      workspaceId: ws,
      ...CONNECTION,
      serverName: "test.fixture/other",
      slug: "other",
    });
    const rows = await t.run(
      async (ctx) => await ctx.db.query("userQuotas").collect(),
    );
    const byUser = rows.filter((r) => r.kind === "mcpConnect");
    expect(byUser.length).toBe(2);
  });

  test("an unauthenticated caller cannot spend a window", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.mcp.limits.consume, { kind: "mcpAuth" }),
    ).rejects.toThrow(/Not authenticated/);
  });

  test("the three kinds have separate windows", async () => {
    // Sharing one would let a burst of capability reads lock a user out of
    // reconnecting — the operation they most need when something is wrong.
    const t = convexTest(schema, modules);
    const { owner } = await seed(t);
    // `.mutation(...)` and NOT `.run(ctx => ctx.runMutation(...))`: `t.run`
    // executes outside any identity, so `ctx.auth.getUserIdentity()` inside the
    // limiter returns null and it correctly refuses. Measured, not guessed.
    for (const kind of ["mcpConnect", "mcpAuth", "mcpCapability"] as const) {
      await t
        .withIdentity(as(owner))
        .mutation(internal.mcp.limits.consume, { kind });
    }
    const rows = await t.run(
      async (ctx) => await ctx.db.query("userQuotas").collect(),
    );
    expect(new Set(rows.map((r) => r.kind)).size).toBe(3);
  });

  test("disconnect is deliberately NOT rate limited", async () => {
    // Rate-limiting the off switch is the wrong failure direction: it is how a
    // worried user stops a connection.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await createFor(t, owner, ws);

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("userQuotas")
        .withIndex("by_user_kind", (q) =>
          q.eq("userId", owner).eq("kind", "mcpConnect"),
        )
        .unique();
      // Burn the window to its limit.
      if (row) await ctx.db.patch(row._id, { windowCount: 60 });
    });

    // Connect is now refused...
    await expect(
      t
        .withIdentity(as(owner))
        .action(api.mcp.connections.connect, { connectionId: id }),
    ).rejects.toThrow(/Too many connection attempts/);
    // ...but disconnect still works.
    await t
      .withIdentity(as(owner))
      .action(api.mcp.connections.disconnect, { connectionId: id });
    const row = await t
      .withIdentity(as(owner))
      .query(api.mcp.connections.get, { connectionId: id });
    expect(row?.status).toBe("disconnected");
  });
});
