import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireMember } from "./orgs";
import { getUserIdOrNull, requireUserId } from "./chat/authz";
import {
  challengeS256,
  decryptSecret,
  encryptSecret,
  pkceVerifier,
  randomToken,
  UndecryptableError,
} from "./connectors/crypto";
import {
  buildAuthorizeUrl,
  fetchGa4Properties,
  fetchGscSites,
  GoogleOAuthError,
  isConfigured,
  refreshAccessToken,
  REQUIRED_SCOPES,
  revokeToken,
} from "./connectors/google";

/**
 * Phase 4 — the Google connector control plane (USER-scoped). All token material is
 * AES-GCM encrypted at rest (connectors/crypto.ts) and NEVER returned to any client,
 * put in an event, or logged. The refresh token never leaves the server. The OAuth
 * callback + the streamId-scoped access-token endpoint live in http.ts and reuse the
 * helpers here. See the plan for the account-linking-CSRF (confirm-step), refresh
 * single-flight (lockToken), and no-existence-oracle ("Not found") invariants.
 */

const PROVIDER = "google";
const AUTH_TTL_MS = 5 * 60 * 1000; // pending OAuth request lifetime
const REFRESH_LOCK_MS = 30 * 1000; // single-flight refresh lease
const ACCESS_SKEW_MS = 60 * 1000; // treat access tokens as expired 60s early
const MAX_PENDING_AUTH = 5; // per-user rate cap on begin
const REFRESH_TRIES = 4;

/** A stored token can't be used → the caller must reconnect (never a 500). */
export class NeedsReauthError extends Error {
  constructor() {
    super("connector needs reauthorization");
    this.name = "NeedsReauthError";
  }
}
/** A concurrent refresh holds the lock and hasn't published yet → retry shortly. */
export class RefreshBusyError extends Error {
  constructor() {
    super("connector token refresh busy");
    this.name = "RefreshBusyError";
  }
}

// --- OAuth initiation (authenticated) --------------------------------------
export const beginGoogleAuth = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await requireUserId(ctx);
    await requireMember(ctx, userId, workspaceId);
    if (!isConfigured()) return { configured: false as const };

    // Rate cap: bound how many pending requests a user can pile up.
    const pending = await ctx.db
      .query("connectorAuthRequests")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_PENDING_AUTH + 1);
    if (pending.length > MAX_PENDING_AUTH) {
      throw new ConvexError("Too many pending connection attempts");
    }

    const verifier = pkceVerifier();
    const challenge = await challengeS256(verifier);
    const state = randomToken();
    const nonce = randomToken();
    await ctx.db.insert("connectorAuthRequests", {
      userId,
      workspaceId,
      provider: PROVIDER,
      pkceVerifier: verifier,
      state,
      nonce,
      scopes: REQUIRED_SCOPES,
      createdAt: Date.now(),
      expiresAt: Date.now() + AUTH_TTL_MS,
    });
    // Return ONLY the authorize URL — never the verifier/nonce.
    return {
      configured: true as const,
      authorizeUrl: buildAuthorizeUrl({ state, codeChallenge: challenge, nonce }),
    };
  },
});

/** INTERNAL (callback only): atomically CONSUME a pending request by state — a single
 *  read+expiry-check+delete under OCC, so a replayed state can't be used twice. */
export const consumeAuthRequest = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, { state }) => {
    const row = await ctx.db
      .query("connectorAuthRequests")
      .withIndex("by_state", (q) => q.eq("state", state))
      .unique();
    if (!row) return null;
    await ctx.db.delete(row._id); // one-time, whether valid or expired
    if (row.expiresAt < Date.now()) return null;
    return {
      userId: row.userId,
      workspaceId: row.workspaceId,
      pkceVerifier: row.pkceVerifier,
      nonce: row.nonce,
      scopes: row.scopes,
    };
  },
});

/** INTERNAL (callback only): store the freshly-exchanged tokens as an UNCONFIRMED
 *  account owned by the initiating user. Returns a stale refresh blob to revoke when
 *  reconnecting a DIFFERENT Google account. */
