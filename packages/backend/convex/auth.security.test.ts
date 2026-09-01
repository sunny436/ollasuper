/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  INVALID_EMAIL_MESSAGE,
  UNSUPPORTED_DOMAIN_MESSAGE,
  assertPasswordNotIdentity,
  assertUsableEmail,
  isAllowedSignupDomain,
  isCommonPassword,
  isDisposableEmail,
  isValidEmailShape,
  normalizeEmail,
} from "./authPolicy";
import { generateNumericCode, hasMailTransport } from "./authCodes";
import { ipPrefix, recordAuthEvent, revokeOtherSessions } from "./authEvents";
import { reconcileDuplicateUsers } from "./authReconcile";
import { UNVERIFIED_TTL_MS } from "./authPurge";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

/** Create a user plus N sessions, each with a refresh token, as sign-in would. */
async function seedSessions(t: ReturnType<typeof convexTest>, count: number) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "s@t.test" });
    const sessionIds: Id<"authSessions">[] = [];
    for (let i = 0; i < count; i++) {
      const sessionId = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 1000 * 60 * 60,
      });
      await ctx.db.insert("authRefreshTokens", {
        sessionId,
        expirationTime: Date.now() + 1000 * 60 * 60,
      });
      sessionIds.push(sessionId);
    }
    return { userId, sessionIds };
  });
}

// Filtered in JS rather than through withIndex: the schema union is large enough
// that TypeScript drops narrowing on a loosely-typed `t`, and the index adds
// nothing at test-scale row counts.
const countSessions = (t: ReturnType<typeof convexTest>, userId: Id<"users">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("authSessions").collect()).filter(
      (s) => s.userId === userId,
    ).length,
  );

// ---------------------------------------------------------------- email policy

describe("email policy", () => {
  test("normalizes case, whitespace and unicode compatibility forms", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
    // Full-width characters normalize to ASCII, so they cannot be used to
    // register a visually identical second account.
    expect(normalizeEmail("ｕｓｅｒ@example.com")).toBe("user@example.com");
  });

  test("does NOT strip gmail dots or +tags", () => {
    // Deliberate: provider-specific folding applied universally would merge
    // genuinely distinct addresses and become a takeover vector.
    expect(normalizeEmail("a.b+tag@gmail.com")).toBe("a.b+tag@gmail.com");
  });

  test("rejects malformed addresses", () => {
    for (const bad of ["", "no-at", "a@b", "a@@b.com", "a b@c.com", `${"x".repeat(250)}@y.com`]) {
      expect(isValidEmailShape(bad)).toBe(false);
    }
    expect(isValidEmailShape("ok@example.com")).toBe(true);
  });

  test("rejects disposable providers, case- and whitespace-insensitively", () => {
    expect(isDisposableEmail("a@mailinator.com")).toBe(true);
    expect(isDisposableEmail("  A@GuerrillaMail.com ")).toBe(true);
    expect(isDisposableEmail("a@example.com")).toBe(false);
  });

  test("sign-up domain allow-list: approved consumer providers only", () => {
    for (const ok of [
      "a@gmail.com", "A@Outlook.COM", "b@yahoo.com", "c@icloud.com",
      "d@proton.me", "e@protonmail.com", "f@zoho.com", "g@aol.com",
      "h@gmx.com", "i@mail.com", "j@hotmail.com", "k@live.com",
    ]) {
      expect(isAllowedSignupDomain(ok)).toBe(true);
      expect(assertUsableEmail(ok)).toBe(normalizeEmail(ok));
    }
    for (const no of ["a@example.com", "a@company.io", "a@mailinator.com"]) {
      expect(isAllowedSignupDomain(no)).toBe(false);
    }
  });

  test("rejection messages are specific for domain policy, not an existence oracle", () => {
    // Domain policy reveals nothing about ACCOUNTS, so malformed vs unsupported
    // are allowed to differ (user-friendly). Neither reveals existence.
    const msg = (email: string) => {
      try {
        assertUsableEmail(email);
        return "OK";
      } catch (e) {
        return String((e as { data?: string })?.data ?? (e as Error).message);
      }
    };
    expect(msg("not-an-email")).toBe(INVALID_EMAIL_MESSAGE);
    expect(msg("a@company.io")).toBe(UNSUPPORTED_DOMAIN_MESSAGE);
    expect(msg("a@mailinator.com")).toBe(UNSUPPORTED_DOMAIN_MESSAGE);
    expect(msg("real@gmail.com")).toBe("OK");
  });
});

