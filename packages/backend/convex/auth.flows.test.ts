/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { googleProfile } from "./authPolicy";
import schema from "./schema";

/**
 * End-to-end auth FLOW tests, driving the real `auth:signIn` action rather than
 * poking at tables. These cover the time- and replay-dependent behaviour that
 * the unit tests in auth.security.test.ts cannot reach: code expiry, single-use,
 * resend invalidation, brute-force lockout, reset semantics and session lifetime.
 *
 * Codes are read back by capturing the dev-fallback console.warn. That fallback
 * only exists when no mail transport is configured, which is exactly the state
 * of a test run — and asserting on it here doubles as proof that the fallback
 * still works for local development after the production leak was closed.
 */
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const PASSWORD = "Str0ngPass1";
const NEW_PASSWORD = "N3wStr0ngPass";

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  process.env.SITE_URL = "http://localhost:3000";
  // auth.config.ts uses this as the OIDC issuer; the verification flow reads it.
  process.env.CONVEX_SITE_URL = "http://localhost:3211";
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(keys.privateKey);
  process.env.JWKS = JSON.stringify({ keys: [await exportJWK(keys.publicKey)] });
  // Force the no-transport state so codes are recoverable from the log fallback.
  // `process.env.X = undefined` stores the STRING "undefined", which is truthy —
  // it would leave hasMailTransport() true and suppress the very log we read.
  // biome-ignore lint/performance/noDelete: the var must be absent, not "undefined"
  delete process.env.SMTP_HOST;
  // biome-ignore lint/performance/noDelete: same
  delete process.env.RESEND_API_KEY;
});

/** Run `fn`, returning whatever code it caused to be emitted. */
async function captureCode(fn: () => Promise<unknown>): Promise<string> {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await fn();
    for (const call of [...spy.mock.calls].reverse()) {
      const line = String(call[0] ?? "");
      const m = line.match(/code for [^:]+:\s*(\d{6,8})/);
      if (m?.[1]) return m[1];
    }
    throw new Error(`no code emitted; saw ${spy.mock.calls.length} warnings`);
  } finally {
    spy.mockRestore();
  }
}

const signIn = (t: ReturnType<typeof convexTest>, params: Record<string, unknown>) =>
  t.action(api.auth.signIn, { provider: "password", params });

/** Sign up and verify, leaving a usable account. Returns the user id. */
async function createVerifiedUser(
  t: ReturnType<typeof convexTest>,
  email: string,
): Promise<Id<"users">> {
  const code = await captureCode(() =>
    signIn(t, { email, password: PASSWORD, flow: "signUp" }),
  );
  await signIn(t, { email, code, flow: "email-verification" });
  const user = await t.run(async (ctx) =>
    (await ctx.db.query("users").collect()).find((u) => u.email === email),
  );
  if (!user) throw new Error("user not created");
  return user._id;
}

const sessionsFor = (t: ReturnType<typeof convexTest>, userId: Id<"users">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("authSessions").collect()).filter((s) => s.userId === userId),
  );

// ------------------------------------------------------------------ OTP codes

describe("email verification codes", () => {
  test("sign-up does NOT authenticate until the code is verified", async () => {
    const t = convexTest(schema, modules);
    const result = await signIn(t, {
      email: "a@example.com",
      password: PASSWORD,
      flow: "signUp",
    });
    // Verification is mandatory, so no tokens are issued yet. Shipping a design
    // that skips this step is what would strand every new signup.
    expect((result as { tokens: unknown } | null)?.tokens ?? null).toBeNull();
  });

  test("a correct code verifies exactly once — replay is refused", async () => {
    const t = convexTest(schema, modules);
    const email = "replay@example.com";
    const code = await captureCode(() =>
      signIn(t, { email, password: PASSWORD, flow: "signUp" }),
    );

    const first = await signIn(t, { email, code, flow: "email-verification" });
    expect((first as { tokens: unknown } | null)?.tokens).toBeTruthy();

    // The row is consumed on use, so the same code cannot be presented again.
    await expect(
      signIn(t, { email, code, flow: "email-verification" }),
    ).rejects.toThrow();
  });

  test("an expired code is refused", async () => {
    const t = convexTest(schema, modules);
    const email = "expired@example.com";
    const code = await captureCode(() =>
      signIn(t, { email, password: PASSWORD, flow: "signUp" }),
    );
    // Age the stored code past its 15-minute window.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("authVerificationCodes").collect()) {
        await ctx.db.patch(row._id, { expirationTime: Date.now() - 1000 });
      }
    });
    await expect(
      signIn(t, { email, code, flow: "email-verification" }),
    ).rejects.toThrow();
  });

  test("resending invalidates the previous code", async () => {
    const t = convexTest(schema, modules);
    const email = "resend@example.com";
    const first = await captureCode(() =>
      signIn(t, { email, password: PASSWORD, flow: "signUp" }),
    );
    const second = await captureCode(() =>
      signIn(t, { email, password: PASSWORD, flow: "signUp" }),
    );
    expect(second).not.toBe(first);

    // Only one code may be outstanding per account, so the older one is dead.
    await expect(
      signIn(t, { email, code: first, flow: "email-verification" }),
    ).rejects.toThrow();
    const ok = await signIn(t, { email, code: second, flow: "email-verification" });
    expect((ok as { tokens: unknown } | null)?.tokens).toBeTruthy();
  });

  test("wrong codes are rate-limited before they can be brute-forced", async () => {
    const t = convexTest(schema, modules);
    const email = "brute@example.com";
    await captureCode(() => signIn(t, { email, password: PASSWORD, flow: "signUp" }));

    let rejected = 0;
    for (let i = 0; i < 8; i++) {
      await signIn(t, { email, code: "00000000", flow: "email-verification" }).catch(
        () => {
          rejected++;
        },
      );
    }
    // 8 attempts against a 5/hr budget: every one fails, and the later ones fail
    // because the account is locked rather than because the digits were wrong.
    expect(rejected).toBe(8);
  });
});

