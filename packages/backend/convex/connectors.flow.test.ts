/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { decryptSecret, encryptSecret } from "./connectors/crypto";

// Harness-based tests for the OAuth flow, the account-linking-CSRF confirm-step, the
// refresh single-flight lock, property ownership, and token-never-exposed. Google's
// HTTP is stubbed via vi.stubGlobal("fetch").

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
const KEY = btoa(String.fromCharCode(...new Array(32).fill(42)));
const CLIENT_ID = "test-connector-client.apps.googleusercontent.com";
const INGRESS = "test-ingress-secret-0123456789ab";

// Warm the http router module once (loading @convex-dev/polar is slow the first
// time) so no individual t.fetch test bears the cost and times out.
beforeAll(async () => {
  const t = convexTest(schema, modules);
  await t
    .fetch("/ai/connector-token", { method: "POST", body: "{}" })
    .catch(() => {});
}, 60_000);

function setConnectorEnv() {
  process.env.CONNECTOR_ENC_KEY = KEY;
  process.env.CONNECTOR_GOOGLE_ID = CLIENT_ID;
  process.env.CONNECTOR_GOOGLE_SECRET = "test-secret";
  process.env.CONNECTOR_REDIRECT_URI =
    "https://app.example.com/__cvx-site/connector/google/callback";
  process.env.SITE_URL = "https://app.example.com";
  process.env.AI_INGRESS_SECRET = INGRESS;
}

