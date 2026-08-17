import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { mutation } from "./_generated/server";
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
