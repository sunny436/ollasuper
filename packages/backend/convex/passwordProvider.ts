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
          if (!config.verify) {
            // Without a verify provider there is no indistinguishable answer to
            // give, so refuse rather than leak. Unreachable in this deployment.
            throw new Error("Account already exists");
          }
          // Take the SAME branch a fresh sign-up ends on, with the same
          // arguments. The response is identical because it is literally the
          // same call — not a fabricated look-alike that could drift or be
          // fingerprinted by timing or by the number of emails sent.
          //
          // The owner receives one verification code, exactly as a fresh
          // sign-up would send. That code IS the notification, which is why no
          // separate "someone tried to sign up" email is sent: a second message
          // would make the collision case observably different from a fresh
          // one, and would let an attacker burn the address's send budget.
          //
          // Entering that code proves inbox ownership and signs the real owner
          // in — the same capability the existing magic-OTP provider already
          // offers, so this grants nothing new.
          return await signInViaProvider(ctx, config.verify, {
            accountId: existing.account._id,
            params: verifyParams,
          });
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
        const retrieved = await retrieveAccount(ctx, {
          provider,
          account: { id: email, secret },
        });
        if (retrieved === null) {
          throw new Error("Invalid credentials");
        }
        ({ account, user } = retrieved);
      } else if (flow === "reset") {
        if (!config.reset) {
          throw new Error(`Password reset is not enabled for ${provider}`);
        }
        const { account: resetAccount } = await retrieveAccount(ctx, {
          provider,
          account: { id: email },
        });
        return await signInViaProvider(ctx, config.reset, {
          accountId: resetAccount._id,
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
        const { account: verifyAccount } = await retrieveAccount(ctx, {
          provider,
          account: { id: email },
        });
        return await signInViaProvider(ctx, config.verify, {
          accountId: verifyAccount._id,
          params: verifyParams,
        });
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
