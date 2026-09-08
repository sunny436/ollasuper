import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import {
  assertPasswordNotIdentity,
  assertPasswordRequirements,
} from "./authPolicy";
import { revokeOtherSessions } from "./authEvents";
import { consumeWindow } from "./quotas";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

/**
 * The authenticated change-password flow.
 *
 * The action itself calls into @convex-dev/auth's scrypt helpers, which need a
 * real auth runtime that convex-test does not provide — so the ACTION is
 * exercised on production (see the report), and what is pinned here are the
 * boundaries it is built out of, each of which is the thing that would actually
 * fail open:
 *
 *   1. the new password is held to the SAME rules as sign-up/reset,
 *   2. a change revokes other sessions AND their refresh tokens,
 *   3. the attempt limiter actually stops at the limit.
 *
 * Boundary 2 is the one worth stating plainly: the library's own
 * `invalidateSessions` deletes sessions but not refresh tokens, and an orphaned
 * refresh token still mints access tokens. Using the in-repo helper is the
 * difference between revocation and the appearance of it.
 */
describe("authenticated password change", () => {
  test("the new password is held to the same policy as sign-up and reset", () => {
    // Each of these is a rule the reset flow enforces; the change flow must not
    // be the weak door.
    expect(() => assertPasswordRequirements("short1!")).toThrow(/8 characters/);
    expect(() => assertPasswordRequirements("alllowercase1!")).toThrow(
      /uppercase/,
    );
    expect(() => assertPasswordRequirements("ALLUPPERCASE1!")).toThrow(
      /lowercase/,
    );
    expect(() => assertPasswordRequirements("NoDigitsHere!")).toThrow(/number/);
    expect(() => assertPasswordRequirements("NoSpecial123")).toThrow(
      /special character/,
    );
    expect(() => assertPasswordRequirements("Password123!")).toThrow(
      /too common/,
    );
    expect(() => assertPasswordRequirements(`${"x".repeat(129)}A1!`)).toThrow(
      /128 characters or fewer/,
    );
    // and a good one passes
    expect(() => assertPasswordRequirements("Tq7#vrLm2wPz")).not.toThrow();
  });

  test("the new password may not embed the account's own identity", () => {
    expect(() =>
      assertPasswordNotIdentity("Chatpeer#2026x", "chatpeer@example.com", ""),
    ).toThrow(/part of your email/);
    expect(() =>
      assertPasswordNotIdentity("Ravi#Strong2026", "someone@example.com", "Ravi"),
    ).toThrow(/your name/);
  });

  test("changing a password revokes other sessions AND their refresh tokens", async () => {
    const t = convexTest(schema, modules);
    const { userId, keep, doomed } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "u@t.test" });
      const keep = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 60_000,
      });
      const doomed = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 60_000,
      });
      // A refresh token on the session that is about to be revoked. If only the
      // session row were deleted, this token would still mint access tokens and
      // the "revocation" would be cosmetic.
      await ctx.db.insert("authRefreshTokens", {
        sessionId: doomed,
        expirationTime: Date.now() + 600_000,
      });
      return { userId, keep, doomed };
    });

    const revoked = await t.run((ctx) => revokeOtherSessions(ctx, userId, keep));
    expect(revoked).toBe(1);

    await t.run(async (ctx) => {
      expect(await ctx.db.get(keep)).not.toBeNull();
      expect(await ctx.db.get(doomed)).toBeNull();
      const orphans = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", doomed))
        .collect();
      expect(orphans).toEqual([]);
    });
  });

  test("the attempt limiter stops the password oracle at the limit", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { email: "limited@t.test" }),
    );
    const LIMIT = 10;
    const results: boolean[] = [];
    await t.run(async (ctx) => {
      for (let i = 0; i < LIMIT + 3; i++) {
        const r = await consumeWindow(
          ctx,
          userId,
          "passwordChange",
          LIMIT,
          60 * 60 * 1000,
        );
        results.push(r.ok);
      }
    });
    expect(results.filter(Boolean)).toHaveLength(LIMIT);
    expect(results.slice(LIMIT)).toEqual([false, false, false]);
  });

  test("password-change attempts do not spend the chat budget", async () => {
    // Separate windows per kind — otherwise a user locked out of chat could not
    // rotate a compromised password, which is exactly backwards.
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { email: "sep@t.test" }),
    );
    await t.run(async (ctx) => {
      for (let i = 0; i < 10; i++) {
        await consumeWindow(ctx, userId, "passwordChange", 10, 60_000);
      }
      // chat still has its full budget
      const chat = await consumeWindow(ctx, userId, "chat", 1, 60_000);
      expect(chat.ok).toBe(true);
    });
  });
});