async function seed(t: TestT, streamId = `s_${Math.random()}`) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "owner@t.test" });
    const otherId = await ctx.db.insert("users", { email: "other@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId,
      userId,
      role: "owner",
      createdAt: Date.now(),
    });
    const threadId = await ctx.db.insert("chatThreads", {
      userId,
      workspaceId,
      title: "t",
      titleSource: "user",
      status: "active",
      pinned: false,
      model: "m",
      nextSeq: 1,
      messageCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const messageId = await ctx.db.insert("chatMessages", {
      threadId,
      userId,
      workspaceId,
      role: "assistant",
      content: "",
      seq: 0,
      status: "streaming",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("chatStreams", {
      streamId,
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
    return { userId, otherId, workspaceId, streamId };
  });
}

async function insertAccount(
  t: TestT,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
  over: Record<string, unknown> = {},
) {
  const encRefreshToken = await encryptSecret("1//the-refresh-token");
  return t.run((ctx) =>
    ctx.db.insert("connectorAccounts", {
      userId,
      workspaceId,
      provider: "google",
      googleSub: "sub-123",
      email: "owner@gmail.com",
      scopes: [
        "https://www.googleapis.com/auth/webmasters.readonly",
        "https://www.googleapis.com/auth/analytics.readonly",
      ],
      status: "active",
      encRefreshToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...over,
    }),
  );
}

function idToken(nonce: string): string {
  const b64url = (o: unknown) =>
    btoa(JSON.stringify(o))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const payload = {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce,
    sub: "google-sub-abc",
    email: "owner@gmail.com",
    email_verified: true,
  };
  return `h.${b64url(payload)}.sig`;
}

describe("connectors — OAuth begin + atomic one-time state", () => {
  beforeEach(setConnectorEnv);

  test("beginGoogleAuth returns an authorize URL (no verifier) + a pending row", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const res = await t
      .withIdentity(as(userId))
      .mutation(api.connectors.beginGoogleAuth, { workspaceId });
    expect(res.configured).toBe(true);
    const url = new URL((res as { authorizeUrl: string }).authorizeUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toContain("webmasters.readonly");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(JSON.stringify(res)).not.toContain("code_verifier");
    const rows = await t.run((ctx) =>
      ctx.db.query("connectorAuthRequests").collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.pkceVerifier).toBeTruthy();
  });

  test("consumeAuthRequest is one-time: a replayed state returns null", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    await t.run((ctx) =>
      ctx.db.insert("connectorAuthRequests", {
        userId,
        workspaceId,
        provider: "google",
        pkceVerifier: "v",
        state: "STATE1",
        nonce: "N",
        scopes: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
    );
    const first = await t.run((ctx) =>
      ctx.runMutation(internal.connectors.consumeAuthRequest, { state: "STATE1" }),
    );
    expect(first).not.toBeNull();
    const replay = await t.run((ctx) =>
      ctx.runMutation(internal.connectors.consumeAuthRequest, { state: "STATE1" }),
    );
    expect(replay).toBeNull();
  });
});

describe("connectors — confirm-step (account-linking CSRF fix)", () => {
  beforeEach(setConnectorEnv);

  test("only the INITIATOR can confirm; a peer gets Not found", async () => {
    const t = convexTest(schema, modules);
    const { userId, otherId, workspaceId } = await seed(t);
    const accountId = await insertAccount(t, userId, workspaceId, {
      status: "unconfirmed",
    });
    await expect(
      t
        .withIdentity(as(otherId))
        .mutation(api.connectors.confirmConnection, { accountId }),
    ).rejects.toThrow("Not found");
    const res = await t
      .withIdentity(as(userId))
      .mutation(api.connectors.confirmConnection, { accountId });
    expect(res.status).toBe("active");
    expect(res.email).toBe("owner@gmail.com");
  });
});

describe("connectors — status never leaks a token, soft when signed out", () => {
  beforeEach(setConnectorEnv);

  test("signed-out status is soft (connected:false), never throws", async () => {
    const t = convexTest(schema, modules);
    const res = await t.query(api.connectors.status, {});
    expect(res.connected).toBe(false);
  });

  test("connected status returns email/scopes but NO token or ciphertext", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    await insertAccount(t, userId, workspaceId, {
      encAccessToken: await encryptSecret("access-tok"),
      accessExpiresAt: Date.now() + 3600_000,
    });
    const res = await t.withIdentity(as(userId)).query(api.connectors.status, {});
    expect(res.connected).toBe(true);
    const blob = JSON.stringify(res);
    expect(blob).not.toContain("the-refresh-token");
    expect(blob).not.toContain("access-tok");
    expect(blob).not.toContain("encRefreshToken");
    expect(blob).not.toContain("encAccessToken");
  });
});

describe("connectors — property selection ownership", () => {
  beforeEach(setConnectorEnv);

  test("selecting a property not in the user's grant is Not found", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const accountId = await insertAccount(t, userId, workspaceId);
    await t.run((ctx) =>
      ctx.db.insert("connectorProperties", {
        userId,
        accountId,
        kind: "gsc_site",
        propertyId: "https://mine.example/",
        displayName: "mine",
        permission: "siteOwner",
        selected: false,
      }),
    );
    await expect(
      t.withIdentity(as(userId)).mutation(api.connectors.selectProperty, {
        kind: "gsc_site",
        propertyId: "https://not-mine.example/",
      }),
    ).rejects.toThrow("Not found");
    await t.withIdentity(as(userId)).mutation(api.connectors.selectProperty, {
      kind: "gsc_site",
      propertyId: "https://mine.example/",
    });
    const rows = await t.run((ctx) =>
      ctx.db.query("connectorProperties").collect(),
    );
    expect(rows[0]?.selected).toBe(true);
  });
});

describe("connectors — refresh single-flight lock", () => {
  beforeEach(setConnectorEnv);

  test("claimRefresh is exclusive; a stale lockToken store is discarded", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const accountId = await insertAccount(t, userId, workspaceId);
    const first = await t.run((ctx) =>
      ctx.runMutation(internal.connectors.claimRefresh, { accountId }),
    );
    expect(first.locked).toBe(false);
    const second = await t.run((ctx) =>
      ctx.runMutation(internal.connectors.claimRefresh, { accountId }),
    );
    expect(second.locked).toBe(true);
    const stale = await t.run((ctx) =>
      ctx.runMutation(internal.connectors.storeRefreshedTokens, {
        accountId,
        lockToken: "wrong",
        encAccessToken: "x",
        accessExpiresAt: Date.now() + 1000,
      }),
    );
    expect(stale.stale).toBe(true);
    const ok = await t.run((ctx) =>
      ctx.runMutation(internal.connectors.storeRefreshedTokens, {
        accountId,
        lockToken: (first as { lockToken: string }).lockToken,
        encAccessToken: "enc",
        accessExpiresAt: Date.now() + 1000,
      }),
    );
    expect(ok.stale).toBe(false);
    const acct = await t.run((ctx) => ctx.db.get(accountId));
    expect(acct?.refreshLockToken).toBeUndefined();
  });
});

describe("connectors — /ai/connector-token (streamId-scoped, never the refresh token)", () => {
  beforeEach(setConnectorEnv);
  afterEach(() => vi.unstubAllGlobals());

  const post = (t: TestT, body: unknown, key = INGRESS) =>
    t.fetch("/ai/connector-token", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai-key": key },
      body: JSON.stringify(body),
    });

  test("returns the cached access token for the stream's user, not the refresh token", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId, streamId } = await seed(t);
    await insertAccount(t, userId, workspaceId, {
      encAccessToken: await encryptSecret("LIVE-ACCESS-TOKEN"),
      accessExpiresAt: Date.now() + 3600_000,
    });
    const res = await post(t, { streamId });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.connected).toBe(true);
    expect(j.accessToken).toBe("LIVE-ACCESS-TOKEN");
    expect(JSON.stringify(j)).not.toContain("the-refresh-token");
  });

  test("a stream with no connected account returns connected:false", async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seed(t);
    const res = await post(t, { streamId });
    expect(res.status).toBe(200);
    expect((await res.json()).connected).toBe(false);
  });

  test("needs_reauth returns 409 so Python degrades honestly", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId, streamId } = await seed(t);
    await insertAccount(t, userId, workspaceId, { status: "needs_reauth" });
    const res = await post(t, { streamId });
    expect(res.status).toBe(409);
  });

  test("a wrong ingress secret is 401", async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seed(t);
    const res = await post(t, { streamId }, "wrong-secret");
    expect(res.status).toBe(401);
  });
});

