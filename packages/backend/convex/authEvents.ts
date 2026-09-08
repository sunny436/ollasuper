import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/**
 * Security history for the auth system.
 *
 * A separate file from auth.ts for the same reason auditLog.ts is separate from
 * orgs.ts: auth.ts is imported by the providers, and the providers are imported
 * by auth.ts, so anything both need has to live outside the cycle.
 *
 * This is deliberately NOT the same table as `auditLogs`. Those are
 * workspace-scoped product actions with a required workspaceId; these are
 * account-level security events that exist before any workspace does and must
 * survive a user being removed from every workspace.
 */
export type AuthEventType =
  | "login"
  | "logout"
  | "login_failed"
  | "google_login"
  | "otp_verified"
  | "otp_failed"
  | "password_changed"
  | "password_reset"
  | "session_revoked"
  | "session_replaced"
  // An unverified duplicate account was absorbed into this one. Kept in the
  // audit trail because it is a real identity change, not bookkeeping.
  | "account_merged"
  // Identity changes on the profile surface. `username` is what other users see
  // (getUser returns `username || name`), so a change to it is an identity event,
  // not a preference tweak.
  | "username_changed"
  | "profile_updated"
  // Operator kill switch. Recorded because suspending or reinstating an
  // account is an authority decision someone must be able to review later.
  | "account_suspended"
  | "account_reinstated";

/**
 * Truncate an IP to a network prefix — /24 for IPv4, /48 for IPv6.
 *
 * Enough to notice "this sign-in came from somewhere new" without retaining an
 * identifier that pinpoints a person or a household. Paired with the 90-day
 * purge in crons.ts.
 *
 * NOTE: in practice this is almost always absent. Convex mutations and actions
 * receive no request object, so there is no trustworthy client IP on the
 * password or OTP sign-in paths; only `httpAction` handlers (the OAuth callback)
 * can supply one. The column is optional for exactly that reason, and a missing
 * value means "not observable here", never "came from nowhere".
 */
export function ipPrefix(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const raw = ip.split(",")[0]?.trim();
  if (!raw) return undefined;
  if (raw.includes(":")) {
    const parts = raw.split(":");
    return parts.length >= 3 ? `${parts.slice(0, 3).join(":")}::/48` : undefined;
  }
  const octets = raw.split(".");
  return octets.length === 4 ? `${octets.slice(0, 3).join(".")}.0/24` : undefined;
}

/**
 * Record an auth event. Never throws: a failure to write history must not be
 * able to block a sign-in or, worse, a sign-out.
 */
export async function recordAuthEvent(
  ctx: MutationCtx,
  args: {
    type: AuthEventType;
    userId?: Id<"users">;
    // Client-supplied and therefore NOT evidence. Stored to correlate sessions,
    // not to prove who did something.
    userAgent?: string;
    ip?: string;
    meta?: Record<string, string | number | boolean>;
  },
): Promise<void> {
  try {
    await ctx.db.insert("authEvents", {
      type: args.type,
      at: Date.now(),
      ...(args.userId ? { userId: args.userId } : {}),
      ...(args.userAgent ? { userAgent: args.userAgent.slice(0, 256) } : {}),
      ...(ipPrefix(args.ip) ? { ipPrefix: ipPrefix(args.ip) } : {}),
      ...(args.meta ? { meta: args.meta } : {}),
    });
  } catch {
    // Intentionally swallowed — see the doc comment above.
  }
}

/**
 * Single-device enforcement: revoke every session for this user except `keep`.
 *
 * WHY `keep` IS LOAD-BEARING. @convex-dev/auth creates the new session at
 * different points depending on the flow — `mutations/signIn.js` creates it with
 * no user upsert at all, while `mutations/verifyCodeAndSignIn.js` passes an
 * already-created `sessionId` into `upsertUserAndAccount`. So the
 * afterUserCreatedOrUpdated callback can run either side of session creation.
 * Passing `await getAuthSessionId(ctx)` as `keep` is correct under both:
 *
 *   session created first  -> keep is the NEW session, older ones go
 *   callback first, new browser -> keep is null, all old ones go, new one lands after
 *   callback first, same browser -> keep is the caller's old session, which the
 *                                   library itself then replaces
 *
 * Deleting unconditionally would destroy the just-created session on the
 * verification path and bounce the user straight back to the login screen.
 *
 * Refresh tokens are deleted alongside their session: an orphaned refresh token
 * can still mint access tokens, so leaving them behind would make the revocation
 * cosmetic.
 *
 * Runs inside a single Convex mutation, so two concurrent logins serialise and
 * exactly one session survives.
 */
export async function revokeOtherSessions(
  ctx: MutationCtx,
  userId: Id<"users">,
  keep: Id<"authSessions"> | null,
): Promise<number> {
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();

  let revoked = 0;
  for (const session of sessions) {
    if (keep !== null && session._id === keep) continue;
    const tokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
      .collect();
    for (const token of tokens) await ctx.db.delete(token._id);
    await ctx.db.delete(session._id);
    revoked++;
  }
  return revoked;
}
