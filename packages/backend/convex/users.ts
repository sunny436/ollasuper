import { getAuthUserId } from "@convex-dev/auth/server";
import { normalizeEmail } from "./authPolicy";
import { revokeOtherSessions } from "./authEvents";
import { deliverCode, generateNumericCode } from "./authCodes";
import { Scrypt } from "lucia";
import { ConvexError } from "convex/values";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { deleteResearchRunsForUser } from "./researchRuns";
import { deleteMutationsForUser } from "./seoMutations";
import { polar } from "./subscriptions";
import { username } from "./utils/validators";

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
    return {
      ...user,
      // `name` stays `username || name` — the chat account footer + dashboard
      // sidebar render it as the account's display name and would blank out for
      // users with no display name if this changed. `displayName` exposes the
      // raw `users.name` column so the Settings profile editor can edit it.
      name: user.username || user.name,
      displayName: user.name ?? null,
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
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return;
    }
    // Display name allows spaces/unicode (unlike `username`), so there is no
    // format regex — just trim and bound the length. An empty value clears it
    // (the UI then falls back to `username`).
    const trimmed = args.name.trim().slice(0, 50);
    await ctx.db.patch(userId, { name: trimmed || undefined });
  },
});

export const updateUsername = mutation({
  args: {
    username: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return;
    }
    const validatedUsername = username.safeParse(args.username);

    if (!validatedUsername.success) {
      throw new Error(validatedUsername.error.message);
    }
    await ctx.db.patch(userId, { username: validatedUsername.data });
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
    const factor: { passwordHash: string | null; email: string | null } =
      await ctx.runQuery(internal.users.deletionFactorForUser, { userId });
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
    const factor: { passwordHash: string | null; email: string | null } =
      await ctx.runQuery(internal.users.deletionFactorForUser, { userId });
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
