import Google from "@auth/core/providers/google";
import { OllaSuperPassword } from "./passwordProvider";
import { convexAuth, getAuthSessionId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { ResendOTP } from "./ResendOTP";
import type { Doc } from "./_generated/dataModel";
import {
  assertPasswordNotIdentity,
  assertUsableEmail,
  googleProfile,
  isCommonPassword,
  assertPasswordRequirements,
  normalizeEmail,
} from "./authPolicy";
import { recordAuthEvent, revokeOtherSessions } from "./authEvents";
import { consumeCodeSendBudget } from "./authProbe";
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
  validatePasswordRequirements: assertPasswordRequirements,
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
      // CODE ISSUANCE IS NOT AUTHENTICATION (audit F-06). The library calls
      // this callback from createVerificationCode too — i.e. when ANYONE asks
      // for a reset or OTP code for an address, before any proof of inbox
      // ownership. Revoking sessions, stamping passwordChangedAt and logging a
      // success here let an anonymous caller sign a victim out everywhere and
      // forge their security history with nothing but their email. Issuance
      // gets the row repair below and the send budget, nothing else.
      const issuance = args.type === "email" || args.type === "phone";

      const providerId = String(args.provider?.id ?? args.type);
      const isOtp = providerId === "verify-otp" || providerId === "resend-otp";

      const user = await ctx.db.get(args.userId);
      if (issuance) {
        if (user !== null) {
          const fix = repairFields(user);
          if (Object.keys(fix).length > 0) await ctx.db.patch(user._id, fix);
        }
        // The budget is consumed HERE, in the transaction that is about to
        // replace the address's code (audit F-07). Exhausted -> abort, which
        // rolls the replacement back: the code already delivered stays valid.
        // Same answer for every address, so it is not an existence oracle.
        const email =
          typeof args.profile?.email === "string" ? args.profile.email : user?.email;
        if (email && !(await consumeCodeSendBudget(ctx, email))) {
          throw new ConvexError(CODE_SEND_THROTTLED);
        }
        await reconcileDuplicateUsers(ctx, args.userId);
        return;
      }

      // Proof has been given (verified code, OAuth, or a fresh credential).
      const keep = await getAuthSessionId(ctx);
      const revoked = await revokeOtherSessions(ctx, args.userId, keep);

      if (user !== null) {
        await ctx.db.patch(args.userId, {
          lastLoginAt: now,
          lastActivityAt: now,
          ...repairFields(user),
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
          type: "session_replaced",
          userId: args.userId,
          meta: { revoked },
        });
      }
      // A completed password reset is recorded where the credential actually
      // changes (passwordProvider reset-verification), not here.
      await recordAuthEvent(ctx, {
        type: isOtp
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

/**
 * Backfill AND repair. `emailNormalized` was added later, so old rows lack it —
 * but `email` itself also needs guarding, because the library writes the RAW
 * identifier over it: createVerificationCodeImpl does `profile: { email }` from
 * whatever it was handed and upserts that onto the user. Every sign-up typed
 * with a capital letter therefore left `users.email` as "Foo@Gmail.com".
 *
 * That column is the one `uniqueUserWithVerifiedEmail` indexes, so a corrupted
 * value makes the next provider fail to find the user and create a SECOND one.
 * Repairing in the callback covers every provider — magic OTP and Google
 * included — because they all reach it, at issuance and at sign-in alike.
 */
function repairFields(user: Doc<"users">): Partial<Doc<"users">> {
  return {
    ...(user.email && user.email !== normalizeEmail(user.email)
      ? { email: normalizeEmail(user.email) }
      : {}),
    ...(user.email && !user.emailNormalized
      ? { emailNormalized: normalizeEmail(user.email) }
      : {}),
    ...(user.accountStatus ? {} : { accountStatus: "active" }),
  };
}

/** Generic on purpose: the same for every address, known or not. */
const CODE_SEND_THROTTLED =
  "Too many codes requested for this address. Please wait and try again.";
