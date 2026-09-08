import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import type { AuthProviderConfig } from "@convex-dev/auth/server";
import {
  createAccount,
  invalidateSessions,
  modifyAccountCredentials,
  retrieveAccount,
  signInViaProvider,
} from "@convex-dev/auth/server";
import { Scrypt } from "lucia";
import { ConvexError } from "convex/values";
import type { GenericActionCtxWithAuthConfig } from "@convex-dev/auth/server";
import type { DataModel } from "./_generated/dataModel";

/**
 * OllaSuper's password provider.
 *
 * A near-verbatim copy of `@convex-dev/auth`'s `Password`, differing in exactly
 * ONE branch: what sign-up does when the address already has an account.
 *
 * WHY A COPY RATHER THAN A WRAPPER. The library's sign-up path calls
 * `createAccountFromCredentialsImpl`, which — for an existing account — runs a
 * real scrypt comparison against the stored hash and then either throws
 * `Account <email> already exists` (wrong password) or RETURNS THE ACCOUNT and
 * signs the caller in (correct password). That is a password oracle on a public
 * endpoint, and it is not covered by the library's brute-force limiter: that
 * limiter lives only in `retrieveAccountWithCredentials` and `verifyCodeAndSignIn`,
 * so `maxFailedAttempsPerHour` does not apply to sign-up at all.
 *
 * Three other places were tried first and none of them can close it:
 *   - a wrapper around `auth:signIn` — the library's action must stay exported
 *     and public for login, OTP, OAuth and every refresh-token call, so an
 *     attacker simply calls it by name and skips the wrapper;
 *   - `profile()` — invoked synchronously (`config.profile?.(params, ctx)`, never
 *     awaited), so it cannot do the database read needed to detect a collision;
 *   - `afterUserCreatedOrUpdated` — on a correct-password collision the library
 *     returns early WITHOUT calling `upsertUserAndAccount`, so it never fires.
 *
 * `ConvexCredentials` is the documented extension point — `Password` is itself
 * built on it — and every helper used here is public API. The hasher is the same
 * `Scrypt` from lucia, so existing password hashes keep verifying.
 */

type EmailConfig = AuthProviderConfig;

export interface OllaSuperPasswordConfig {
  id?: string;
  verify?: EmailConfig;
  reset?: EmailConfig;
  profile: (
    params: Record<string, unknown>,
    ctx: GenericActionCtxWithAuthConfig<DataModel>,
  ) => Record<string, unknown> & { email: string };
  validatePasswordRequirements: (password: string) => void;
}