// ------------------------------------------------------------- password policy

describe("password policy", () => {
  test("flags extremely common passwords, case-insensitively", () => {
    for (const c of ["password", "Password", "PASSWORD1", "Qwerty123!", "letmein"]) {
      expect(isCommonPassword(c)).toBe(true);
    }
    for (const ok of ["Tr0ub4dour&3xplace", "9x!Kq2mVw", "correct horse!7"]) {
      expect(isCommonPassword(ok)).toBe(false);
    }
  });

  test("rejects a password containing the user's name or email parts", () => {
    const grab = (fn: () => void) => {
      try {
        fn();
        return "OK";
      } catch (e) {
        return String((e as { data?: string })?.data ?? (e as Error).message);
      }
    };
    expect(grab(() => assertPasswordNotIdentity("Alice!2024", "x@gmail.com", "Alice")))
      .toBe("Password must not contain your name.");
    expect(grab(() => assertPasswordNotIdentity("johnDoe!9", "johndoe@gmail.com", "")))
      .toBe("Password must not contain part of your email.");
    // Domain label ("gmail") is part of the email too.
    expect(grab(() => assertPasswordNotIdentity("myGmailPw!9", "z@gmail.com", "")))
      .toBe("Password must not contain part of your email.");
    // A clean password with no identity overlap passes.
    expect(grab(() => assertPasswordNotIdentity("9x!Kq2mVw", "user@gmail.com", "Bob")))
      .toBe("OK");
  });
});

// ------------------------------------------------------------------- OTP codes

describe("one-time codes", () => {
  test("are 8 digits and unbiased across the full alphabet", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const code = generateNumericCode();
      expect(code).toMatch(/^\d{8}$/);
      for (const d of code) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    // All ten digits must appear. The old `byte % 10` favoured 0-5; with 3200
    // samples a missing digit would be a real signal, not noise.
    expect(counts.size).toBe(10);
    const freqs = [...counts.values()];
    const spread = Math.max(...freqs) / Math.min(...freqs);
    expect(spread).toBeLessThan(1.5);
  });

  test("are not predictable across calls", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateNumericCode()));
    expect(seen.size).toBeGreaterThan(190);
  });

  test("codes are only logged when NO mail transport exists", () => {
    // The production leak this closes: codes were previously written to the
    // Convex log stream unconditionally, so log access was an auth bypass.
    const prev = process.env.SMTP_HOST;
    process.env.SMTP_HOST = "smtp.example.com";
    expect(hasMailTransport()).toBe(true);
    process.env.SMTP_HOST = undefined;
    // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined"
    delete process.env.SMTP_HOST;
    const prevKey = process.env.RESEND_API_KEY;
    // biome-ignore lint/performance/noDelete: same reason
    delete process.env.RESEND_API_KEY;
    expect(hasMailTransport()).toBe(false);
    if (prev !== undefined) process.env.SMTP_HOST = prev;
    if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey;
  });
});

// ------------------------------------------------- single active session (req 2)

