import Google from "@auth/core/providers/google";
import { OllaSuperPassword } from "./passwordProvider";
import { convexAuth, getAuthSessionId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { ResendOTP } from "./ResendOTP";
import {
  assertPasswordNotIdentity,
  assertUsableEmail,
  googleProfile,
  isCommonPassword,
  normalizeEmail,
} from "./authPolicy";
import { recordAuthEvent, revokeOtherSessions } from "./authEvents";
import { reconcileDuplicateUsers } from "./authReconcile";
import { ResendOTPReset, ResendOTPVerify } from "./passwordProviders";

// Full auth: email+password (strength policy, email verification, password
// reset), magic email OTP, and Google OAuth.

/** 2 days of INACTIVITY, not a fixed 2-day lifetime. */
const INACTIVE_DURATION_MS = 1000 * 60 * 60 * 24 * 2;
/** Hard ceiling regardless of activity, so no session is effectively permanent. */
const TOTAL_DURATION_MS = 1000 * 60 * 60 * 24 * 30;

const PasswordWithFlows = OllaSuperPassword({
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
    const name = typeof params.name === "string" ? params.name.trim() : "";
    // profile() runs on EVERY flow (sign-in included — the library calls it to
    // derive the account id). The domain allow-list and the "password must not
    // contain your name/email" rules are SIGN-UP only. Gating on flow is
    // load-bearing: without it, every existing user whose domain is not on the
    // allow-list — admin@myos.test included — is locked OUT of login.
    // (Char-class + common-password rules DO run on sign-up AND reset, in
    // validatePasswordRequirements below.)
    const isSignUp = params.flow === "signUp";
    const email = isSignUp
      ? // Specific, user-friendly messages; a typed domain is not an
        // account-existence oracle.
        assertUsableEmail(params.email as string)
      : normalizeEmail(params.email as string);
    if (isSignUp && typeof params.password === "string") {
      assertPasswordNotIdentity(params.password, email, name);
    }
    const doc: Record<string, string> & { email: string } = {
      email,
      emailNormalized: normalizeEmail(email),
    };
    if (name) doc.name = name;
    return doc;
  },
  // Runs on BOTH sign-up and password-reset. One specific message per failing
  // rule so the user knows exactly what to fix.
  validatePasswordRequirements: (password: string) => {
    if (password.length < 8)
      throw new ConvexError("Password must be at least 8 characters.");
    if (!/[a-z]/.test(password))
      throw new ConvexError("Password must include a lowercase letter.");
    if (!/[A-Z]/.test(password))
      throw new ConvexError("Password must include an uppercase letter.");
    if (!/\d/.test(password))
      throw new ConvexError("Password must include a number.");
    if (!/[^A-Za-z0-9]/.test(password))
      throw new ConvexError("Password must include a special character.");
    if (isCommonPassword(password))
      throw new ConvexError(
        "This password is too common — choose something less predictable.",
      );
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
const GoogleVerified = Google({ profile: googleProfile });

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
          // Backfill AND repair. `emailNormalized` was added later, so old rows
          // lack it — but `email` itself also needs guarding, because the
          // library writes the RAW identifier over it: createVerificationCodeImpl
          // does `profile: { email }` from whatever it was handed and upserts
          // that onto the user. Every sign-up typed with a capital letter
          // therefore left `users.email` as "Foo@Gmail.com".
          //
          // That column is the one `uniqueUserWithVerifiedEmail` indexes, so a
          // corrupted value makes the next provider fail to find the user and
          // create a SECOND one. Repairing here covers every provider — magic
          // OTP and Google included — because they all reach this callback.
          ...(user.email && user.email !== normalizeEmail(user.email)
            ? { email: normalizeEmail(user.email) }
            : {}),
          ...(user.email && !user.emailNormalized
            ? { emailNormalized: normalizeEmail(user.email) }
            : {}),
          ...(user.accountStatus ? {} : { accountStatus: "active" }),
        });
      }

      // One email, one user. Runs AFTER the row exists because that is the only
      // hook available — see authReconcile for why absorbing an unverified
      // account is safe (it can own nothing) and why two verified accounts are
      // never merged.
      const absorbed = await reconcileDuplicateUsers(ctx, args.userId);
      if (absorbed > 0) {
        await recordAuthEvent(ctx, {
          type: "account_merged",
          userId: args.userId,
          meta: { absorbed },
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
