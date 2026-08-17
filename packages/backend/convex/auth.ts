import Google from "@auth/core/providers/google";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth, getAuthSessionId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { ResendOTP } from "./ResendOTP";
import { assertUsableEmail, normalizeEmail } from "./authPolicy";
import { recordAuthEvent, revokeOtherSessions } from "./authEvents";
import { ResendOTPReset, ResendOTPVerify } from "./passwordProviders";

// Full auth: email+password (strength policy, email verification, password
// reset), magic email OTP, and Google OAuth.

/** 2 days of INACTIVITY, not a fixed 2-day lifetime. */
const INACTIVE_DURATION_MS = 1000 * 60 * 60 * 24 * 2;
/** Hard ceiling regardless of activity, so no session is effectively permanent. */
const TOTAL_DURATION_MS = 1000 * 60 * 60 * 24 * 30;

const PasswordWithFlows = Password({
  verify: ResendOTPVerify,
  reset: ResendOTPReset,
  // Without this, Password falls back to its defaultProfile, which returns
  // `{ email }` and nothing else — so a `name` sent by the sign-up form would be
  // accepted and then silently dropped. `users.name` is already optional in the
  // schema, and the dashboard sidebar renders it, so persist it here.
  // The expected return is WithoutSystemFields<Doc<"users">> & { email: string },
  // and Convex's `Value` does not include `undefined`. So each field is either a
  // real string or absent from the object entirely — never explicitly undefined,
  // which is what a ternary or `x: string | undefined` would produce.
  profile: (params) => {
    // Single gate for shape and disposable-provider policy. Throws the same
    // generic message for every rejection reason so sign-up cannot be used as an
    // account or provider oracle.
    const email = assertUsableEmail(params.email as string);
    const doc: Record<string, string> & { email: string } = {
      email,
      emailNormalized: normalizeEmail(email),
    };
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (name) doc.name = name;
    return doc;
  },
  validatePasswordRequirements: (password: string) => {
    if (
      password.length < 8 ||
      !/[a-z]/.test(password) ||
      !/[A-Z]/.test(password) ||
      !/\d/.test(password)
    ) {
      throw new ConvexError(
        "Password must be at least 8 characters and include upper, lower, and a number.",
      );
    }
  },
});

/**
 * Google, with the one control the default configuration lacks.
 *
 * `sub` binding and OAuth state/PKCE are already correct — accounts are keyed on
 * (provider, providerAccountId) and providerAccountId is the OIDC `sub`, so a
 * Google user who changes their email keeps the same identity and an attacker
 * cannot claim someone else's account by matching an address.
 *
 * What was missing: nothing rejected an UNVERIFIED Google address. Google will
 * happily issue a profile with `email_verified: false`, and accepting it lets an
 * attacker register a Google account claiming a victim's address and land on the
 * victim's user record. That is the account-takeover path, so refuse it.
 */
const GoogleVerified = Google({
  profile(profile: Record<string, unknown>) {
    if (profile.email_verified !== true) {
      throw new ConvexError(
        "Your Google account's email address is not verified.",
      );
    }
    const email = normalizeEmail(String(profile.email ?? ""));
    return {
      // `sub` is the immutable Google subject; this becomes providerAccountId.
      id: String(profile.sub),
      email,
      emailNormalized: email,
      name: typeof profile.name === "string" ? profile.name : undefined,
      image: typeof profile.picture === "string" ? profile.picture : undefined,
    };
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [PasswordWithFlows, ResendOTP, GoogleVerified],
  // Brute-force protection: per-identifier token bucket. Covers password sign-in
  // AND the OTP/reset verification path — verifyCodeAndSignIn calls
  // recordFailedSignIn/isSignInRateLimited, so a wrong code counts against the
  // same budget as a wrong password.
  signIn: { maxFailedAttempsPerHour: 5 },
  session: {
    inactiveDurationMs: INACTIVE_DURATION_MS,
    totalDurationMs: TOTAL_DURATION_MS,
  },
  callbacks: {
    /**
     * Single active session per account, enforced server-side.
     *
     * Runs inside the sign-in mutation, so it shares that transaction: two
     * concurrent logins serialise and exactly one session survives. Doing this
     * in the frontend would be decorative.
     *
     * `keep` must be the CURRENT session rather than nothing — see
     * revokeOtherSessions for why deleting unconditionally breaks the
     * verification flow.
     */
    async afterUserCreatedOrUpdated(ctx, args) {
      const now = Date.now();
      // Token refresh does not pass through here, but guard anyway: this must
      // only fire for an actual authentication event.
      const keep = await getAuthSessionId(ctx);
      const revoked = await revokeOtherSessions(ctx, args.userId, keep);

      const providerId = String(args.provider?.id ?? args.type);
      // reset-verification arrives here as a "verification" from the
      // password-reset email provider. That is also the moment the credential
      // actually changes, so stamp it and emit the event from the same place.
      const isPasswordReset = providerId === "password-reset";
      const isOtp = providerId === "verify-otp" || providerId === "resend-otp";

      const user = await ctx.db.get(args.userId);
      if (user !== null) {
        await ctx.db.patch(args.userId, {
          lastLoginAt: now,
          lastActivityAt: now,
          ...(isPasswordReset ? { passwordChangedAt: now } : {}),
          ...(user.email && !user.emailNormalized
            ? { emailNormalized: normalizeEmail(user.email) }
            : {}),
          ...(user.accountStatus ? {} : { accountStatus: "active" }),
        });
      }

      // Every other session dies here. For a password reset that is precisely
      // requirement 6 — the reset must not leave an attacker's session alive —
      // and it is the same code path as single-device enforcement rather than a
      // second, separately-maintained mechanism.
      if (revoked > 0) {
        await recordAuthEvent(ctx, {
          type: isPasswordReset ? "session_revoked" : "session_replaced",
          userId: args.userId,
          meta: { revoked },
        });
      }
      await recordAuthEvent(ctx, {
        type: isPasswordReset
          ? "password_reset"
          : isOtp
            ? "otp_verified"
            : args.type === "oauth"
              ? "google_login"
              : "login",
        userId: args.userId,
        meta: { provider: providerId },
      });
    },
  },
});