describe("single active session", () => {
  test("revokes every other session and its refresh tokens", async () => {
    const t = convexTest(schema, modules);
    const { userId, sessionIds } = await seedSessions(t, 3);
    expect(await countSessions(t, userId)).toBe(3);

    const keep = sessionIds[2];
    if (!keep) throw new Error("seed failed");
    const revoked = await t.run((ctx) => revokeOtherSessions(ctx, userId, keep));

    expect(revoked).toBe(2);
    expect(await countSessions(t, userId)).toBe(1);

    // An orphaned refresh token can still mint access tokens, so revocation
    // that leaves them behind is cosmetic.
    const tokens = await t.run(async (ctx) =>
      ctx.db.query("authRefreshTokens").collect(),
    );
    expect(tokens.length).toBe(1);
    expect(tokens[0]?.sessionId).toBe(keep);
  });

  test("keep=null revokes ALL sessions — the pre-session-creation ordering", async () => {
    // @convex-dev/auth creates the session at different points depending on the
    // flow. When the callback runs first (fresh browser, no auth context),
    // getAuthSessionId returns null and every old session must go; the new one
    // is created immediately afterwards and survives.
    const t = convexTest(schema, modules);
    const { userId } = await seedSessions(t, 3);
    const revoked = await t.run((ctx) => revokeOtherSessions(ctx, userId, null));
    expect(revoked).toBe(3);
    expect(await countSessions(t, userId)).toBe(0);
  });

  test("sequential logins converge on exactly one session, and it is the newest", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedSessions(t, 1);

    let newest: Id<"authSessions"> | null = null;
    for (let i = 0; i < 5; i++) {
      newest = await t.run(async (ctx) => {
        const id = await ctx.db.insert("authSessions", {
          userId,
          expirationTime: Date.now() + 1000,
        });
        await revokeOtherSessions(ctx, userId, id);
        return id;
      });
      expect(await countSessions(t, userId)).toBe(1);
    }

    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(remaining.length).toBe(1);
    expect(remaining[0]?._id).toBe(newest);
  });

  test("is idempotent — re-running leaves the surviving session alone", async () => {
    const t = convexTest(schema, modules);
    const { userId, sessionIds } = await seedSessions(t, 2);
    const keep = sessionIds[0];
    if (!keep) throw new Error("seed failed");
    await t.run((ctx) => revokeOtherSessions(ctx, userId, keep));
    const second = await t.run((ctx) => revokeOtherSessions(ctx, userId, keep));
    expect(second).toBe(0);
    expect(await countSessions(t, userId)).toBe(1);
  });

  test("never touches another user's sessions", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedSessions(t, 2);
    const otherId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { email: "other@t.test" });
      await ctx.db.insert("authSessions", { userId: id, expirationTime: Date.now() + 1000 });
      return id;
    });
    await t.run((ctx) => revokeOtherSessions(ctx, userId, null));
    expect(await countSessions(t, otherId)).toBe(1);
  });
});

// --------------------------------------------------------- auth events (req 20)