export function OllaSuperPassword(config: OllaSuperPasswordConfig) {
  const provider = config.id ?? "password";
  return ConvexCredentials<DataModel>({
    id: "password",
    authorize: async (params, ctx) => {
      const flow = params.flow as string | undefined;
      const passwordToValidate =
        flow === "signUp"
          ? (params.password as string | undefined)
          : flow === "reset-verification"
            ? (params.newPassword as string | undefined)
            : null;
      if (passwordToValidate !== null && passwordToValidate !== undefined) {
        config.validatePasswordRequirements(passwordToValidate);
      }

      const profile = config.profile(
        params as Record<string, unknown>,
        ctx as GenericActionCtxWithAuthConfig<DataModel>,
      );
      const { email } = profile;
      // Hand the email sub-providers the NORMALISED address, never the raw
      // params. createVerificationCodeImpl does profile: { email } straight
      // from what it is given and upserts it onto users.email, so passing the
      // user's typed casing writes "Foo@Gmail.com" over a normalised row —
      // and uniqueUserWithVerifiedEmail indexes that raw column, so the next
      // provider to link fails to find the user and creates a second one.
      const verifyParams = { ...params, email };
      const secret = params.password as string | undefined;

      // biome-ignore lint/suspicious/noExplicitAny: the library's own shapes
      let account: any;
      // biome-ignore lint/suspicious/noExplicitAny: the library's own shapes
      let user: any;

      if (flow === "signUp") {
        if (secret === undefined) {
          throw new Error("Missing `password` param for `signUp` flow");
        }

        // THE FIX. Look the account up WITHOUT a secret, so no comparison ever
        // runs against the stored hash — the comparison IS the oracle.
        // retrieveAccount throws for an unknown address, which is the only way
        // it reports absence.
        let existing: Awaited<ReturnType<typeof retrieveAccount>> | null = null;
        try {
          existing = await retrieveAccount(ctx, {
            provider,
            account: { id: email },
          });
        } catch {
          existing = null;
        }

        if (existing !== null) {
          // COLLISION. Touch NOTHING and send NOTHING — just return the shape a
          // fresh sign-up returns.
          //
          // The earlier version dispatched a verification code for the EXISTING
          // account. That is an account-takeover path: an unverified account
          // belongs to whoever squatted the address, and verifyCodeAndSignIn
          // patches `emailVerified: true` onto it (mutations/verifyCodeAndSignIn.js
          // :105-109), so the real owner completing that code ACTIVATES the
          // squatter's password on their own account.
          //
          // Overwriting the squatter's credential with this sign-up's password is
          // the same bug mirrored: an attacker signs up over a victim's unverified
          // account, the victim gets the code, verifies, and the ATTACKER's
          // password is live. Deleting and recreating fails identically.
          //
          // The invariant that survives all three: A CREDENTIAL MAY BECOME LIVE ON
          // AN ACCOUNT ONLY WHEN THE ACTOR WHO SUPPLIED IT ALSO PROVED INBOX
          // OWNERSHIP IN THE SAME FLOW. Sign-up + emailed code cannot satisfy it,
          // because the credential was chosen earlier and possibly by someone
          // else. Password reset does satisfy it — the code and the new password
          // arrive together — so reset remains the recovery path for a squatted
          // address, and it works immediately rather than after authPurge's TTL.
          //
          // Returning null is byte-identical to a fresh sign-up: signInViaProvider
          // returns null for an email provider (implementation/index.js:406-417
          // via signIn.js:99), so both cases resolve as { signedIn: null }.
          return null;
        }

        const created = await createAccount(ctx, {
          provider,
          account: { id: email, secret },
          profile: profile as never,
          shouldLinkViaEmail: config.verify !== undefined,
          shouldLinkViaPhone: false,
        });
        ({ account, user } = created);
      } else if (flow === "signIn") {
        if (secret === undefined) {
          throw new Error("Missing `password` param for `signIn` flow");
        }
        // ONE answer for every failure. retrieveAccount throws three DIFFERENT
        // messages — "InvalidAccountId" (no such address), "InvalidSecret" (wrong
        // password) and "TooManyFailedAttempts" — see
        // mutations/retrieveAccountWithCredentials.js:23,27,31. Measured against
        // production, those reach an unauthenticated caller in full, WITH a stack
        // trace naming this file and line, so login was an account-existence
        // oracle for anyone calling the action directly.
        //
        // auth-panel.tsx collapsed them in the UI and its comment claimed "the
        // server already collapses" them. It did not; only the browser did, and
        // the browser is not the trust boundary.
        //
        // ConvexError (not Error) is deliberate, but it does NOT hide the stack:
        // verified against production, `e.message` still carries a trace naming
        // this file and line. What it does give is a clean `e.data` the UI can
        // show, and — the part that matters here — BOTH failure modes now throw
        // the same error from the same line, so the trace is identical and no
        // longer distinguishes them. The residual source-path disclosure is a
        // deployment-wide Convex behaviour, not something this file can close.
        let retrieved: Awaited<ReturnType<typeof retrieveAccount>> | null = null;
        try {
          retrieved = await retrieveAccount(ctx, {
            provider,
            account: { id: email, secret },
          });
        } catch {
          retrieved = null;
        }
        if (retrieved === null) {
          throw new ConvexError("Invalid email or password.");
        }
        ({ account, user } = retrieved);
        // A suspended account must not be able to authenticate. Same generic
        // message: whether an account is suspended is not the caller’s business
        // until they have proven they own it.
        if (user?.accountStatus && user.accountStatus !== "active") {
          throw new ConvexError("Invalid email or password.");
        }
      } else if (flow === "reset") {
        if (!config.reset) {
          throw new Error(`Password reset is not enabled for ${provider}`);
        }
        // Unknown address => return the SAME null the known path returns, rather
        // than letting retrieveAccount throw "InvalidAccountId". Verified against
        // production: this threw for unknown addresses and resolved for known
        // ones, so `signIn(flow:"reset")` was a free, UNRATED account-enumeration
        // oracle — the library’s brute-force limiter only engages when a secret
        // is supplied (mutations/retrieveAccountWithCredentials.js:25).
        //
        // authSessions.requestPasswordReset already answered identically for both
        // cases, but it only covered the UI; the raw action stayed callable, and
        // p-auth-oracle.js only exercised signUp, so this passed unnoticed.
        let resetAccount: { _id: string } | null = null;
        try {
          ({ account: resetAccount } = await retrieveAccount(ctx, {
            provider,
            account: { id: email },
          }));
        } catch {
          return null;
        }
        if (resetAccount === null) return null;
        return await signInViaProvider(ctx, config.reset, {
          accountId: resetAccount._id as never,
          params: verifyParams,
        });
      } else if (flow === "reset-verification") {
        if (!config.reset) {
          throw new Error(`Password reset is not enabled for ${provider}`);
        }
        if (params.newPassword === undefined) {
          throw new Error("Missing `newPassword` param for `reset-verification` flow");
        }
        const result = await signInViaProvider(ctx, config.reset, {
          params: verifyParams,
        });
        if (result === null) {
          throw new Error("Invalid code");
        }
        const { userId, sessionId } = result;
        await modifyAccountCredentials(ctx, {
          provider,
          account: { id: email, secret: params.newPassword as string },
        });
        // Every other session dies with the old password.
        await invalidateSessions(ctx, { userId, except: [sessionId] });
        return { userId, sessionId };
      } else if (flow === "email-verification") {
        if (!config.verify) {
          throw new Error(`Email verification is not enabled for ${provider}`);
        }
        // ENUMERATION ORACLE, closed. The previous version returned null for an
        // unknown address but let the library THROW "Could not verify code" for a
        // known one with a wrong/expired code — so submitting any garbage code
        // told an attacker whether an address had an account. An unknown address
        // and a known address with a bad code must be INDISTINGUISHABLE, so both
        // throw the SAME ConvexError; only the correct code for a real pending
        // account returns a session.
        let verifyAccount: { _id: string } | null = null;
        try {
          ({ account: verifyAccount } = await retrieveAccount(ctx, {
            provider,
            account: { id: email },
          }));
        } catch {
          verifyAccount = null;
        }
        if (verifyAccount === null) {
          throw new ConvexError("Invalid or expired verification code.");
        }
        try {
          return await signInViaProvider(ctx, config.verify, {
            accountId: verifyAccount._id as never,
            params: verifyParams,
          });
        } catch {
          throw new ConvexError("Invalid or expired verification code.");
        }
      } else {
        throw new Error(
          "Missing `flow` param, it must be one of " +
            '"signUp", "signIn", "reset", "reset-verification" or ' +
            '"email-verification"!',
        );
      }

      // The gate that makes OTP the real boundary: an account whose email is
      // not verified never receives a session, it receives a code.
      if (config.verify && !account.emailVerified) {
        return await signInViaProvider(ctx, config.verify, {
          accountId: account._id,
          params: verifyParams,
        });
      }
      return { userId: user._id };
    },
    crypto: {
      // Same hasher as the library's Password provider. Changing it would
      // invalidate every existing password in the database.
      async hashSecret(password: string) {
        return await new Scrypt().hash(password);
      },
      async verifySecret(password: string, hash: string) {
        return await new Scrypt().verify(hash, password);
      },
    },
    extraProviders: [config.reset, config.verify],
  });
}
