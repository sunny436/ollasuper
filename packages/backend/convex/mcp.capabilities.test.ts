/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

const BASE = "http://127.0.0.1:8770";
const SERVICE = "service-key-for-tests";

/**
 * Phase 5's Convex surface: the capability actions, and the ONE new field on
 * `dispatchPayload`.
 *
 * TWO PROPERTIES, and they are different in kind.
 *
 * 1. TENANCY. Resources and prompts are reached with a `connectionId` the caller
 *    supplies, so the only thing standing between user A and user B's Notion
 *    workspace is the ownership re-check in `tenantFor`. Every "peer is refused"
 *    test here is that check firing — and each asserts the plane was NOT called,
 *    because a refusal that still dialled would have already leaked which
 *    connection ids exist.
 *
 * 2. THE DISPATCH FIELD. `mcpConnections` is what makes a turn able to use MCP at
 *    all. It must carry only READY connections owned by the stream's user, must
 *    carry no credential, and — because `GenerateRequest` is `extra="forbid"` —
 *    its arrival is what re-engages the Python-before-Convex deploy order.
 */

let fetchSpy: { mockRestore: () => void } | null = null;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["AI_BASE_URL", "AI_SERVICE_KEY"]) saved[k] = process.env[k];
  process.env.AI_BASE_URL = BASE;
  process.env.AI_SERVICE_KEY = SERVICE;
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function stubPlane(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    // biome-ignore lint/suspicious/noExplicitAny: stubbing the global fetch
    .mockImplementation((async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
      // biome-ignore lint/suspicious/noExplicitAny: stubbing the global fetch
    }) as any);
  return calls;
}

async function seed(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx) => {
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
  const connectionId: Id<"mcpConnections"> = await t
    .withIdentity(as(ids.owner))
    .mutation(api.mcp.connections.create, {
      workspaceId: ids.ws,
      serverName: "acme.test/server",
      slug: "acme",
      version: "2.1.0",
      versionMode: "pinned",
      transport: "streamable-http",
      authKind: "none",
    });
  return { ...ids, connectionId };
}

const ACTIONS = ["resources", "prompts"] as const;

describe("the capability actions are tenancy-gated", () => {
  test.each(ACTIONS)("%s refuses a signed-out caller", async (name) => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubPlane({ resources: [] });
    await expect(
      t.action(api.mcp.capabilities[name], { connectionId: s.connectionId }),
    ).rejects.toThrow();
  });

  test.each(ACTIONS)("%s refuses a same-workspace peer", async (name) => {
    // An MCP connection is a PERSONAL account. A same-workspace peer is refused
    // exactly as they are for a chat thread, and the error is "Not found" so it
    // cannot become an existence oracle for someone else's connection id.
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const calls = stubPlane({ resources: [] });
    await expect(
      t
        .withIdentity(as(s.peer))
        .action(api.mcp.capabilities[name], { connectionId: s.connectionId }),
    ).rejects.toThrow("Not found");
    expect(calls).toHaveLength(0);
  });

  test("readResource refuses a peer before the uri is ever forwarded", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const calls = stubPlane({ text: "secret" });
    await expect(
      t.withIdentity(as(s.peer)).action(api.mcp.capabilities.readResource, {
        connectionId: s.connectionId,
        uri: "mem://notes/alpha",
      }),
    ).rejects.toThrow("Not found");
    expect(calls).toHaveLength(0);
  });

  test("getPrompt refuses a peer before the arguments are forwarded", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const calls = stubPlane({ messages: [] });
    await expect(
      t.withIdentity(as(s.peer)).action(api.mcp.capabilities.getPrompt, {
        connectionId: s.connectionId,
        promptName: "summarize",
        arguments: { text: "private" },
      }),
    ).rejects.toThrow("Not found");
    expect(calls).toHaveLength(0);
  });

  test("the tenant sent to the plane comes from the session, not from args", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const calls = stubPlane({ resources: [], templates: [] });

    await t
      .withIdentity(as(s.owner))
      .action(api.mcp.capabilities.resources, { connectionId: s.connectionId });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `${BASE}/v1/mcp/connections/${s.connectionId}/resources`,
    );
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.user_id).toBe(s.owner);
    expect(body.workspace_id).toBe(s.ws);
    expect(body.version).toBe("2.1.0");
  });

  test("a prompt invocation forwards the name and arguments verbatim", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const calls = stubPlane({ prompt: "summarize", messages: [] });

    await t.withIdentity(as(s.owner)).action(api.mcp.capabilities.getPrompt, {
      connectionId: s.connectionId,
      promptName: "summarize",
      arguments: { text: "hello", style: "brief" },
    });

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.prompt_name).toBe("summarize");
    expect(body.arguments).toEqual({ text: "hello", style: "brief" });
  });

  test("a 400 from validation reaches the caller as a usable message", async () => {
    // The whole reason argument validation lives in Python rather than being
    // left to the MCP server: the server's own answer is
    // `MCPError: Internal server error` with no field name.
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubPlane({ detail: "prompt 'summarize' requires: ['text']" }, 400);

    const out = await t
      .withIdentity(as(s.owner))
      .action(api.mcp.capabilities.getPrompt, {
        connectionId: s.connectionId,
        promptName: "summarize",
      });
    expect(out.error).toContain("requires");
    expect(out.error).toContain("text");
  });

  test("an unreachable plane never echoes the exception", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("connect ECONNREFUSED 172.16.70.25:8770"));
    const out = await t
      .withIdentity(as(s.owner))
      .action(api.mcp.capabilities.resources, { connectionId: s.connectionId });
    expect(JSON.stringify(out)).not.toContain("172.16.70.25");
    expect(out.error).toBe("the AI service could not be reached");
  });

  test("an unconfigured deployment reports rather than throwing", async () => {
    // Throwing would log a console.error and fail every e2e script.
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const calls = stubPlane({ resources: [] });
    // biome-ignore lint/performance/noDelete: the action reads absence, not ""
    delete process.env.AI_BASE_URL;
    const out = await t
      .withIdentity(as(s.owner))
      .action(api.mcp.capabilities.resources, { connectionId: s.connectionId });
    expect(out.error).toBe("the AI service is not configured");
    expect(calls).toHaveLength(0);
  });
});

