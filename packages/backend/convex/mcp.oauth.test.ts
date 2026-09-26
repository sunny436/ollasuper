/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

const INGRESS = "ingress-secret-for-tests";
const SERVICE = "service-key-for-tests";
const BASE = "http://127.0.0.1:8770";

/**
 * The two HTTP surfaces Phase 4 adds to Convex.
 *
 * 1. `/ai/ingress` credential ops — how the Python plane persists an encrypted
 *    envelope. It has to be able to write on its own: `TokenStorage.set_tokens`
 *    fires deep inside an SDK token refresh, mid-tool-call, with no Convex
 *    action anywhere in the call stack.
 *
 * 2. `/mcp/oauth/callback` — where the OAuth provider sends the browser back.
 *
 * THE CALLBACK IS DELIBERATELY UNAUTHENTICATED, and that is the thing these
 * tests have to pin down. A browser arriving from a provider carries no
 * OllaSuper session — that is what a redirect is. The binding is `state`, held
 * by the Python plane against the tenant who STARTED the flow, so the
 * credential is written for that tenant and never for whoever happens to
 * deliver the callback. What must therefore be true here:
 *
 *   - the route NEVER trusts a tenant from its own query string;
 *   - it forwards only `{state, code, iss, error}` and the service key;
 *   - nothing it renders can carry the authorization code onward — no code in
 *     the HTML, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`;
 *   - a provider-supplied string cannot inject markup into the page.
 */

let fetchSpy: { mockRestore: () => void } | null = null;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["AI_INGRESS_SECRET", "AI_BASE_URL", "AI_SERVICE_KEY"]) {
    saved[k] = process.env[k];
  }
  process.env.AI_INGRESS_SECRET = INGRESS;
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

/** Capture what the callback route forwards, and answer with `body`. */
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

const callback = (t: ReturnType<typeof convexTest>, query: string) =>
  t.fetch(`/mcp/oauth/callback${query}`, { method: "GET" });

