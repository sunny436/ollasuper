import { getAuthUserId } from "@convex-dev/auth/server";
import { isActiveUser } from "./accountState";
import { consumeWindow } from "./quotas";
import { normalizeEmail } from "./authPolicy";
import { recordAuthEvent, revokeOtherSessions } from "./authEvents";
import { deliverCode, generateNumericCode } from "./authCodes";
import { Scrypt } from "lucia";
import { ConvexError } from "convex/values";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  type MutationCtx,
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { deleteResearchRunsForUser } from "./researchRuns";
import { deleteMutationsForUser } from "./seoMutations";
import { polar } from "./subscriptions";
import {
  USERNAME_TAKEN_MESSAGE,
  assertUsableUsername,
  normalizeDisplayName,
} from "./profilePolicy";
import { assertNonExecutableBlob } from "./blobSafety";

/**
 * The display name behind an address, for addressing an auth email.
 *
 * INTERNAL and deliberately minimal: it returns a name or null and nothing
 * else, so it can never become an account-existence oracle — every caller
 * (authCodes.deliverCode) already knows the address, and a missing name and a
 * missing account are indistinguishable in the result.
 *
 * Falls back to the non-normalised `email` index for rows created before
 * `emailNormalized` existed; those are exactly the pre-migration users who
 * would otherwise silently never get a greeting.
 */
export const nameByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<string | null> => {
    const normalized = normalizeEmail(email);
    const byNormalized = await ctx.db
      .query("users")
      .withIndex("by_email_normalized", (q) =>
        q.eq("emailNormalized", normalized),
      )
      .first();
    const user =
      byNormalized ??
      (await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .first());
    const name = user?.name?.trim();
    return name ? name : null;
  },
});

export const getUser = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return;
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return;
    }
    const subscription = await polar.getCurrentSubscription(ctx, {
      userId: user._id,
    });
    // EXPLICIT PROJECTION, never `...user`. The spread shipped the whole row to
    // the browser: `imageId` (a storage id — this repo's own rule is that a
    // storageId never leaves a public function), plus emailNormalized,
    // accountStatus, passwordChangedAt, lastLoginAt, lastActivityAt and phone.
    // None of it is rendered; all of it was account metadata an XSS or a curious
    // user could read. Only what a consumer actually reads is returned.
    return {
      _id: user._id,
      // `name` stays `username || name` — the chat account footer + dashboard
      // sidebar render it as the account's display name and would blank out for
      // users with no display name if this changed. `displayName` exposes the
      // raw `users.name` column so the Settings profile editor can edit it.
      name: user.username || user.name,
      displayName: user.name ?? null,
      username: user.username ?? null,
      email: user.email ?? null,
      emailVerified: user.emailVerificationTime !== undefined,
      subscription,
      avatarUrl: user.imageId
        ? await ctx.storage.getUrl(user.imageId)
        : undefined,
    };
  },
});

export const updateName = mutation({
  args: {
    name: v.string(),
  },
  handler: async (ctx, args) => {
    // THROW, never return silently: a caller with no session used to get a
    // success it never earned, and the UI reported "saved".
    const userId = await requireProfileUserId(ctx);
    await ctx.db.patch(userId, { name: normalizeDisplayName(args.name) });
  },
});

/**
 * The userId for any profile write: from the SESSION, never an argument, and
 * refused outright for a suspended or already-deleted account.
 */
async function requireProfileUserId(ctx: MutationCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not authenticated");
  if (!(await isActiveUser(ctx, userId))) {
    throw new ConvexError("Not authenticated");
  }
  return userId;
}

/**
 * Claim a username for `userId`, or throw.
 *
 * UNIQUENESS LIVES HERE because Convex has no unique constraint — and that is
 * sufficient rather than a compromise: a Convex mutation is a serializable
 * transaction, so this read-then-write either sees a conflicting claim or loses
 * the OCC race and retries. Two users racing the same name cannot both win.
 *
 * EXISTING DUPLICATES ARE GRANDFATHERED. The column was never unique, so live
 * rows may already collide; enforcing retroactively would lock those people out
 * of their own profile. The rule binds new writes only, and
 * `profileIntegrityReport` lists what predates it.
 */
async function claimUsername(
  ctx: MutationCtx,
  userId: Id<"users">,
  raw: string,
): Promise<string> {
  const value = assertUsableUsername(raw);
  const holder = await ctx.db
    .query("users")
    .withIndex("by_username", (q) => q.eq("username", value))
    .first();
  if (holder && holder._id !== userId) {
    throw new ConvexError(USERNAME_TAKEN_MESSAGE);
  }
  return value;
}