describe("auth events", () => {
  test("records each event type with a user and timestamp", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "e@t.test" }));
    const types = [
      "login", "logout", "login_failed", "google_login", "otp_verified",
      "otp_failed", "password_changed", "password_reset", "session_revoked",
      "session_replaced",
    ] as const;
    await t.run(async (ctx) => {
      for (const type of types) await recordAuthEvent(ctx, { type, userId });
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("authEvents")
        .withIndex("by_user_at", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(rows.length).toBe(types.length);
    expect(new Set(rows.map((r) => r.type)).size).toBe(types.length);
    expect(rows.every((r) => typeof r.at === "number")).toBe(true);
  });

  test("never throws, and records an unattributed event when there is no user", async () => {
    const t = convexTest(schema, modules);
    // A logout can happen when the session is already gone, so userId is
    // optional and writing history must never be able to reject.
    await expect(
      t.run((ctx) => recordAuthEvent(ctx, { type: "logout" })),
    ).resolves.not.toThrow();
    const rows = await t.run(async (ctx) => ctx.db.query("authEvents").collect());
    expect(rows.length).toBe(1);
    expect(rows[0]?.userId).toBeUndefined();
  });

  test("stores only a truncated IP prefix, never a full address", () => {
    expect(ipPrefix("203.0.113.42")).toBe("203.0.113.0/24");
    expect(ipPrefix("203.0.113.42, 70.41.3.18")).toBe("203.0.113.0/24");
    expect(ipPrefix("2001:db8:85a3:8d3::370:7348")).toBe("2001:db8:85a3::/48");
    expect(ipPrefix(undefined)).toBeUndefined();
    expect(ipPrefix("garbage")).toBeUndefined();
  });

  test("truncates an overlong user-agent rather than storing it whole", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      recordAuthEvent(ctx, { type: "login", userAgent: "U".repeat(5000) }),
    );
    const [row] = await t.run(async (ctx) => ctx.db.query("authEvents").collect());
    expect((row?.userAgent ?? "").length).toBeLessThanOrEqual(256);
  });

  test("purge removes events past the 90-day retention and keeps recent ones", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("authEvents", { type: "login", at: now - 1000 * 60 * 60 * 24 * 91 });
      await ctx.db.insert("authEvents", { type: "login", at: now - 1000 * 60 * 60 * 24 * 89 });
    });
    const deleted = await t.mutation(internal.authEventsPurge.purgeOld, {});
    expect(deleted).toBe(1);
    const left = await t.run(async (ctx) => ctx.db.query("authEvents").collect());
    expect(left.length).toBe(1);
  });
});

// ----------------------------------------------------------- schema (req 9)

describe("required auth data is persistable", () => {
  test("users carries the account/security fields", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Ada",
        email: "Ada@Example.com",
        emailNormalized: normalizeEmail("Ada@Example.com"),
        emailVerificationTime: now,
        accountStatus: "active",
        lastLoginAt: now,
        lastActivityAt: now,
        passwordChangedAt: now,
      }),
    );
    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user?.emailNormalized).toBe("ada@example.com");
    expect(user?.accountStatus).toBe("active");
    expect(user?.passwordChangedAt).toBe(now);
  });

  test("users are findable by normalized email", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("users", { email: "Mixed@Case.com", emailNormalized: "mixed@case.com" }),
    );
    const found = await t.run(async (ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_email_normalized", (q) => q.eq("emailNormalized", "mixed@case.com"))
        .unique(),
    );
    expect(found).not.toBeNull();
  });

  test("sessions and refresh tokens carry expiry, and identities bind by provider subject", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "i@t.test" }));
    await t.run(async (ctx) => {
      await ctx.db.insert("authAccounts", {
        userId,
        provider: "google",
        // The immutable OIDC `sub`, NOT the email — an attacker who acquires the
        // address cannot inherit the identity.
        providerAccountId: "117445678901234567890",
      });
    });
    const account = await t.run(async (ctx) =>
      ctx.db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) =>
          q.eq("provider", "google").eq("providerAccountId", "117445678901234567890"),
        )
        .unique(),
    );
    expect(account?.userId).toBe(userId);
  });
});