export const upsertUnconfirmedAccount = internalMutation({
  args: {
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    googleSub: v.string(),
    email: v.string(),
    scopes: v.array(v.string()),
    encRefreshToken: v.string(),
  },
  handler: async (ctx, a) => {
    const existing = await ctx.db
      .query("connectorAccounts")
      .withIndex("by_user_provider", (q) =>
        q.eq("userId", a.userId).eq("provider", PROVIDER),
      )
      .unique();
    const now = Date.now();
    const fields = {
      workspaceId: a.workspaceId,
      googleSub: a.googleSub,
      email: a.email,
      scopes: a.scopes,
      status: "unconfirmed",
      encRefreshToken: a.encRefreshToken,
      encAccessToken: undefined,
      accessExpiresAt: undefined,
      refreshLockUntil: undefined,
      refreshLockToken: undefined,
      updatedAt: now,
    };
    if (existing) {
      const staleRefreshEnc =
        existing.googleSub && existing.googleSub !== a.googleSub
          ? existing.encRefreshToken
          : undefined;
      await ctx.db.patch(existing._id, fields);
      return { accountId: existing._id, staleRefreshEnc };
    }
    const accountId = await ctx.db.insert("connectorAccounts", {
      userId: a.userId,
      provider: PROVIDER,
      createdAt: now,
      ...fields,
    });
    return { accountId, staleRefreshEnc: undefined };
  },
});

/** The account-linking-CSRF fix: only the INITIATOR (the session whose userId owns the
 *  pending/unconfirmed row) can promote it to active. A victim whose browser completed
 *  the consent cannot confirm the attacker's row (and vice-versa). */
export const confirmConnection = mutation({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const userId = await requireUserId(ctx);
    const id = ctx.db.normalizeId("connectorAccounts", accountId);
    const acct = id ? await ctx.db.get(id) : null;
    if (!acct || acct.userId !== userId) throw new ConvexError("Not found");
    if (acct.status === "unconfirmed") {
      await ctx.db.patch(acct._id, { status: "active", updatedAt: Date.now() });
    }
    return { email: acct.email, status: "active" as const };
  },
});

// --- status (SOFT read; never a token) -------------------------------------
export const status = query({
  args: {},
  handler: async (ctx) => {
    const configured = isConfigured();
    const userId = await getUserIdOrNull(ctx);
    if (!userId) return { configured, connected: false as const };
    const acct = await ctx.db
      .query("connectorAccounts")
      .withIndex("by_user_provider", (q) =>
        q.eq("userId", userId).eq("provider", PROVIDER),
      )
      .unique();
    if (!acct || acct.status === "revoked") {
      return { configured, connected: false as const };
    }
    const props = await ctx.db
      .query("connectorProperties")
      .withIndex("by_user_kind", (q) => q.eq("userId", userId))
      .collect();
    const sel = (kind: string) =>
      props.find((p) => p.kind === kind && p.selected)?.propertyId ?? null;
    return {
      configured,
      connected: acct.status === "active" || acct.status === "needs_reauth",
      status: acct.status,
      email: acct.email,
      scopes: acct.scopes,
      accountId: acct._id,
      gscSite: sel("gsc_site"),
      ga4Property: sel("ga4_property"),
    };
  },
});

// --- internal reads (enc material stays internal) --------------------------
export const getAccountById = internalQuery({
  args: { accountId: v.id("connectorAccounts") },
  handler: (ctx, { accountId }) => ctx.db.get(accountId),
});