describe("the OAuth callback route", () => {
  test("a successful callback forwards only state, code, iss and error", async () => {
    const t = convexTest(schema, modules);
    const calls = stubPlane({ ok: true, auth_state: "CONNECTED" });

    const res = await callback(
      t,
      "?state=st_abcdefghijklmnopqrstuvwxyz0123456789ABCD&code=authcode123&iss=https%3A%2F%2Fissuer.test",
    );
    expect(res.status).toBe(200);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/v1/mcp/oauth/callback`);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-service-key"]).toBe(SERVICE);

    const forwarded = JSON.parse(String(calls[0].init.body));
    // EXACTLY these four keys. A `user_id` here would let the callback declare
    // whose account to bind — the cross-user binding this design prevents.
    expect(Object.keys(forwarded).sort()).toEqual([
      "code",
      "error",
      "iss",
      "state",
    ]);
    expect(forwarded.state).toBe("st_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
    expect(forwarded.code).toBe("authcode123");
  });

  test("the rendered page carries no authorization code", async () => {
    const t = convexTest(schema, modules);
    stubPlane({ ok: true, auth_state: "CONNECTED" });
    const res = await callback(t, "?state=st_abcdefghijklmnopqrstuvwxyz0123456789ABCD&code=authcode123");
    const html = await res.text();
    expect(html).not.toContain("authcode123");
    expect(html).not.toContain("st_abc");
  });

  test("the page forbids caching and referrer leakage", async () => {
    // The URL that produced this page contained an authorization code. Without
    // no-store it sits in the browser cache; without no-referrer it rides out
    // in a Referer header to anything the page touches.
    const t = convexTest(schema, modules);
    stubPlane({ ok: true, auth_state: "CONNECTED" });
    const res = await callback(t, "?state=st_abcdefghijklmnopqrstuvwxyz0123456789ABCD&code=authcode123");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("a provider-supplied message cannot inject markup", async () => {
    // `detail` originates on a third party's server and is rendered in a
    // browser. Escaped, not filtered: the safety is by construction.
    const t = convexTest(schema, modules);
    stubPlane({ ok: false, detail: "<img src=x onerror=alert(1)>" });
    const res = await callback(t, "?state=st_abcdefghijklmnopqrstuvwxyz0123456789ABCD&error=access_denied");
    const html = await res.text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(res.status).toBe(400);
  });

  test("a missing state is refused without calling the plane", async () => {
    const t = convexTest(schema, modules);
    const calls = stubPlane({ ok: true });
    const res = await callback(t, "?code=authcode123");
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("a malformed state, code or error is refused before the plane is asked", async () => {
    // Audit M-01. The state is a 43-char url-safe token the plane minted; a
    // provider's code is bounded; an error string is short. Anything else is
    // not a callback and never reaches the plane.
    const t = convexTest(schema, modules);
    const calls = stubPlane({ ok: true });
    for (const query of [
      "?state=short&code=x",
      `?state=${"a".repeat(200)}&code=x`,
      "?state=has%20space%3C%3E&code=x",
      `?state=st_abcdefghijklmnopqrstuvwxyz0123456789ABCD&code=${"c".repeat(3000)}`,
      `?state=st_abcdefghijklmnopqrstuvwxyz0123456789ABCD&error=${"e".repeat(300)}`,
    ]) {
      const res = await callback(t, query);
      expect(res.status, query.slice(0, 40)).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test("an unmatched state is refused and says nothing specific", async () => {
    // A distinguishable answer would tell an attacker which states exist. The
    // plane already returns the same shape for expired, replayed and forged.
    const t = convexTest(schema, modules);
    stubPlane({ ok: false, auth_state: "ERROR", detail: "no pending authorization" });
    const res = await callback(t, "?state=st_forgedforgedforgedforgedforged0123&code=x");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("no pending authorization");
  });

  test("an unreachable plane never echoes the exception", async () => {
    // An exception can carry an internal hostname. This page is public.
    const t = convexTest(schema, modules);
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("connect ECONNREFUSED 172.16.70.25:8770"));
    const res = await callback(t, "?state=st_abcdefghijklmnopqrstuvwxyz0123456789ABCD&code=x");
    const html = await res.text();
    expect(html).not.toContain("172.16.70.25");
    expect(html).not.toContain("ECONNREFUSED");
    expect(res.status).toBe(400);
  });

  test("an unconfigured deployment refuses rather than dialling", async () => {
    const t = convexTest(schema, modules);
    const calls = stubPlane({ ok: true });
    process.env.AI_SERVICE_KEY = undefined;
    // biome-ignore lint/performance/noDelete: the route reads absence, not ""
    delete process.env.AI_SERVICE_KEY;
    const res = await callback(t, "?state=st_abcdefghijklmnopqrstuvwxyz0123456789ABCD&code=x");
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("a non-2xx from the plane is not reported as success", async () => {
    const t = convexTest(schema, modules);
    stubPlane({ ok: true, auth_state: "CONNECTED" }, 503);
    const res = await callback(t, "?state=st_abcdefghijklmnopqrstuvwxyz0123456789ABCD&code=x");
    // `ok: true` in the body must not outrank a 503 status — a vault that is
    // not configured has stored nothing.
    expect(res.status).toBe(400);
  });
});

describe("the credential ingress ops", () => {
  const post = (
    t: ReturnType<typeof convexTest>,
    body: unknown,
    key: string | null = INGRESS,
  ) =>
    t.fetch("/ai/ingress", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { "x-ai-key": key } : {}),
      },
      body: JSON.stringify(body),
    });

  async function seed(t: ReturnType<typeof convexTest>) {
    const ids = await t.run(async (ctx) => {
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
    const connectionId: Id<"mcpConnections"> = await t
      .withIdentity(as(ids.owner))
      .mutation(api.mcp.connections.create, {
        workspaceId: ids.ws,
        serverName: "acme.test/server",
        slug: "acme",
        version: "1.0.0",
        versionMode: "latest_at_connect",
        transport: "streamable-http",
        authKind: "oauth",
      });
    const otherConnectionId: Id<"mcpConnections"> = await t
      .withIdentity(as(ids.owner))
      .mutation(api.mcp.connections.create, {
        workspaceId: ids.ws,
        serverName: "acme.test/other",
        slug: "acme-other",
        version: "1.0.0",
        versionMode: "latest_at_connect",
        transport: "streamable-http",
        authKind: "oauth",
      });
    return { ...ids, connectionId, otherConnectionId };
  }

  const savePayload = (s: Awaited<ReturnType<typeof seed>>) => ({
    op: "mcp-credential-save",
    credentialId: "cred_1",
    userId: s.owner,
    workspaceId: s.ws,
    connectionId: s.connectionId,
    serverName: "acme.test/server",
    resource: "https://acme.test/mcp",
    kind: "oauth_token",
    envelope: "v1.1.AAAAAAAAAAAAAAAA.Y2lwaGVydGV4dA",
    keyVersion: 1,
    status: "active",
    rev: 1,
    expectedRev: 0,
  });

  test("every credential op is refused without the ingress key", async () => {
    const t = convexTest(schema, modules);
    for (const op of [
      "mcp-credential-load",
      "mcp-credential-save",
      "mcp-credential-mark",
      "mcp-oauth-client-load",
      "mcp-oauth-client-save",
    ]) {
      const res = await post(t, { op }, null);
      expect(res.status, op).toBe(401);
    }
  });

  test("a wrong key is refused", async () => {
    const t = convexTest(schema, modules);
    const res = await post(t, { op: "mcp-credential-load" }, "wrong-but-same-len!!");
    expect(res.status).toBe(401);
  });

  test("save then load round-trips the envelope", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    const saved = await post(t, savePayload(s));
    expect(await saved.json()).toEqual({ stored: true });

    const loaded = await post(t, {
      op: "mcp-credential-load",
      connectionId: s.connectionId,
      resource: "https://acme.test/mcp",
      kind: "oauth_token",
      userId: s.owner,
      workspaceId: s.ws,
    });
    const body = (await loaded.json()) as {
      credential: { envelope: string; rev: number } | null;
    };
    expect(body.credential?.envelope).toBe(
      "v1.1.AAAAAAAAAAAAAAAA.Y2lwaGVydGV4dA",
    );
    // `rev` must come back: it is what the next write compares against, and
    // without it rotation loses its compare-and-set guard entirely.
    expect(body.credential?.rev).toBe(1);
  });

  test("loading a credential that was never stored returns null", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const res = await post(t, {
      op: "mcp-credential-load",
      connectionId: s.connectionId,
      resource: "https://acme.test/mcp",
      kind: "oauth_token",
      userId: s.owner,
      workspaceId: s.ws,
    });
    expect(await res.json()).toEqual({ credential: null });
  });

  test("the ingress path cannot bind a credential to a non-owner", async () => {
    // The Python plane holds the ingress secret, so it CAN claim any tenant.
    // This is the check that stops a bug there writing onto someone else's
    // connection — encryption cannot catch it, because the envelope is valid.
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const stranger = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "stranger@t.test" }),
    );

    const res = await post(t, { ...savePayload(s), userId: stranger });
    expect(await res.json()).toEqual({
      stored: false,
      refused: true,
      reason: "forbidden",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("mcpCredentials").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  test("a mark names its tenant and connection; the delete op is gone", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await post(t, savePayload(s));

    // A mark that names the wrong connection is refused.
    expect(
      await (
        await post(t, {
          op: "mcp-credential-mark",
          credentialId: "cred_1",
          status: "revoked",
          userId: s.owner,
          workspaceId: s.ws,
          connectionId: s.otherConnectionId,
        })
      ).json(),
    ).toEqual({ ok: false });

    expect(
      await (
        await post(t, {
          op: "mcp-credential-mark",
          credentialId: "cred_1",
          status: "revoked",
          userId: s.owner,
          workspaceId: s.ws,
          connectionId: s.connectionId,
        })
      ).json(),
    ).toEqual({ ok: true });

    const row = await t.run(async (ctx) =>
      ctx.db.query("mcpCredentials").first(),
    );
    expect(row?.status).toBe("revoked");

    // H-17: there is no delete op. The ingress secret cannot remove a row.
    const gone = await post(t, {
      op: "mcp-credential-delete",
      credentialId: "cred_1",
    });
    expect(gone.status).toBe(400);
    expect(
      await t.run(async (ctx) => ctx.db.query("mcpCredentials").collect()),
    ).toHaveLength(1);
  });

  test("the plane-charged hourly tool-call window counts, refuses and fails closed", async () => {
    // H-09. The plane charges one unit per tool call before touching the wire.
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const charge = () =>
      post(t, { op: "mcp-quota-consume", userId: s.owner, kind: "mcpToolCall" });

    expect(await (await charge()).json()).toEqual({ ok: true });
    // Exhaust the window (LIMITS.mcpToolCall = 600): the 601st is refused with a
    // reason the plane can hand to the model.
    for (let i = 1; i < 600; i++) await charge();
    const over = (await (await charge()).json()) as { ok: boolean; detail?: string };
    expect(over.ok).toBe(false);
    expect(over.detail).toMatch(/Hourly connector call limit/);

    // A malformed charge is a 400, never a silent pass.
    expect((await post(t, { op: "mcp-quota-consume", kind: "mcpToolCall" })).status).toBe(400);
    expect(
      (await post(t, { op: "mcp-quota-consume", userId: s.owner, kind: "mcpConnect" })).status,
    ).toBe(400);
    // A suspended account has no window to charge.
    await t.run((ctx) => ctx.db.patch(s.owner, { accountStatus: "suspended" }));
    const t2 = convexTest(schema, modules);
    const s2 = await seed(t2);
    await t2.run((ctx) => ctx.db.patch(s2.owner, { accountStatus: "suspended" }));
    expect(
      await (
        await post(t2, { op: "mcp-quota-consume", userId: s2.owner, kind: "mcpToolCall" })
      ).json(),
    ).toEqual({ ok: false, detail: "account is not active" });
    // Without the ingress key: refused like every other op.
    expect((await post(t, { op: "mcp-quota-consume", userId: s.owner, kind: "mcpToolCall" }, null)).status).toBe(401);
  });

  test("the client record round-trips and is not tenant-scoped", async () => {
    const t = convexTest(schema, modules);
    await post(t, {
      op: "mcp-oauth-client-save",
      clientRecordId: "client_1",
      serverName: "acme.test/server",
      issuer: "https://issuer.test",
      envelope: "v1.1.AAAAAAAAAAAAAAAA.Y2xpZW50",
      keyVersion: 1,
      registrationMode: "dcr",
    });
    const res = await post(t, {
      op: "mcp-oauth-client-load",
      serverName: "acme.test/server",
      issuer: "https://issuer.test",
    });
    const body = (await res.json()) as {
      client: { envelope: string; registrationMode: string } | null;
    };
    expect(body.client?.envelope).toBe("v1.1.AAAAAAAAAAAAAAAA.Y2xpZW50");
    expect(body.client?.registrationMode).toBe("dcr");
  });

  test("an unknown mcp op still falls through to the 400", async () => {
    // The new cases must be additive: a typo must not become a silent success.
    const t = convexTest(schema, modules);
    const res = await post(t, { op: "mcp-credential-nonsense" });
    expect(res.status).toBe(400);
  });
});

describe("the OAuth actions are the tenancy gate", () => {
  async function seeded(t: ReturnType<typeof convexTest>) {
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
        authKind: "oauth",
      });
    return { ...ids, connectionId };
  }

  const ACTIONS = ["start", "status", "disconnect"] as const;

  test.each(ACTIONS)("%s refuses a signed-out caller", async (name) => {
    const t = convexTest(schema, modules);
    const s = await seeded(t);
    stubPlane({ auth_state: "CONNECTED" });
    await expect(
      t.action(api.mcp.oauth[name], { connectionId: s.connectionId }),
    ).rejects.toThrow();
  });

  test.each(ACTIONS)("%s refuses a same-workspace peer", async (name) => {
    // The read boundary is the USER, not the workspace: an MCP connection is a
    // personal account. And the refusal is "Not found", never "Forbidden", so
    // the error cannot become an existence oracle for someone else's id.
    const t = convexTest(schema, modules);
    const s = await seeded(t);
    const calls = stubPlane({ auth_state: "CONNECTED" });
    await expect(
      t
        .withIdentity(as(s.peer))
        .action(api.mcp.oauth[name], { connectionId: s.connectionId }),
    ).rejects.toThrow("Not found");
    // And it refused BEFORE reaching the Python plane.
    expect(calls).toHaveLength(0);
  });

  test("the tenant sent to the plane comes from the session, not from args", async () => {
    // The Python routes trust whatever tenant they are told, which is safe only
    // because this is where the tenant is resolved. An argument-supplied user id
    // here would hand any signed-in user someone else's credential.
    const t = convexTest(schema, modules);
    const s = await seeded(t);
    const calls = stubPlane({ auth_state: "CONNECTED", scope: "mcp:read" });

    await t
      .withIdentity(as(s.owner))
      .action(api.mcp.oauth.status, { connectionId: s.connectionId });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/v1/mcp/oauth/status`);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.user_id).toBe(s.owner);
    expect(body.workspace_id).toBe(s.ws);
    expect(body.connection_id).toBe(s.connectionId);
    expect(body.server_name).toBe("acme.test/server");
    // `versionMode: "pinned"` must travel as the pinned version, so a later
    // catalogue change cannot retroactively rewrite what this connection runs.
    expect(body.version).toBe("2.1.0");
  });

  test("a latest_at_connect connection sends no version", async () => {
    const t = convexTest(schema, modules);
    const s = await seeded(t);
    await t.run(async (ctx) =>
      ctx.db.patch(s.connectionId, { versionMode: "latest_at_connect" }),
    );
    const calls = stubPlane({ auth_state: "CONNECTED" });
    await t
      .withIdentity(as(s.owner))
      .action(api.mcp.oauth.status, { connectionId: s.connectionId });
    expect(JSON.parse(String(calls[0].init.body)).version).toBeNull();
  });

  test("start records that the user must act, without claiming success", async () => {
    const t = convexTest(schema, modules);
    const s = await seeded(t);
    stubPlane({
      auth_state: "AUTHORIZING",
      authorization_url: "https://issuer.test/authorize?state=st_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    });

    const report = await t
      .withIdentity(as(s.owner))
      .action(api.mcp.oauth.start, { connectionId: s.connectionId });
    expect(report.authorization_url).toContain("https://issuer.test/authorize");

    const row = await t
      .withIdentity(as(s.owner))
      .query(api.mcp.connections.get, { connectionId: s.connectionId });
    // A URL was minted; nothing has been granted. "configured" plus
    // userActionRequired, never "ready".
    expect(row?.status).toBe("configured");
    expect(row?.userActionRequired).toBe(true);
    expect(row?.lastConnectedAt).toBeUndefined();
  });

  test("a failed start leaves the connection untouched", async () => {
    const t = convexTest(schema, modules);
    const s = await seeded(t);
    stubPlane({ auth_state: "ERROR", detail: "the provider refused" }, 502);

    const report = await t
      .withIdentity(as(s.owner))
      .action(api.mcp.oauth.start, { connectionId: s.connectionId });
    expect(report.auth_state).toBe("ERROR");

    const row = await t
      .withIdentity(as(s.owner))
      .query(api.mcp.connections.get, { connectionId: s.connectionId });
    // No authorization_url came back, so nothing is in flight and the row must
    // not claim the user has something to do.
    expect(row?.userActionRequired).toBeUndefined();
  });

  test("a 503 reads as a deployment state, not as a provider failure", async () => {
    const t = convexTest(schema, modules);
    const s = await seeded(t);
    stubPlane({ detail: "MCP OAuth is not enabled" }, 503);
    const report = await t
      .withIdentity(as(s.owner))
      .action(api.mcp.oauth.start, { connectionId: s.connectionId });
    expect(report.detail).toBe(
      "authorization is not available on this deployment",
    );
  });

  test("an unconfigured deployment reports rather than throwing", async () => {
    // Throwing would log a console.error and fail every e2e script. A
    // misconfiguration is information the UI must render.
    const t = convexTest(schema, modules);
    const s = await seeded(t);
    const calls = stubPlane({ auth_state: "CONNECTED" });
    // biome-ignore lint/performance/noDelete: the action reads absence, not ""
    delete process.env.AI_BASE_URL;
    const report = await t
      .withIdentity(as(s.owner))
      .action(api.mcp.oauth.status, { connectionId: s.connectionId });
    expect(report).toEqual({
      auth_state: "ERROR",
      detail: "the AI service is not configured",
    });
    expect(calls).toHaveLength(0);
  });

  test("an unreachable plane never echoes the exception", async () => {
    const t = convexTest(schema, modules);
    const s = await seeded(t);
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("connect ECONNREFUSED 172.16.70.25:8770"));
    const report = await t
      .withIdentity(as(s.owner))
      .action(api.mcp.oauth.status, { connectionId: s.connectionId });
    expect(JSON.stringify(report)).not.toContain("172.16.70.25");
    expect(report.detail).toBe("the AI service could not be reached");
  });

  test("disconnect purges and marks only once the plane confirms the session is gone", async () => {
    // H-04. A failed remote revocation is fine (`revoked_remotely: false` is
    // where that nuance lives); what matters is `session_discarded`: on it, the
    // credential rows are purged and the row is marked, in one mutation.
    const t = convexTest(schema, modules);
    const s = await seeded(t);
    await t.mutation(internal.mcp.credentials.saveCredential, {
      credentialId: "cred_d",
      userId: s.owner,
      workspaceId: s.ws,
      connectionId: s.connectionId,
      serverName: "acme.test/server",
      resource: "https://acme.test/mcp",
      kind: "oauth_token",
      envelope: "v1.1.AAAAAAAAAAAAAAAA.Y2lwaGVydGV4dA",
      keyVersion: 1,
      status: "active",
      rev: 1,
      expectedRev: 0,
    });
    stubPlane({
      session_discarded: true,
      revoked_remotely: false,
      auth_state: "NOT_CONNECTED",
    });

    const report = await t
      .withIdentity(as(s.owner))
      .action(api.mcp.oauth.disconnect, { connectionId: s.connectionId });
    expect(report.ok).toBe(true);
    expect(report.revoked_remotely).toBe(false);
    expect(report.deleted_locally).toBe(true);

    const row = await t
      .withIdentity(as(s.owner))
      .query(api.mcp.connections.get, { connectionId: s.connectionId });
    expect(row?.status).toBe("disconnected");
    expect(
      await t.run(async (ctx) => ctx.db.query("mcpCredentials").collect()),
    ).toHaveLength(0);
    const actions = (
      await t.run(async (ctx) => ctx.db.query("auditLogs").collect())
    ).map((r) => r.action);
    expect(actions).toContain("mcp.credential_revoked");
  });

  test("disconnect leaves the row untouched when the plane is unreachable", async () => {
    // H-04, the fail-closed half. An earlier version marked the row
    // disconnected whatever the plane said — the half-closed state a late
    // refresh could resurrect. Now: no confirmation, no change, and the user is
    // told.
    const t = convexTest(schema, modules);
    const s = await seeded(t);
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    const report = await t
      .withIdentity(as(s.owner))
      .action(api.mcp.oauth.disconnect, { connectionId: s.connectionId });
    expect(report.ok).toBe(false);
    expect(report.auth_state).toBe("ERROR");
    const row = await t
      .withIdentity(as(s.owner))
      .query(api.mcp.connections.get, { connectionId: s.connectionId });
    expect(row?.status).not.toBe("disconnected");
    const actions = (
      await t.run(async (ctx) => ctx.db.query("auditLogs").collect())
    ).map((r) => r.action);
    expect(actions).not.toContain("mcp.credential_revoked");
  });

  test("disconnect leaves the row untouched when the plane did not confirm", async () => {
    const t = convexTest(schema, modules);
    const s = await seeded(t);
    stubPlane({ auth_state: "ERROR", detail: "the AI service answered 500" });
    const report = await t
      .withIdentity(as(s.owner))
      .action(api.mcp.oauth.disconnect, { connectionId: s.connectionId });
    expect(report.ok).toBe(false);
    const row = await t
      .withIdentity(as(s.owner))
      .query(api.mcp.connections.get, { connectionId: s.connectionId });
    expect(row?.status).not.toBe("disconnected");
  });

  test("a suspended account cannot start, check or disconnect — nothing reaches the plane", async () => {
    // H-03. `getUserIdentity` is a bare cast of a still-valid access token; a
    // suspended user keeps one for up to an hour. Every MCP action resolves the
    // connection through `resolveForOperation`, which now asks whether the
    // account is ACTIVE, so the token alone buys nothing.
    const t = convexTest(schema, modules);
    const s = await seeded(t);
    await t.run((ctx) => ctx.db.patch(s.owner, { accountStatus: "suspended" }));
    const calls = stubPlane({ auth_state: "CONNECTED" });
    for (const name of ["start", "status", "disconnect"] as const) {
      // Since audit F-05 the action entry resolves the caller through
      // activeCallerId (live session + active account), so a suspended account
      // is refused as "Not authenticated" before the connection is even looked
      // up — the same answer every other surface gives it.
      await expect(
        t
          .withIdentity(as(s.owner))
          .action(api.mcp.oauth[name], { connectionId: s.connectionId }),
      ).rejects.toThrow("Not authenticated");
    }
    expect(calls).toHaveLength(0);
  });

  test("the action contract is credential-free", async () => {
    const t = convexTest(schema, modules);
    const s = await seeded(t);
    stubPlane({ auth_state: "CONNECTED", scope: "mcp:read" });
    const report = await t
      .withIdentity(as(s.owner))
      .action(api.mcp.oauth.status, { connectionId: s.connectionId });
    // NOTE the honest scope of this assertion: the action is a passthrough, so
    // it documents the CONTRACT rather than enforcing it. The enforcement is on
    // the Python side — `test_mcp_oauth_routes.py` scans the actual response
    // bytes of every route for credential field names.
    expect(Object.keys(report).sort()).toEqual(["auth_state", "scope"]);
  });
});