export const updateUsername = mutation({
  args: {
    username: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireProfileUserId(ctx);
    const value = await claimUsername(ctx, userId, args.username);
    const before = (await ctx.db.get(userId))?.username;
    await ctx.db.patch(userId, { username: value });
    if (before !== value) {
      await recordAuthEvent(ctx, {
        type: "username_changed",
        userId,
        // The VALUES are the user's own public identity, not a secret; recording
        // them is what makes an impersonation attempt reviewable afterwards.
        meta: { from: before ?? "", to: value },
      });
    }
  },
});

/**
 * Existing rows that predate the uniqueness/format rules. Operator-only.
 */
export const profileIntegrityReport = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const byName = new Map<string, number>();
    const invalid: { userId: string; username: string; why: string }[] = [];
    for (const u of users) {
      const name = u.username;
      if (!name) continue;
      byName.set(name, (byName.get(name) ?? 0) + 1);
      try {
        assertUsableUsername(name);
      } catch (e) {
        invalid.push({
          userId: u._id,
          username: name,
          why: (e as { data?: string }).data ?? "invalid",
        });
      }
    }
    const duplicates = [...byName.entries()]
      .filter(([, n]) => n > 1)
      .map(([name, n]) => ({ username: name, holders: n }));
    return { scanned: users.length, duplicates, invalid };
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("User not found");
    }
    return await ctx.storage.generateUploadUrl();
  },
});

export const updateUserImage = mutation({
  args: {
    imageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return;
    }
    // This id becomes `user.imageId`, and `users.ts` mints its URL with
    // ctx.storage.getUrl() — which on this deployment is the APP'S OWN ORIGIN.
    // An avatar uploaded as text/html is therefore stored same-origin script
    // execution, reachable by anyone who is handed the URL. generateUploadUrl
    // lets the client choose the blob's content-type, so the check has to be
    // here, on the blob's real metadata, at the moment it becomes a row.
    // An avatar is an image; refusing costs the feature nothing.
    await assertNonExecutableBlob(ctx, args.imageId);
    ctx.db.patch(userId, { imageId: args.imageId });
  },
});

export const removeUserImage = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return;
    }
    ctx.db.patch(userId, { imageId: undefined, image: undefined });
  },
});

export const deleteUserAccount = internalMutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    // Tear the AUTH state down first, and all of it.
    //
    // This used to delete only the "google" account, leaving behind the password
    // credential, every session, every refresh token, the verification codes and
    // the rate-limit rows. Two things followed, both provable from the library:
    //
    //  - THE DELETED USER STAYED SIGNED IN. refreshTokenIfValid checks only the
    //    token and session expiry, never whether the user still exists
    //    (implementation/refreshTokens.js:71-95), and getAuthUserId is a bare
    //    cast of the JWT subject (implementation/sessions.js:74-81). So the
    //    account kept minting access tokens for the full inactivity window.
    //  - THE ADDRESS BECAME PERMANENTLY UNREGISTERABLE. The orphaned password
    //    account is found on the next sign-up, and upsertUserAndAccount then
    //    patches a deleted user id, producing the library's own diagnostic:
    //    "either the user has been deleted but their account has not"
    //    (implementation/users.js:67-70).
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", args.userId))
      .collect();
    for (const account of accounts) {
      // Codes outlive their account otherwise, and verifyCodeAndSignIn finds
      // them by code hash alone.
      const codes = await ctx.db
        .query("authVerificationCodes")
        .withIndex("accountId", (q) => q.eq("accountId", account._id))
        .collect();
      for (const code of codes) await ctx.db.delete(code._id);
      // The brute-force bucket is keyed on the account id.
      const limit = await ctx.db
        .query("authRateLimits")
        .withIndex("identifier", (q) => q.eq("identifier", account._id))
        .unique();
      if (limit) await ctx.db.delete(limit._id);
      await ctx.db.delete(account._id);
    }

    // Sessions AND their refresh tokens. `keep: null` means keep nothing — the
    // same helper single-device enforcement uses, so there is one implementation
    // of "revoke everything" rather than two that can drift.
    await revokeOtherSessions(ctx, args.userId, null);

    // Code-verification buckets are keyed on the email, not the account id.
    const user = await ctx.db.get(args.userId);
    for (const identifier of new Set(
      [user?.email, user?.emailNormalized].filter(
        (e): e is string => typeof e === "string" && e.length > 0,
      ),
    )) {
      const limit = await ctx.db
        .query("authRateLimits")
        .withIndex("identifier", (q) => q.eq("identifier", identifier))
        .unique();
      if (limit) await ctx.db.delete(limit._id);
    }
    // Phase 6: purge the user's long-term memories (Convex-only, no external
    // store). Batched delete pinned to the userId.
    for (;;) {
      const batch = await ctx.db
        .query("userMemories")
        .withIndex("by_user_status", (q) => q.eq("userId", args.userId))
        .take(500);
      if (batch.length === 0) break;
      for (const m of batch) await ctx.db.delete(m._id);
      if (batch.length < 500) break;
    }
    // Phase 7: purge the user's SEO mutation ledger (user-trust owner-scoped rows).
    await deleteMutationsForUser(ctx, args.userId);
    // Deep Research: purge the user's durable research runs (user-trust owner-scoped).
    await deleteResearchRunsForUser(ctx, args.userId);

    // The avatar blob, synchronously — it is exactly one, and a deleted account
    // should not leave its face in storage. (getUrl for it is minted only behind
    // the owner check in getUser, so it was never reachable after this row goes,
    // but the BYTES would orphan without this.)
    const doomed = await ctx.db.get(args.userId);
    if (doomed?.imageId) {
      try {
        await ctx.storage.delete(doomed.imageId);
      } catch {
        // idempotent: a missing blob is fine.
      }
    }

    // Private CHAT content + its blobs + the user's public SHARES are far more
    // than one mutation can delete, so they run as a durable, self-rescheduling
    // cascade (authDeletion.cascadeUserContent). Scheduled BEFORE the user row is
    // deleted, but it keys on the userId value, which stays valid as a filter
    // once the row is gone. Shares go first there, so public access to a deleted
    // user's conversations is revoked ahead of everything else.
    await ctx.scheduler.runAfter(0, internal.authDeletion.cascadeUserContent, {
      userId: args.userId,
    });

    await ctx.db.delete(args.userId);
  },
});