describe("connectors — OAuth callback stores an ENCRYPTED, unconfirmed account", () => {
  beforeEach(setConnectorEnv);
  afterEach(() => vi.unstubAllGlobals());

  test("callback exchanges the code, encrypts the refresh token, 302s to confirm", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const state = "CB_STATE";
    const nonce = "CB_NONCE";
    await t.run((ctx) =>
      ctx.db.insert("connectorAuthRequests", {
        userId,
        workspaceId,
        provider: "google",
        pkceVerifier: "verifier-xyz",
        state,
        nonce,
        scopes: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({
              access_token: "acc",
              refresh_token: "SECRET-REFRESH",
              expires_in: 3600,
              scope:
                "https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly",
              id_token: idToken(nonce),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const res = await t.fetch(
      `/connector/google/callback?code=abc&state=${state}`,
      { method: "GET", redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location") ?? "").toContain(
      "/settings/connections?confirm=",
    );
    const accts = await t.run((ctx) =>
      ctx.db.query("connectorAccounts").collect(),
    );
    expect(accts.length).toBe(1);
    expect(accts[0]?.status).toBe("unconfirmed");
    expect(accts[0]?.encRefreshToken).not.toContain("SECRET-REFRESH");
    const enc = accts[0]?.encRefreshToken;
    expect(enc && (await decryptSecret(enc))).toBe("SECRET-REFRESH");
  });

  test("a replayed/expired state 302s to an error and stores nothing", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const res = await t.fetch(
      "/connector/google/callback?code=abc&state=UNKNOWN",
      { method: "GET", redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location") ?? "").toContain("error=");
    expect(
      (await t.run((ctx) => ctx.db.query("connectorAccounts").collect())).length,
    ).toBe(0);
  });
});