/** streamId → the stream's user → their connector (for /ai/connector-token). */
export const resolveStreamConnector = internalQuery({
  args: { streamId: v.string() },
  handler: async (ctx, { streamId }) => {
    const stream = await ctx.db
      .query("chatStreams")
      .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
      .unique();
    if (!stream) return { connected: false as const };
    const acct = await ctx.db
      .query("connectorAccounts")
      .withIndex("by_user_provider", (q) =>
        q.eq("userId", stream.userId).eq("provider", PROVIDER),
      )
      .unique();
    if (!acct || acct.status !== "active") {
      return { connected: false as const, status: acct?.status };
    }
    const props = await ctx.db
      .query("connectorProperties")
      .withIndex("by_user_kind", (q) => q.eq("userId", stream.userId))
      .collect();
    const sel = (kind: string) =>
      props.find((p) => p.kind === kind && p.selected)?.propertyId ?? null;
    return {
      connected: true as const,
      accountId: acct._id,
      scopes: acct.scopes,
      gscSite: sel("gsc_site"),
      ga4Property: sel("ga4_property"),
    };
  },
});

// --- refresh single-flight (lockToken guards a lease-stealing race) ---------
export const claimRefresh = internalMutation({
  args: { accountId: v.id("connectorAccounts") },
  handler: async (ctx, { accountId }) => {
    const acct = await ctx.db.get(accountId);
    if (!acct) return { locked: false as const, gone: true as const };
    if (acct.refreshLockUntil && acct.refreshLockUntil > Date.now()) {
      return { locked: true as const };
    }
    const lockToken = randomToken(16);
    await ctx.db.patch(accountId, {
      refreshLockUntil: Date.now() + REFRESH_LOCK_MS,
      refreshLockToken: lockToken,
    });
    return { locked: false as const, lockToken, encRefreshToken: acct.encRefreshToken };
  },
});

export const storeRefreshedTokens = internalMutation({
  args: {
    accountId: v.id("connectorAccounts"),
    lockToken: v.string(),
    encAccessToken: v.string(),
    accessExpiresAt: v.number(),
    encRefreshToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const acct = await ctx.db.get(a.accountId);
    if (!acct) return { stale: true as const };
    // Only the current lease holder may publish (a stolen-lease writer is discarded).
    if (acct.refreshLockToken !== a.lockToken) return { stale: true as const };
    await ctx.db.patch(a.accountId, {
      encAccessToken: a.encAccessToken,
      accessExpiresAt: a.accessExpiresAt,
      ...(a.encRefreshToken ? { encRefreshToken: a.encRefreshToken } : {}),
      status: "active",
      refreshLockUntil: undefined,
      refreshLockToken: undefined,
      updatedAt: Date.now(),
    });
    return { stale: false as const };
  },
});

