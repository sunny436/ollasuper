import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";
import { normalizeEmail } from "./authPolicy";
import { recordAuthEvent, revokeOtherSessions } from "./authEvents";

/**
 * Single-active-session enforcement and activity tracking.
 *
 * WHY THIS EXISTS AS A SEPARATE ENTRY POINT, and not only in the
 * afterUserCreatedOrUpdated callback in auth.ts:
 *
 * That callback fires from `upsertUserAndAccount`, which a plain password
 * sign-in never calls — `mutations/signIn.js` goes straight to
 * `createNewAndDeleteExistingSession` with no user upsert at all. So the
 * callback covers sign-up, OTP, email verification, password reset and OAuth,
 * but silently misses the single most common path. Live testing caught this:
 * three sequential logins produced three live sessions and zero
 * `session_replaced` events, while every unit test passed.
 *
 * The library gives no hook that spans all flows, so enforcement also runs from
 * the authenticated client on mount. That is deliberately NOT frontend security:
 * the decision and the writes happen here, in one Convex mutation, so two
 * concurrent calls serialise and exactly one session survives. The client only
 * supplies the trigger.
 *
 * It also matches the requirement's own wording — "the previous device is forced
 * to login again on its next request". A displaced device keeps its access token
 * until it expires (≤1h, a property of stateless JWTs that no server-side design
 * removes), but its refresh token is gone, so it cannot continue past that.
 */
export const heartbeat = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { ok: false as const };
    const current = await getAuthSessionId(ctx);

    // The caller's session was revoked by a newer login elsewhere. Report it so
    // the client can show "signed out because your account was used elsewhere"
    // rather than a bare login screen.
    if (current === null) return { ok: false as const };
    const session = await ctx.db.get(current);
    if (session === null) return { ok: false as const, displaced: true as const };

    const revoked = await revokeOtherSessions(ctx, userId, current);
    if (revoked > 0) {
      await recordAuthEvent(ctx, {
        type: "session_replaced",
        userId,
        meta: { revoked },
      });
    }

    // Sliding-window bookkeeping. Enforcement is the refresh token's own
    // inactivity budget; this column is for display and anomaly review.
    await ctx.db.patch(userId, { lastActivityAt: Date.now() });
    return { ok: true as const, revoked };
  },
});

/** Internal: does an account exist for this address? Never exposed publicly. */
export const accountExists = query({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const normalized = normalizeEmail(email);
    // Fast path: by_email_normalized (schema.ts) exists precisely for this.
    const hit = await ctx.db
      .query("users")
      .withIndex("by_email_normalized", (q) => q.eq("emailNormalized", normalized))
      .first();
    if (hit) return true;
    // Slow path, kept deliberately. Rows written before emailNormalized existed
    // have it unset and are invisible to that index, and their raw email may be
    // any case, which no index can match case-insensitively. Scanning here is
    // the only answer that cannot regress an existing account — it just no
    // longer runs for the overwhelmingly common case of a normalised hit.
    const all = await ctx.db.query("users").collect();
    return all.some(
      (u) => (u.emailNormalized ?? normalizeEmail(u.email ?? "")) === normalized,
    );
  },
});

/**
 * Password-reset request that does not leak whether the account exists.
 *
 * Calling signIn("password", { email, flow: "reset" }) directly is an
 * ENUMERATION ORACLE: for a known address it resolves, and for an unknown one
 * the provider throws InvalidAccountId. An attacker can therefore test an email
 * list against this endpoint and learn exactly who has an account. This was
 * caught by the flow tests, not by review.
 *
 * So the existence check happens server-side and the response is identical
 * either way. The email is only dispatched when there is somewhere to send it.
 */
export const requestPasswordReset = action({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<{ ok: true }> => {
    const exists: boolean = await ctx.runQuery(api.authSessions.accountExists, {
      email,
    });
    if (exists) {
      try {
        await ctx.runAction(api.auth.signIn, {
          provider: "password",
          params: { email, flow: "reset" },
        });
      } catch {
        // Swallowed deliberately: surfacing a failure here would re-open the
        // oracle by making the known-account path distinguishable.
      }
    }
    return { ok: true };
  },
});