/** sha256 hex. Deletion codes are stored hashed, like every other auth code. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type Factor = {
  passwordHash: string | null;
  email: string | null;
  userExists: boolean;
};

const DELETION_CODE_TTL_MS = 15 * 60 * 1000;
const DELETION_CODE_MAX_ATTEMPTS = 5;

/**
 * Which re-authentication factor does this user actually have?
 *
 * INTERNAL, and it returns the caller's OWN password hash — that is only safe
 * because deleteCurrentUserAccount resolves the userId from the session and
 * never from an argument. It must never become a public query.
 */
export const deletionFactorForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) =>
        q.eq("userId", userId).eq("provider", "password"),
      )
      .unique();
    const user = await ctx.db.get(userId);
    return {
      passwordHash: account?.secret ?? null,
      email: user?.email ?? null,
      // getAuthUserId is a bare cast of the JWT subject, so a caller whose row
      // is already gone still arrives here with a real-looking userId.
      userExists: user !== null,
    };
  },
});

/**
 * Which factor the CURRENT user must supply to delete their account.
 *
 * Session-scoped and boolean-only: it says nothing about any account but the
 * caller's own, and never returns the hash itself.
 */
export const deletionFactor = query({
  args: {},
  handler: async (ctx): Promise<{ needs: "password" | "code" } | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) =>
        q.eq("userId", userId).eq("provider", "password"),
      )
      .unique();
    return { needs: account?.secret ? "password" : "code" };
  },
});

/** Issue (and replace) the single live deletion code for a user. */
export const putDeletionCode = internalMutation({
  args: { userId: v.id("users"), codeHash: v.string() },
  handler: async (ctx, { userId, codeHash }) => {
    const existing = await ctx.db
      .query("accountDeletionCodes")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);
    await ctx.db.insert("accountDeletionCodes", {
      userId,
      codeHash,
      expirationTime: Date.now() + DELETION_CODE_TTL_MS,
      attempts: 0,
    });
  },
});

/**
 * Consume a deletion code. Scoped to ONE user id — the code is looked up by
 * user, then compared, never found by its own value. That is what stops a code
 * minted for one account from being spent on another.
 */
export const consumeDeletionCode = internalMutation({
  args: { userId: v.id("users"), code: v.string() },
  handler: async (ctx, { userId, code }): Promise<boolean> => {
    const row = await ctx.db
      .query("accountDeletionCodes")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!row) return false;
    if (
      row.expirationTime < Date.now() ||
      row.attempts >= DELETION_CODE_MAX_ATTEMPTS
    ) {
      await ctx.db.delete(row._id);
      return false;
    }
    if (row.codeHash !== (await sha256Hex(code))) {
      await ctx.db.patch(row._id, { attempts: row.attempts + 1 });
      return false;
    }
    await ctx.db.delete(row._id);
    return true;
  },
});

/**
 * Email a deletion confirmation code. For accounts with no password — Google
 * sign-in only — inbox ownership is the only factor there is to re-assert.
 */