export const markNeedsReauth = internalMutation({
  args: { accountId: v.id("connectorAccounts") },
  handler: async (ctx, { accountId }) => {
    const acct = await ctx.db.get(accountId);
    if (!acct) return;
    await ctx.db.patch(accountId, {
      status: "needs_reauth",
      refreshLockUntil: undefined,
      refreshLockToken: undefined,
      updatedAt: Date.now(),
    });
  },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Return a fresh plaintext access token for an account, refreshing under the
 *  single-flight lock if the cache is stale. Used by BOTH the /ai/connector-token
 *  httpAction and listGoogleProperties. Throws NeedsReauthError / RefreshBusyError.
 *  The plaintext token exists only transiently here — never stored/logged/evented. */
export async function getFreshAccessToken(
  ctx: ActionCtx,
  accountId: Id<"connectorAccounts">,
): Promise<string> {
  for (let attempt = 0; attempt < REFRESH_TRIES; attempt++) {
    const acct = await ctx.runQuery(internal.connectors.getAccountById, { accountId });
    if (!acct || acct.status === "revoked") throw new NeedsReauthError();
    if (acct.status === "needs_reauth") throw new NeedsReauthError();
    if (
      acct.encAccessToken &&
      acct.accessExpiresAt &&
      acct.accessExpiresAt > Date.now() + ACCESS_SKEW_MS
    ) {
      try {
        return await decryptSecret(acct.encAccessToken);
      } catch {
        // fall through to a refresh (cache blob is undecryptable)
      }
    }
    const claim = await ctx.runMutation(internal.connectors.claimRefresh, { accountId });
    if ("gone" in claim && claim.gone) throw new NeedsReauthError();
    if (claim.locked) {
      await sleep(300); // let the lease holder publish, then re-read the cache
      continue;
    }
    let refreshPlain: string;
    try {
      refreshPlain = await decryptSecret(claim.encRefreshToken as string);
    } catch (e) {
      if (e instanceof UndecryptableError) {
        await ctx.runMutation(internal.connectors.markNeedsReauth, { accountId });
        throw new NeedsReauthError();
      }
      throw e;
    }
    let tok: Awaited<ReturnType<typeof refreshAccessToken>>;
    try {
      tok = await refreshAccessToken(refreshPlain);
    } catch (e) {
      if (e instanceof GoogleOAuthError && e.reason === "invalid_grant") {
        await ctx.runMutation(internal.connectors.markNeedsReauth, { accountId });
        throw new NeedsReauthError();
      }
      throw e;
    }
    const store = await ctx.runMutation(internal.connectors.storeRefreshedTokens, {
      accountId,
      lockToken: claim.lockToken as string,
      encAccessToken: await encryptSecret(tok.accessToken),
      accessExpiresAt: Date.now() + tok.expiresInS * 1000,
      encRefreshToken: tok.refreshToken
        ? await encryptSecret(tok.refreshToken)
        : undefined,
    });
    if (store.stale) {
      await sleep(200); // lost the lease race; re-read the winner's fresh token
      continue;
    }
    return tok.accessToken;
  }
  throw new RefreshBusyError();
}

// --- property discovery + selection ----------------------------------------
export const upsertProperties = internalMutation({
  args: {
    userId: v.id("users"),
    accountId: v.id("connectorAccounts"),
    props: v.array(
      v.object({
        kind: v.string(),
        propertyId: v.string(),
        displayName: v.string(),
        permission: v.string(),
      }),
    ),
  },
  handler: async (ctx, a) => {
    const existing = await ctx.db
      .query("connectorProperties")
      .withIndex("by_account", (q) => q.eq("accountId", a.accountId))
      .collect();
    const seen = new Set(existing.map((e) => `${e.kind}:${e.propertyId}`));
    const stillValid = new Set(a.props.map((p) => `${p.kind}:${p.propertyId}`));
    // Drop properties the user no longer has access to (keep selection otherwise).
    for (const e of existing) {
      if (!stillValid.has(`${e.kind}:${e.propertyId}`)) await ctx.db.delete(e._id);
    }
    for (const p of a.props) {
      if (seen.has(`${p.kind}:${p.propertyId}`)) continue;
      await ctx.db.insert("connectorProperties", {
        userId: a.userId,
        accountId: a.accountId,
        kind: p.kind,
        propertyId: p.propertyId,
        displayName: p.displayName,
        permission: p.permission,
        selected: false,
      });
    }
  },
});

export const listGoogleProperties = action({
  args: {},
  handler: async (ctx): Promise<{ gscSites: unknown[]; ga4Properties: unknown[] }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");
    const acct = await ctx.runQuery(internal.connectors.getAccountForUser, { userId });
    if (!acct) throw new ConvexError("Not found");
    let token: string;
    try {
      token = await getFreshAccessToken(ctx, acct._id);
    } catch (e) {
      if (e instanceof NeedsReauthError) throw new ConvexError("Reconnect required");
      throw e;
    }
    const [gsc, ga4] = await Promise.all([
      fetchGscSites(token).catch(() => []),
      fetchGa4Properties(token).catch(() => []),
    ]);
    await ctx.runMutation(internal.connectors.upsertProperties, {
      userId,
      accountId: acct._id,
      props: [...gsc, ...ga4],
    });
    return { gscSites: gsc, ga4Properties: ga4 };
  },
});

export const getAccountForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: (ctx, { userId }) =>
    ctx.db
      .query("connectorAccounts")
      .withIndex("by_user_provider", (q) =>
        q.eq("userId", userId).eq("provider", PROVIDER),
      )
      .unique(),
});

