/**
 * Authenticated password change — the recovery path this deployment did not have.
 *
 * THE GAP THIS CLOSES. Before this, the ONLY way to change a password was the
 * emailed reset code. On this deployment that path is unreachable for some
 * accounts by design: `email.ts` deliberately REFUSES the smtp transport when
 * SMTP_HOST is a local catcher (the Mailpit-swallow fix), and an address on a
 * non-deliverable domain therefore never receives a code. An account in that
 * state could not rotate its own credential at all — so a credential known to be
 * exposed could not be retired, which is a security defect in its own right, not
 * merely a missing convenience.
 *
 * WHY IT IS SAFE TO ADD. It is strictly narrower than the reset flow: it needs a
 * live session AND the current password, where reset needs only inbox access.
 * Every control the reset path applies is applied here too, from the same
 * helpers rather than from copies:
 *
 *   - character-class / length / common-password rules  (assertPasswordRequirements)
 *   - "must not contain your name or email"             (assertPasswordNotIdentity)
 *   - every other session is revoked, refresh tokens too (revokeOtherSessions)
 *   - passwordChangedAt is stamped and the change is audited (recordAuthEvent)
 *
 * RATE LIMITED. Verifying `currentPassword` makes this a password oracle for
 * whoever holds a session — which matters precisely when a session has been
 * stolen and the attacker is trying to guess the password to lock the owner out.
 * `consumeWindow` bounds attempts per user per hour, reusing the same quota
 * table as the rest of the product rather than inventing a second mechanism.
 */

import {
  getAuthSessionId,
  getAuthUserId,
  modifyAccountCredentials,
  retrieveAccount,
} from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { recordAuthEvent, revokeOtherSessions } from "./authEvents";
import {
  assertPasswordNotIdentity,
  assertPasswordRequirements,
  normalizeEmail,
} from "./authPolicy";
import { consumeWindow } from "./quotas";

/** Attempts per user per hour. Generous for a human, useless for a guesser. */
const CHANGE_ATTEMPTS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

/**
 * The caller's own identity, for the action.
 *
 * An action has no database, and the email is needed as the account id the
 * password provider is keyed on. It is read from the authenticated user row,
 * never accepted as an argument — taking it from args would let a session holder
 * change SOMEONE ELSE'S password.
 */
export const selfIdentity = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user?.email) return null;
    return { email: user.email, name: user.name?.trim() ?? "" };
  },
});

/**
 * Revoke, stamp and audit — one mutation, so it is one transaction.
 *
 * Uses the repo's `revokeOtherSessions`, NOT the library's `invalidateSessions`:
 * the in-repo helper also deletes each session's refresh tokens, and an orphaned
 * refresh token can still mint access tokens, which would make this revocation
 * cosmetic exactly when it matters most.
 */
export const finishPasswordChange = internalMutation({
  args: { userId: v.id("users"), keep: v.optional(v.id("authSessions")) },
  handler: async (ctx, { userId, keep }) => {
    const revoked = await revokeOtherSessions(ctx, userId, keep ?? null);
    await ctx.db.patch(userId, { passwordChangedAt: Date.now() });
    if (revoked > 0) {
      await recordAuthEvent(ctx, {
        type: "session_revoked",
        userId,
        meta: { revoked, reason: "password_changed" },
      });
    }
    await recordAuthEvent(ctx, {
      type: "password_changed",
      userId,
      meta: { self_service: true },
    });
    return revoked;
  },
});

export const changePassword = action({
  args: { currentPassword: v.string(), newPassword: v.string() },
  handler: async (ctx, { currentPassword, newPassword }): Promise<{ ok: true }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in.");

    // Bound the oracle BEFORE the scrypt comparison: the comparison is the
    // expensive part and the part worth guessing against.
    const quota = await ctx.runMutation(internal.authPassword.consumeAttempt, {
      userId,
    });
    if (!quota.ok) {
      throw new ConvexError(
        "Too many password-change attempts. Try again later.",
      );
    }

    const me: { email: string; name: string } | null = await ctx.runQuery(
      internal.authPassword.selfIdentity,
      { userId },
    );
    if (!me) throw new ConvexError("This account has no password to change.");
    const email = normalizeEmail(me.email);

    // Policy on the NEW password first — a rejected new password should not
    // depend on whether the old one was right, and vice versa.
    assertPasswordRequirements(newPassword);
    assertPasswordNotIdentity(newPassword, email, me.name);
    if (newPassword === currentPassword) {
      throw new ConvexError("The new password must differ from the current one.");
    }

    // Verify the current password by retrieving the account WITH the secret.
    // The library throws when the secret does not match; a generic message is
    // returned either way so this never becomes an account-shape oracle.
    try {
      await retrieveAccount(ctx, {
        provider: "password",
        account: { id: email, secret: currentPassword },
      });
    } catch {
      throw new ConvexError("Current password is incorrect.");
    }

    await modifyAccountCredentials(ctx, {
      provider: "password",
      account: { id: email, secret: newPassword },
    });

    // Revoke every OTHER session. A password change whose point is to retire a
    // compromised credential must not leave a session minted under it alive —
    // the same requirement the reset path already meets.
    const keep = (await getAuthSessionId(ctx)) as Id<"authSessions"> | null;
    await ctx.runMutation(internal.authPassword.finishPasswordChange, {
      userId,
      ...(keep ? { keep } : {}),
    });
    return { ok: true };
  },
});

/** The rate-limit write. Split out because `consumeWindow` needs a mutation. */
export const consumeAttempt = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const res = await consumeWindow(
      ctx,
      userId,
      "passwordChange",
      CHANGE_ATTEMPTS_PER_HOUR,
      HOUR_MS,
    );
    return { ok: res.ok };
  },
});