describe("dispatchPayload carries the user's ready MCP connections", () => {
  async function streamFor(
    t: ReturnType<typeof convexTest>,
    userId: Id<"users">,
    workspaceId: Id<"workspaces">,
  ) {
    return t.run(async (ctx) => {
      const threadId = await ctx.db.insert("chatThreads", {
        userId,
        workspaceId,
        title: "t",
        titleSource: "user",
        status: "active",
        pinned: false,
        model: "m",
        nextSeq: 3,
        messageCount: 2,
        tokensIn: 0,
        tokensOut: 0,
        lastMessageAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("chatMessages", {
        threadId,
        userId,
        workspaceId,
        role: "user",
        content: "hello",
        seq: 1,
        status: "complete",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const messageId = await ctx.db.insert("chatMessages", {
        threadId,
        userId,
        workspaceId,
        role: "assistant",
        content: "",
        seq: 2,
        status: "streaming",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("chatStreams", {
        streamId: "s1",
        messageId,
        threadId,
        workspaceId,
        userId,
        status: "running",
        cancelRequested: false,
        chunkSeq: -1,
        committedText: "",
        committedSeq: -1,
        heartbeatAt: Date.now(),
        startedAt: Date.now(),
        attempts: 0,
        deadlineAt: Date.now() + 300_000,
      });
      return { threadId, messageId };
    });
  }

  async function payload(t: ReturnType<typeof convexTest>) {
    return t.query(internal.chat.stream.dispatchPayload, { streamId: "s1" });
  }

  test("a ready connection travels; a configured one does not", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await streamFor(t, s.owner, s.ws);

    // Freshly created connections are `configured` — nothing has been contacted.
    expect((await payload(t))?.mcpConnections).toEqual([]);

    await t.run(async (ctx) =>
      ctx.db.patch(s.connectionId, { status: "ready" }),
    );
    const out = await payload(t);
    expect(out?.mcpConnections).toEqual([
      {
        connectionId: s.connectionId,
        serverName: "acme.test/server",
        slug: "acme",
        version: "2.1.0",
      },
    ]);
  });

  test("a disconnected connection is never auto-reconnected", async () => {
    // The user closed it on purpose. Sending it would make every turn re-open a
    // server they explicitly stopped using.
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await streamFor(t, s.owner, s.ws);
    for (const status of ["disconnected", "failed", "unsupported"] as const) {
      await t.run(async (ctx) => ctx.db.patch(s.connectionId, { status }));
      expect((await payload(t))?.mcpConnections).toEqual([]);
    }
  });

  test("another user's ready connection never appears", async () => {
    // `by_user` is keyed on the STREAM's user, so there is no query shape here
    // that could return somebody else's connection.
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await streamFor(t, s.owner, s.ws);

    const peerConnection = await t
      .withIdentity(as(s.peer))
      .mutation(api.mcp.connections.create, {
        workspaceId: s.ws,
        serverName: "peer.test/server",
        slug: "peer",
        version: "1.0.0",
        versionMode: "pinned",
        transport: "streamable-http",
        authKind: "none",
      });
    await t.run(async (ctx) =>
      ctx.db.patch(peerConnection, { status: "ready" }),
    );

    const out = await payload(t);
    expect(out?.mcpConnections).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("peer.test/server");
  });

  test("a latest_at_connect connection sends no pinned version", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await streamFor(t, s.owner, s.ws);
    await t.run(async (ctx) =>
      ctx.db.patch(s.connectionId, {
        status: "ready",
        versionMode: "latest_at_connect",
      }),
    );
    expect((await payload(t))?.mcpConnections[0].version).toBeNull();
  });

  test("nothing credential-shaped travels in the payload", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await streamFor(t, s.owner, s.ws);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.connectionId, { status: "ready" });
      await ctx.db.insert("mcpCredentials", {
        credentialId: "cred_1",
        userId: s.owner,
        workspaceId: s.ws,
        connectionId: s.connectionId,
        serverName: "acme.test/server",
        resource: "https://acme.test/mcp",
        kind: "oauth_token",
        envelope: "v1.1.AAAAAAAAAAAAAAAA.Y2lwaGVy",
        keyVersion: 1,
        status: "active",
        rev: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const blob = JSON.stringify(await payload(t));
    // The Python plane resolves a credential from its OWN vault using
    // (user, workspace, connection). One in the dispatch payload would be in
    // Convex's logs and in every retry of the turn.
    for (const marker of [
      "envelope",
      "v1.1.AAAA",
      "access_token",
      "credentialId",
      "keyVersion",
    ]) {
      expect(blob).not.toContain(marker);
    }
  });

  test("the per-turn connection count is bounded", async () => {
    // Each connection costs a pooled session and a discovery round trip before
    // the model sees anything.
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await streamFor(t, s.owner, s.ws);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.connectionId, { status: "ready" });
      for (let i = 0; i < 40; i++) {
        await ctx.db.insert("mcpConnections", {
          userId: s.owner,
          workspaceId: s.ws,
          serverName: `bulk-${i}.test/server`,
          slug: `bulk-${i}`,
          version: "1.0.0",
          versionMode: "pinned",
          transport: "streamable-http",
          authKind: "none",
          status: "ready",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });
    expect((await payload(t))?.mcpConnections.length).toBe(30);
  });
});