// ---------------------------------------------------------------------------
// B3/B4 — the account-existence oracle.
// ---------------------------------------------------------------------------
describe("accountExists is not reachable from the public API", () => {
  /**
   * It was declared `query`, i.e. callable as api.authSessions.accountExists,
   * while its own comment claimed it never was. That single fact defeated
   * requestPasswordReset, which exists purely so a known and an unknown address
   * are indistinguishable. Anyone could skip the wrapper and ask the helper.
   */
  /**
   * Asserted against the SOURCE, and that is deliberate — two runtime approaches
   * were tried first and neither can prove this:
   *
   *   - `expect(api.authSessions.accountExists).toBeUndefined()` — the generated
   *     `api` is a proxy that returns a FunctionReference for ANY path, so this
   *     passes for real functions and absent ones alike. It proves nothing.
   *   - calling it through `t.query(api…)` — convex-test dispatches by name and
   *     does NOT model the public/internal boundary, so it resolves happily.
   *     The boundary is real, but only the deployed server enforces it.
   *
   * So the honest regression guard is the registration itself: if someone
   * changes this back to `query`, the enumeration oracle returns, and this fails.
   */
  test("it is registered as internalQuery, not query", () => {
    const source = Object.values(
      import.meta.glob("./authSessions.ts", { query: "?raw", import: "default", eager: true }),
    )[0] as string;
    expect(source).toContain("export const accountExists = internalQuery({");
    expect(source).not.toContain("export const accountExists = query({");
  });

  test("it still answers correctly when called internally", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        email: "known@gmail.com",
        emailNormalized: "known@gmail.com",
        emailVerificationTime: Date.now(),
      });
    });
    const yes = await t.query(internal.authSessions.accountExists, {
      email: "known@gmail.com",
    });
    const no = await t.query(internal.authSessions.accountExists, {
      email: "nobody@gmail.com",
    });
    expect(yes).toBe(true);
    expect(no).toBe(false);
  });

  /** Case and whitespace must not slip past the normalised lookup. */
  test("it normalises before comparing", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        email: "mixed@gmail.com",
        emailNormalized: "mixed@gmail.com",
      });
    });
    for (const probe of ["MIXED@gmail.com", "  mixed@GMAIL.com  "]) {
      expect(
        await t.query(internal.authSessions.accountExists, { email: probe }),
      ).toBe(true);
    }
  });

  /**
   * The legacy path used to `.collect()` the entire users table on every miss.
   * Rows predating emailNormalized must still be found, but only those rows may
   * be read — the index range is what bounds it.
   */
  test("a pre-emailNormalized row is still found, by the bounded path", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      // No emailNormalized, and mixed case — invisible to the fast index.
      await ctx.db.insert("users", { email: "Legacy@Gmail.com" });
      // Plenty of modern rows, which the bounded scan must NOT have to read.
      for (let i = 0; i < 50; i++) {
        await ctx.db.insert("users", {
          email: `u${i}@gmail.com`,
          emailNormalized: `u${i}@gmail.com`,
        });
      }
    });
    expect(
      await t.query(internal.authSessions.accountExists, {
        email: "legacy@gmail.com",
      }),
    ).toBe(true);
    expect(
      await t.query(internal.authSessions.accountExists, {
        email: "absent@gmail.com",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B1 — one email, one user.
// ---------------------------------------------------------------------------
describe("duplicate account reconciliation", () => {
  const EMAIL = "dupe@gmail.com";

  /** An abandoned password sign-up: a user row plus its credential, unverified. */
  async function seedUnverified(t: ReturnType<typeof convexTest>, name?: string) {
    return await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        email: EMAIL,
        emailNormalized: EMAIL,
        ...(name ? { name } : {}),
      });
      await ctx.db.insert("authAccounts", {
        userId,
        provider: "password",
        providerAccountId: EMAIL,
        secret: "scrypt-hash",
      });
      return userId;
    });
  }

  /** The verified account a later Google sign-in would create. */
  async function seedVerified(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        email: EMAIL,
        emailNormalized: EMAIL,
        emailVerificationTime: Date.now(),
      });
      await ctx.db.insert("authAccounts", {
        userId,
        provider: "google",
        providerAccountId: "google-sub-123",
      });
      return userId;
    });
  }

  /**
   * The reported bug. uniqueUserWithVerifiedEmail filters on
   * emailVerificationTime, so an unverified sign-up is invisible to it and
   * Google creates a SECOND row — leaving the password credential on an
   * orphan the user can still log into and find empty.
   */
  test("an unverified twin is absorbed, leaving exactly one user", async () => {
    const t = convexTest(schema, modules);
    const orphanId = await seedUnverified(t);
    const survivorId = await seedVerified(t);

    const absorbed = await t.run(async (ctx) =>
      reconcileDuplicateUsers(ctx, survivorId),
    );
    expect(absorbed).toBe(1);

    const users = await t.run(async (ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(users[0]._id).toBe(survivorId);
    expect(await t.run(async (ctx) => ctx.db.get(orphanId))).toBeNull();
  });

  /** The password chosen during the abandoned sign-up must keep working. */
  test("the absorbed account's credential moves to the survivor", async () => {
    const t = convexTest(schema, modules);
    await seedUnverified(t);
    const survivorId = await seedVerified(t);
    await t.run(async (ctx) => reconcileDuplicateUsers(ctx, survivorId));

    const accounts = await t.run(async (ctx) =>
      ctx.db.query("authAccounts").collect(),
    );
    expect(accounts).toHaveLength(2);
    expect(accounts.every((a) => a.userId === survivorId)).toBe(true);
    expect(accounts.map((a) => a.provider).sort()).toEqual(["google", "password"]);
  });

  /** A name the survivor's own profile did not supply is worth keeping. */
  test("a display name is carried over when the survivor has none", async () => {
    const t = convexTest(schema, modules);
    await seedUnverified(t, "Sunny");
    const survivorId = await seedVerified(t);
    await t.run(async (ctx) => reconcileDuplicateUsers(ctx, survivorId));
    const survivor = await t.run(async (ctx) => ctx.db.get(survivorId));
    expect(survivor?.name).toBe("Sunny");
  });

  /**
   * TWO VERIFIED ACCOUNTS ARE NEVER MERGED. That is pre-existing data whose
   * resolution is a human decision, and deleting either would destroy real work.
   */
  test("a verified twin is left completely alone", async () => {
    const t = convexTest(schema, modules);
    const otherId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        email: EMAIL,
        emailNormalized: EMAIL,
        emailVerificationTime: Date.now(),
      }),
    );
    const survivorId = await seedVerified(t);

    const absorbed = await t.run(async (ctx) =>
      reconcileDuplicateUsers(ctx, survivorId),
    );
    expect(absorbed).toBe(0);
    expect(await t.run(async (ctx) => ctx.db.get(otherId))).not.toBeNull();
  });

  /** An unverified survivor must not swallow anyone — that just moves the bug. */
  test("an unverified survivor absorbs nothing", async () => {
    const t = convexTest(schema, modules);
    await seedUnverified(t);
    const unverifiedSurvivor = await seedUnverified(t);
    const absorbed = await t.run(async (ctx) =>
      reconcileDuplicateUsers(ctx, unverifiedSurvivor),
    );
    expect(absorbed).toBe(0);
    const users = await t.run(async (ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(2);
  });

  /** Unrelated accounts must never be touched. */
  test("a different address is untouched", async () => {
    const t = convexTest(schema, modules);
    const strangerId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        email: "stranger@gmail.com",
        emailNormalized: "stranger@gmail.com",
      }),
    );
    const survivorId = await seedVerified(t);
    const absorbed = await t.run(async (ctx) =>
      reconcileDuplicateUsers(ctx, survivorId),
    );
    expect(absorbed).toBe(0);
    expect(await t.run(async (ctx) => ctx.db.get(strangerId))).not.toBeNull();
  });

  /** A duplicate credential for a provider the survivor already has is dropped. */
  test("a clashing provider credential is discarded, not duplicated", async () => {
    const t = convexTest(schema, modules);
    await seedUnverified(t);
    const survivorId = await seedVerified(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("authAccounts", {
        userId: survivorId,
        provider: "password",
        providerAccountId: EMAIL,
        secret: "the-survivor-own-hash",
      });
    });
    await t.run(async (ctx) => reconcileDuplicateUsers(ctx, survivorId));

    const passwordAccounts = await t.run(async (ctx) =>
      (await ctx.db.query("authAccounts").collect()).filter(
        (a) => a.provider === "password",
      ),
    );
    expect(passwordAccounts).toHaveLength(1);
    expect(passwordAccounts[0].secret).toBe("the-survivor-own-hash");
  });
});