export const selectProperty = mutation({
  args: { kind: v.string(), propertyId: v.string() },
  handler: async (ctx, { kind, propertyId }) => {
    const userId = await requireUserId(ctx);
    const props = await ctx.db
      .query("connectorProperties")
      .withIndex("by_user_kind", (q) => q.eq("userId", userId).eq("kind", kind))
      .collect();
    const target = props.find((p) => p.propertyId === propertyId);
    if (!target) throw new ConvexError("Not found"); // ownership re-validated
    for (const p of props) {
      if (p.selected !== (p._id === target._id)) {
        await ctx.db.patch(p._id, { selected: p._id === target._id });
      }
    }
    return { ok: true as const };
  },
});

// --- disconnect / revoke ---------------------------------------------------
export const disconnect = action({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; grantMayPersist?: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");
    const acct = await ctx.runQuery(internal.connectors.getAccountForUser, { userId });
    if (!acct) return { ok: true };
    let revoked = false;
    let grantMayPersist = false;
    try {
      const refresh = await decryptSecret(acct.encRefreshToken);
      revoked = await revokeToken(refresh);
    } catch {
      grantMayPersist = true; // couldn't decrypt → can't revoke
    }
    if (revoked || grantMayPersist) {
      // Revoked at Google (or unrevokable) → safe to delete the local rows.
      await ctx.runMutation(internal.connectors.deleteAccountRows, {
        accountId: acct._id,
      });
      return { ok: true, grantMayPersist };
    }
    // Revoke returned false (transient) → keep the row for the retry cron.
    await ctx.runMutation(internal.connectors.markPendingRevoke, {
      accountId: acct._id,
    });
    return { ok: true, grantMayPersist: true };
  },
});

export const deleteAccountRows = internalMutation({
  args: { accountId: v.id("connectorAccounts") },
  handler: async (ctx, { accountId }) => {
    const props = await ctx.db
      .query("connectorProperties")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect();
    for (const p of props) await ctx.db.delete(p._id);
    await ctx.db.delete(accountId);
  },
});

export const markPendingRevoke = internalMutation({
  args: { accountId: v.id("connectorAccounts") },
  handler: async (ctx, { accountId }) => {
    const acct = await ctx.db.get(accountId);
    if (acct) await ctx.db.patch(accountId, { status: "pending_revoke" });
  },
});

// --- account-deletion cascade (called from users.deleteUserAccount) --------
/** Plain helper (not a Convex fn) so the existing user-deletion mutation can call it
 *  inline, mirroring the userMemories batched-delete pattern. Best-effort: deletes the
 *  local rows; a live Google grant is the user's to remove at myaccount.google.com. */
export async function deleteConnectorsForUser(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const accounts = await ctx.db
    .query("connectorAccounts")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const a of accounts) await ctx.db.delete(a._id);
  const props = await ctx.db
    .query("connectorProperties")
    .withIndex("by_user_kind", (q) => q.eq("userId", userId))
    .collect();
  for (const p of props) await ctx.db.delete(p._id);
  const reqs = await ctx.db
    .query("connectorAuthRequests")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const r of reqs) await ctx.db.delete(r._id);
}

// --- crons -----------------------------------------------------------------
export const reapAuthRequests = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db
      .query("connectorAuthRequests")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
      .take(200);
    for (const r of expired) await ctx.db.delete(r._id);
  },
});

export const listPendingRevoke = internalQuery({
  args: {},
  handler: (ctx): Promise<Doc<"connectorAccounts">[]> =>
    ctx.db
      .query("connectorAccounts")
      .withIndex("by_status", (q) => q.eq("status", "pending_revoke"))
      .take(50),
});

export const retryPendingRevoke = internalAction({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.runQuery(internal.connectors.listPendingRevoke, {});
    for (const acct of rows) {
      let ok = false;
      try {
        ok = await revokeToken(await decryptSecret(acct.encRefreshToken));
      } catch {
        ok = true; // undecryptable → give up revoking; delete the dead row
      }
      if (ok) {
        await ctx.runMutation(internal.connectors.deleteAccountRows, {
          accountId: acct._id,
        });
      }
    }
  },
});