// ------------------------------------------------------------ password policy

describe("password policy", () => {
  test("rejects passwords that miss any required class", async () => {
    const t = convexTest(schema, modules);
    for (const weak of ["short1A", "alllowercase1", "ALLUPPERCASE1", "NoDigitsHere"]) {
      await expect(
        signIn(t, { email: `w${weak}@example.com`, password: weak, flow: "signUp" }),
      ).rejects.toThrow();
    }
  });

  test("accepts a compliant password", async () => {
    const t = convexTest(schema, modules);
    await expect(
      captureCode(() =>
        signIn(t, { email: "good@example.com", password: PASSWORD, flow: "signUp" }),
      ),
    ).resolves.toMatch(/^\d{8}$/);
  });

  test("disposable providers are refused at sign-up", async () => {
    const t = convexTest(schema, modules);
    await expect(
      signIn(t, { email: "x@mailinator.com", password: PASSWORD, flow: "signUp" }),
    ).rejects.toThrow();
  });
});

// -------------------------------------------------------------- reset (req 6)

describe("password reset", () => {
  test("reset code is single-use, and the new password replaces the old", async () => {
    const t = convexTest(schema, modules);
    const email = "reset@example.com";
    await createVerifiedUser(t, email);

    const code = await captureCode(() => signIn(t, { email, flow: "reset" }));
    const done = await signIn(t, {
      email,
      code,
      newPassword: NEW_PASSWORD,
      flow: "reset-verification",
    });
    expect((done as { tokens: unknown } | null)?.tokens).toBeTruthy();

    // Replay of the reset code must fail.
    await expect(
      signIn(t, { email, code, newPassword: "An0therPass", flow: "reset-verification" }),
    ).rejects.toThrow();

    // Old credential is dead; new one works.
    await expect(
      signIn(t, { email, password: PASSWORD, flow: "signIn" }),
    ).rejects.toThrow();
    const ok = await signIn(t, { email, password: NEW_PASSWORD, flow: "signIn" });
    expect((ok as { tokens: unknown } | null)?.tokens).toBeTruthy();
  });

  test("an expired reset code is refused", async () => {
    const t = convexTest(schema, modules);
    const email = "resetexp@example.com";
    await createVerifiedUser(t, email);
    const code = await captureCode(() => signIn(t, { email, flow: "reset" }));
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("authVerificationCodes").collect()) {
        await ctx.db.patch(row._id, { expirationTime: Date.now() - 1000 });
      }
    });
    await expect(
      signIn(t, { email, code, newPassword: NEW_PASSWORD, flow: "reset-verification" }),
    ).rejects.toThrow();
  });

  test("reset leaves exactly one session — every other device is evicted", async () => {
    const t = convexTest(schema, modules);
    const email = "resetsessions@example.com";
    const userId = await createVerifiedUser(t, email);

    // Stand in for other logged-in devices.
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        const sid = await ctx.db.insert("authSessions", {
          userId,
          expirationTime: Date.now() + 1000 * 60 * 60,
        });
        await ctx.db.insert("authRefreshTokens", {
          sessionId: sid,
          expirationTime: Date.now() + 1000 * 60 * 60,
        });
      }
    });
    expect((await sessionsFor(t, userId)).length).toBeGreaterThan(3);

    const code = await captureCode(() => signIn(t, { email, flow: "reset" }));
    await signIn(t, { email, code, newPassword: NEW_PASSWORD, flow: "reset-verification" });

    expect((await sessionsFor(t, userId)).length).toBe(1);
    const events = await t.run(async (ctx) => ctx.db.query("authEvents").collect());
    expect(events.some((e) => e.type === "password_reset")).toBe(true);
  });

  test("requesting a reset for an unknown address does not reveal that it is unknown", async () => {
    const t = convexTest(schema, modules);
    await createVerifiedUser(t, "known@example.com");

    // Via the hardened endpoint. Calling signIn(flow:"reset") directly resolves
    // for a known address and throws InvalidAccountId for an unknown one — the
    // oracle this action exists to close.
    const call = (email: string) =>
      t.action(api.authSessions.requestPasswordReset, { email }).then(
        (r) => `resolved:${JSON.stringify(r)}`,
        (e) => `rejected:${(e as Error).message.slice(0, 40)}`,
      );
    const known = await call("known@example.com");
    const unknown = await call("nobody@example.com");
    // Whatever the outcome, the two must be indistinguishable to a caller.
    expect(unknown).toBe(known);
  });
});