// ---------------------------------------------------------------------------
// B5/B6 — abandoned sign-ups must expire, and nothing else may be touched.
// ---------------------------------------------------------------------------
describe("abandoned signup purge", () => {
  const OLD = Date.now() - UNVERIFIED_TTL_MS - 60_000;

  /** An unverified account whose creation time we can control. */
  async function seedAbandoned(
    t: ReturnType<typeof convexTest>,
    email: string,
    opts: { codeExpires?: number; session?: boolean } = {},
  ) {
    return await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        email,
        emailNormalized: email,
      });
      const accountId = await ctx.db.insert("authAccounts", {
        userId,
        provider: "password",
        providerAccountId: email,
        secret: "hash",
      });
      if (opts.codeExpires !== undefined) {
        await ctx.db.insert("authVerificationCodes", {
          accountId,
          provider: "verify-otp",
          code: "hashed-code",
          expirationTime: opts.codeExpires,
        });
      }
      if (opts.session) {
        await ctx.db.insert("authSessions", {
          userId,
          expirationTime: Date.now() + 60_000,
        });
      }
      return { userId, accountId };
    });
  }

  /** convex-test cannot backdate _creationTime, so age is simulated by the TTL. */
  const purge = (t: ReturnType<typeof convexTest>) =>
    t.mutation(internal.authPurge.purgeUnverified, {});

  test("a young unverified account is NOT purged", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedAbandoned(t, "young@gmail.com");
    const result = await purge(t);
    expect(result.purged).toBe(0);
    expect(await t.run(async (ctx) => ctx.db.get(userId))).not.toBeNull();
  });

  test("a verified account is never a candidate at all", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        email: "verified@gmail.com",
        emailNormalized: "verified@gmail.com",
        emailVerificationTime: Date.now(),
      }),
    );
    const result = await purge(t);
    expect(result.scanned).toBe(0);
    expect(await t.run(async (ctx) => ctx.db.get(userId))).not.toBeNull();
  });

  /**
   * The guard that stops the purge deleting an account out from under someone
   * who is typing the code they were just sent.
   */
  test("an account with a live verification code is skipped", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedAbandoned(t, "typing@gmail.com", {
      codeExpires: Date.now() + 10 * 60_000,
    });
    await purge(t);
    expect(await t.run(async (ctx) => ctx.db.get(userId))).not.toBeNull();
  });

  /** Belt and braces: an unverified row with a session is a live user. */
  test("an account with a session is skipped", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedAbandoned(t, "session@gmail.com", {
      session: true,
    });
    await purge(t);
    expect(await t.run(async (ctx) => ctx.db.get(userId))).not.toBeNull();
  });

  /**
   * Deleting only the user row would leave the authAccounts row, whose
   * (provider, providerAccountId) pair still collides — recreating the
   * squatting lockout in a new form instead of fixing it.
   */
  test("purging removes the account and its codes, not just the user", async () => {
    const t = convexTest(schema, modules);
    await seedAbandoned(t, "squatted@gmail.com", {
      codeExpires: Date.now() - 60_000, // already expired
    });
    // Age the account past the TTL by moving the clock forward.
    vi.setSystemTime(new Date(Date.now() + UNVERIFIED_TTL_MS + 120_000));
    try {
      const result = await purge(t);
      expect(result.purged).toBe(1);
      const [users, accounts, codes] = await t.run(async (ctx) => [
        await ctx.db.query("users").collect(),
        await ctx.db.query("authAccounts").collect(),
        await ctx.db.query("authVerificationCodes").collect(),
      ]);
      expect(users).toHaveLength(0);
      expect(accounts).toHaveLength(0);
      expect(codes).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