export const requestAccountDeletionCode = action({
  args: {},
  handler: async (ctx): Promise<{ ok: true }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");
    const factor: Factor = await ctx.runQuery(
      internal.users.deletionFactorForUser,
      { userId },
    );
    if (!factor.userExists) return { ok: true };
    // A password user re-authenticates with their password; issuing a code as
    // well would add a second, weaker route to the same irreversible action.
    if (factor.passwordHash || !factor.email) return { ok: true };
    const code = generateNumericCode();
    await ctx.runMutation(internal.users.putDeletionCode, {
      userId,
      codeHash: await sha256Hex(code),
    });
    await deliverCode(
      // deliverCode types its ctx structurally and permissively so the three
      // Email providers can hand it whatever the library gives them; a real
      // ActionCtx is stricter, and the two are not assignable in that direction.
      ctx as never,
      "account deletion",
      factor.email,
      code,
      internal.email.sendEmail,
      new Date(Date.now() + DELETION_CODE_TTL_MS),
    );
    return { ok: true };
  },
});

/** Bound deletion re-auth attempts (the password path had none). */
export const consumeDeleteAttempt = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const res = await consumeWindow(ctx, userId, "accountDelete", 10, 60 * 60 * 1000);
    return { ok: res.ok };
  },
});

/**
 * Workspaces this user OWNS that still have other members.
 *
 * Deleting the account cascades its workspaces, so doing that while other people
 * are still in one would destroy THEIR data. Deletion is refused instead, naming
 * the workspaces, so the user transfers ownership or removes members first.
 */
export const blockingOwnedWorkspaces = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<string[]> => {
    const memberships = await ctx.db
      .query("members")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const blocking: string[] = [];
    for (const m of memberships) {
      const ws = await ctx.db.get(m.workspaceId);
      if (!ws || ws.ownerId !== userId) continue;
      const others = await ctx.db
        .query("members")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", m.workspaceId))
        .take(50);
      if (others.some((o) => o.userId !== userId)) blocking.push(ws.name);
    }
    return blocking;
  },
});

export const deleteCurrentUserAccount = action({
  args: {
    password: v.optional(v.string()),
    code: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return;
    }

    // RE-AUTHENTICATE. Deleting an account is irreversible and cascades through
    // memories, the SEO ledger and research runs, and the only guard used to be
    // useDoubleCheck in the settings page — i.e. clicking the button twice. A
    // borrowed or stolen session destroyed the account in one call.
    const factor: Factor = await ctx.runQuery(
      internal.users.deletionFactorForUser,
      { userId },
    );
    // Already deleted. Deletion has to be idempotent: the access token stays
    // valid for its remaining lifetime after the row is gone, so a retry — a
    // double-click, a second tab, a client that retries on a dropped response —
    // lands here with nothing left to remove. Without this it fell through to
    // the no-password branch and demanded an emailed code for an account that
    // no longer exists, which is both a dead end and a confusing error.
    if (!factor.userExists) return;
    // Bound BEFORE the scrypt comparison — the comparison is the expensive part
    // and the part worth guessing against.
    const quota: { ok: boolean } = await ctx.runMutation(
      internal.users.consumeDeleteAttempt,
      { userId },
    );
    if (!quota.ok) {
      throw new ConvexError("Too many attempts. Try again later.");
    }
    if (factor.passwordHash) {
      if (!args.password) {
        throw new ConvexError("Enter your password to delete your account.");
      }
      const ok = await new Scrypt().verify(factor.passwordHash, args.password);
      if (!ok) throw new ConvexError("Incorrect password.");
    } else {
      // Google-only accounts have no password to re-enter, so inbox ownership
      // is the factor. Same bar as password reset, which can already take over
      // the account, so this adds no new weakness.
      if (!args.code) {
        throw new ConvexError("Enter the code we emailed you.");
      }
      const ok: boolean = await ctx.runMutation(
        internal.users.consumeDeletionCode,
        { userId, code: args.code },
      );
      if (!ok) throw new ConvexError("That code is not valid or has expired.");
    }

    // NEVER destroy another user's data. Owning a shared workspace blocks
    // deletion outright rather than silently cascading other members' content.
    const blocking: string[] = await ctx.runQuery(
      internal.users.blockingOwnedWorkspaces,
      { userId },
    );
    if (blocking.length > 0) {
      throw new ConvexError(
        `You still own ${blocking.length === 1 ? "a workspace" : "workspaces"} with other members (${blocking.join(", ")}). Transfer ownership or remove the members first.`,
      );
    }

    const subscription = await polar.getCurrentSubscription(ctx, {
      userId,
    });
    if (!subscription) {
      console.error("No subscription found");
    } else {
      await polar.cancelSubscription(ctx, {
        revokeImmediately: true,
      });
    }
    await ctx.runMutation(internal.users.deleteUserAccount, {
      userId,
    });
  },
});