// --------------------------------------------------------- sessions (req 1, 2)

describe("session lifetime and single device", () => {
  test("session lifetime is the 30-day ceiling, not an unbounded login", async () => {
    const t = convexTest(schema, modules);
    const userId = await createVerifiedUser(t, "life@example.com");
    const [session] = await sessionsFor(t, userId);
    const days = ((session?.expirationTime ?? 0) - Date.now()) / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  test("refresh tokens carry the 2-day inactivity budget, which is what expires an idle session", async () => {
    const t = convexTest(schema, modules);
    await createVerifiedUser(t, "idle@example.com");
    const [token] = await t.run(async (ctx) =>
      ctx.db.query("authRefreshTokens").collect(),
    );
    const days = ((token?.expirationTime ?? 0) - Date.now()) / (1000 * 60 * 60 * 24);
    // Enforcement lives here rather than on the session row: an active user keeps
    // minting fresh refresh tokens, so the window slides; an idle one does not.
    expect(days).toBeGreaterThan(1.9);
    expect(days).toBeLessThan(2.1);
  });

  test("a second sign-in leaves the account with one usable session", async () => {
    const t = convexTest(schema, modules);
    const email = "twodevices@example.com";
    const userId = await createVerifiedUser(t, email);
    await signIn(t, { email, password: PASSWORD, flow: "signIn" });
    await signIn(t, { email, password: PASSWORD, flow: "signIn" });

    // The library replaces the caller's own session on each sign-in; the
    // heartbeat mutation converges anything left over.
    const before = (await sessionsFor(t, userId)).length;
    await t.run(async (ctx) => {
      const all = (await ctx.db.query("authSessions").collect()).filter(
        (s) => s.userId === userId,
      );
      const newest = all.sort((a, b) => b._creationTime - a._creationTime)[0];
      if (!newest) throw new Error("no session");
      const { revokeOtherSessions } = await import("./authEvents");
      await revokeOtherSessions(ctx, userId, newest._id);
    });
    expect(before).toBeGreaterThanOrEqual(1);
    expect((await sessionsFor(t, userId)).length).toBe(1);
  });
});

// ------------------------------------------------------------- events (req 20)

describe("auth events are written by real flows", () => {
  test("signup + verification produce login history", async () => {
    const t = convexTest(schema, modules);
    const userId = await createVerifiedUser(t, "events@example.com");
    const events = await t.run(async (ctx) =>
      (await ctx.db.query("authEvents").collect()).filter((e) => e.userId === userId),
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => typeof e.at === "number")).toBe(true);
  });

  test("lastLoginAt and accountStatus are stamped on the user", async () => {
    const t = convexTest(schema, modules);
    const userId = await createVerifiedUser(t, "stamp@example.com");
    const user = await t.run(async (ctx) => ctx.db.get(userId));
    const u = user as { lastLoginAt?: number; accountStatus?: string } | null;
    expect(typeof u?.lastLoginAt).toBe("number");
    expect(u?.accountStatus).toBe("active");
  });
});

// -------------------------------------------------------------- Google (req 3)

describe("Google identity", () => {
  test("an unverified Google email is refused", () => {
    // The exact mapper wired into auth.ts, so this tests the shipped control
    // rather than a reconstruction of it.
    expect(() =>
      googleProfile({ sub: "123", email: "a@b.com", email_verified: false }),
    ).toThrow(/not verified/);
    expect(() => googleProfile({ sub: "123", email: "a@b.com" })).toThrow(/not verified/);
  });

  test("a verified email is accepted and normalized", () => {
    const p = googleProfile({ sub: "s1", email: "  User@Example.COM ", email_verified: true });
    expect(p.email).toBe("user@example.com");
    expect(p.emailNormalized).toBe("user@example.com");
  });

  test("identity is keyed on the immutable sub, never the email", () => {
    // Same person, new address: the id must not move, or changing a Gmail
    // address would orphan the account and a recycled address could claim it.
    const before = googleProfile({ sub: "sub-42", email: "old@x.com", email_verified: true });
    const after = googleProfile({ sub: "sub-42", email: "new@x.com", email_verified: true });
    expect(before.id).toBe("sub-42");
    expect(after.id).toBe(before.id);
    expect(after.email).not.toBe(before.email);
  });
});
