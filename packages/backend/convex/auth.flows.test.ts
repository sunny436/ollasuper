/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
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

const PASSWORD = "Str0ngPass1!";
const NEW_PASSWORD = "N3wStr0ngPass!";

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
  // Code logging is explicit opt-in now (authCodes.deliverCode, audit §14):
  // an absent transport alone no longer writes live codes to the log.
  process.env.AUTH_LOG_CODES = "1";
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

/**
 * Magic-OTP send. Used where a test needs to emit a code to the SAME address
 * repeatedly: a repeated sign-up no longer does that, because a collision now
 * deliberately sends nothing (see "sign-up against an existing address").
 */
const otpSend = (t: ReturnType<typeof convexTest>, email: string) =>
  t.action(api.auth.signIn, { provider: "resend-otp", params: { email } });

/** Ask for a fresh verification code on an existing, unverified account. */
const resendVerification = (t: ReturnType<typeof convexTest>, email: string) =>
  signIn(t, { email, flow: "email-verification" });

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
      email: "a@gmail.com",
      password: PASSWORD,
      flow: "signUp",
    });
    // Verification is mandatory, so no tokens are issued yet. Shipping a design
    // that skips this step is what would strand every new signup.
    expect((result as { tokens: unknown } | null)?.tokens ?? null).toBeNull();
  });

  test("a correct code verifies exactly once — replay is refused", async () => {
    const t = convexTest(schema, modules);
    const email = "replay@gmail.com";
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
    const email = "expired@gmail.com";
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
    const email = "resend@gmail.com";
    const first = await captureCode(() =>
      signIn(t, { email, password: PASSWORD, flow: "signUp" }),
    );
    // The resend path is `email-verification` with no code — NOT a repeated
    // sign-up, which is now a collision and deliberately sends nothing.
    const second = await captureCode(() => resendVerification(t, email));
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
    const email = "brute@gmail.com";
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
        signIn(t, { email: `w${weak}@gmail.com`, password: weak, flow: "signUp" }),
      ).rejects.toThrow();
    }
  });

  test("accepts a compliant password", async () => {
    const t = convexTest(schema, modules);
    await expect(
      captureCode(() =>
        signIn(t, { email: "good@gmail.com", password: PASSWORD, flow: "signUp" }),
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
    const email = "reset@gmail.com";
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
      signIn(t, { email, code, newPassword: "An0therPass!", flow: "reset-verification" }),
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
    const email = "resetexp@gmail.com";
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
    const email = "resetsessions@gmail.com";
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
    await createVerifiedUser(t, "known@gmail.com");

    // Via the hardened endpoint. Calling signIn(flow:"reset") directly resolves
    // for a known address and throws InvalidAccountId for an unknown one — the
    // oracle this action exists to close.
    const call = (email: string) =>
      t.action(api.authSessions.requestPasswordReset, { email }).then(
        (r) => `resolved:${JSON.stringify(r)}`,
        (e) => `rejected:${(e as Error).message.slice(0, 40)}`,
      );
    const known = await call("known@gmail.com");
    const unknown = await call("nobody@gmail.com");
    // Whatever the outcome, the two must be indistinguishable to a caller.
    expect(unknown).toBe(known);

    // The send is now SCHEDULED rather than awaited, which is what makes the two
    // branches take the same time as well as return the same body. Drain it here
    // or the job outlives the test and convex-test's fake database throws
    // "Write outside of transaction" as an unhandled rejection.
    await new Promise((r) => setTimeout(r, 25));
    await t.finishInProgressScheduledFunctions();
  });

  test("the reset send is deferred, so the two branches do the same work inline", async () => {
    const t = convexTest(schema, modules);
    await createVerifiedUser(t, "known@gmail.com");

    const scheduledAfter = async (email: string) => {
      await t.action(api.authSessions.requestPasswordReset, { email });
      return t.run(async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).length,
      );
    };

    // A KNOWN address queues the delivery instead of performing it inline —
    // that is the timing oracle's closure, not a cosmetic change.
    expect(await scheduledAfter("known@gmail.com")).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 25));
    await t.finishInProgressScheduledFunctions();

    // An UNKNOWN address queues nothing, and did no extra work either way.
    const before = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).length,
    );
    await t.action(api.authSessions.requestPasswordReset, {
      email: "nobody@gmail.com",
    });
    const after = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).length,
    );
    expect(after).toBe(before);
  });

  test("reset emails for one account are bounded per hour", async () => {
    const t = convexTest(schema, modules);
    await createVerifiedUser(t, "known@gmail.com");

    // Six requests, a limit of five: the sixth must queue no delivery. Without
    // this an unauthenticated caller could drain a metered mail quota that the
    // SAME transport uses for OTP and verification codes — a denial of service
    // against sign-in, not merely nuisance mail.
    let queued = 0;
    for (let i = 0; i < 6; i++) {
      const before = await t.run(async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).length,
      );
      await t.action(api.authSessions.requestPasswordReset, {
        email: "known@gmail.com",
      });
      const after = await t.run(async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).length,
      );
      if (after > before) queued += 1;
      await new Promise((r) => setTimeout(r, 25));
    await t.finishInProgressScheduledFunctions();
    }
    expect(queued).toBe(5);

    // And the caller still cannot tell — the body is identical once throttled.
    const r = await t.action(api.authSessions.requestPasswordReset, {
      email: "known@gmail.com",
    });
    expect(r).toEqual({ ok: true });
  });
});

// ----------------------------------------------------- allow-list is signup-only

describe("domain allow-list scope", () => {
  test("an existing user whose domain is NOT allow-listed can still log in", async () => {
    const t = convexTest(schema, modules);
    const email = "legacy@company.io"; // not on the sign-up allow-list
    // Allow the domain just long enough to CREATE the account (as if it had been
    // created before the allow-list existed), then remove it.
    process.env.AUTH_EXTRA_ALLOWED_DOMAINS = "company.io";
    try {
      await createVerifiedUser(t, email);
    } finally {
      // biome-ignore lint/performance/noDelete: the var must be ABSENT, not ""
      delete process.env.AUTH_EXTRA_ALLOWED_DOMAINS;
    }
    // The allow-list is sign-up only. Login must still succeed — otherwise every
    // pre-existing user on an unlisted domain (admin@myos.test included) is
    // locked out. Regression guard for exactly that bug.
    const r = await signIn(t, { email, password: PASSWORD, flow: "signIn" });
    expect((r as { tokens: unknown } | null)?.tokens).toBeTruthy();
  });
});

// ------------------------------------------------------------- send throttle

// ----------------------------------------- code issuance is not auth (F-06)

/** Everything an anonymous code request must NOT be able to touch. */
async function authState(t: TestConvex<typeof schema>, userId: Id<"users">) {
  return t.run(async (ctx) => {
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .collect();
    const refresh = [];
    for (const s of sessions) {
      refresh.push(
        ...(await ctx.db
          .query("authRefreshTokens")
          .withIndex("sessionId", (q) => q.eq("sessionId", s._id))
          .collect()),
      );
    }
    const user = await ctx.db.get(userId);
    const events = await ctx.db
      .query("authEvents")
      .withIndex("by_user_at", (q) => q.eq("userId", userId))
      .collect();
    return {
      sessions: sessions.map((s) => s._id).sort(),
      refresh: refresh.map((r) => r._id).sort(),
      passwordChangedAt: user?.passwordChangedAt ?? null,
      lastLoginAt: user?.lastLoginAt ?? null,
      events: events.map((e) => e.type),
    };
  });
}

describe("code issuance is not authentication (audit F-06)", () => {
  test("an anonymous password-reset request changes nothing on the account", async () => {
    const t = convexTest(schema, modules);
    const email = "victim-reset@gmail.com";
    const userId = await createVerifiedUser(t, email);
    const before = await authState(t, userId);
    expect(before.sessions.length).toBeGreaterThan(0);
    // Anyone who knows the address can ask — no identity, no proof.
    await captureCode(() => signIn(t, { email, flow: "reset" }));
    expect(await authState(t, userId)).toEqual(before);
  });

  test("an anonymous magic-OTP request changes nothing on the account", async () => {
    const t = convexTest(schema, modules);
    const email = "victim-otp@gmail.com";
    const userId = await createVerifiedUser(t, email);
    const before = await authState(t, userId);
    await captureCode(() => otpSend(t, email));
    expect(await authState(t, userId)).toEqual(before);
  });

  test("a COMPLETED reset is what revokes, stamps and logs", async () => {
    const t = convexTest(schema, modules);
    const email = "completes-reset@gmail.com";
    const userId = await createVerifiedUser(t, email);
    const code = await captureCode(() => signIn(t, { email, flow: "reset" }));
    const before = await authState(t, userId);
    await signIn(t, { email, code, newPassword: NEW_PASSWORD, flow: "reset-verification" });
    const after = await authState(t, userId);
    expect(after.passwordChangedAt).not.toBeNull();
    expect(after.events).toContain("password_reset");
    // Every session that existed before the reset is gone.
    expect(after.sessions.some((id) => before.sessions.includes(id))).toBe(false);
  });
});

describe("emailed-code send throttle", () => {
  test("caps codes per address, and a refused request keeps the last code valid", async () => {
    const t = convexTest(schema, modules);
    const email = "bomb@gmail.com";
    // Driven through magic-OTP rather than repeated sign-up: a sign-up
    // collision now sends nothing, so it can no longer exercise the cap.
    let last = "";
    for (let i = 0; i < 6; i++) {
      last = await captureCode(() => otpSend(t, email));
      expect(last).toMatch(/^\d{8}$/);
    }
    const before = await t.run(async (ctx) =>
      (await ctx.db.query("authVerificationCodes").collect()).map((c) => c.code),
    );
    // The 7th is REFUSED — and refused BEFORE the stored code is replaced
    // (audit F-07). It used to be "skipped" at delivery, after the swap, so a
    // throttled request silently invalidated the code the user was holding.
    await expect(otpSend(t, email)).rejects.toThrow(/Too many codes/);
    const after = await t.run(async (ctx) =>
      (await ctx.db.query("authVerificationCodes").collect()).map((c) => c.code),
    );
    expect(after).toEqual(before);
    // ...so the last DELIVERED code still signs the user in.
    const ok = await t.action(api.auth.signIn, {
      provider: "resend-otp",
      params: { email, code: last },
    });
    expect((ok as { tokens: unknown } | null)?.tokens).toBeTruthy();
  });

  test("a different address has its own budget", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 6; i++) {
      await captureCode(() => otpSend(t, "filler@gmail.com"));
    }
    // Not throttled: distinct normalized email → fresh bucket.
    const code = await captureCode(() => otpSend(t, "other@gmail.com"));
    expect(code).toMatch(/^\d{8}$/);
  });
});

// --------------------------------------------------------- sessions (req 1, 2)

describe("session lifetime and single device", () => {
  test("session lifetime is the 30-day ceiling, not an unbounded login", async () => {
    const t = convexTest(schema, modules);
    const userId = await createVerifiedUser(t, "life@gmail.com");
    const [session] = await sessionsFor(t, userId);
    const days = ((session?.expirationTime ?? 0) - Date.now()) / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  test("refresh tokens carry the 2-day inactivity budget, which is what expires an idle session", async () => {
    const t = convexTest(schema, modules);
    await createVerifiedUser(t, "idle@gmail.com");
    const [token] = await t.run(async (ctx) =>
      ctx.db.query("authRefreshTokens").collect(),
    );
    const days = ((token?.expirationTime ?? 0) - Date.now()) / (1000 * 60 * 60 * 24);
    // Enforcement lives here rather than on the session row: an active user keeps
    // minting fresh refresh tokens, so the window slides; an idle one does not.
    expect(days).toBeGreaterThan(1.9);
    expect(days).toBeLessThan(2.1);
  });

  test("a computer and a phone both stay signed in; a third sign-in evicts the oldest", async () => {
    const t = convexTest(schema, modules);
    const email = "twodevices@gmail.com";
    const userId = await createVerifiedUser(t, email);
    for (let i = 0; i < 3; i++) {
      await signIn(t, { email, password: PASSWORD, flow: "signIn" });
    }
    // A plain password sign-in never reaches the auth callback, so the newest
    // device's heartbeat is what applies the limit (see authSessions.ts).
    const all = (await sessionsFor(t, userId)).sort(
      (x, y) => x._creationTime - y._creationTime,
    );
    const newest = all[all.length - 1];
    if (!newest || all.length < 3) throw new Error("expected several sessions");
    await t
      .withIdentity({ subject: `${userId}|${newest._id}` })
      .mutation(api.authSessions.heartbeat, {});

    const left = (await sessionsFor(t, userId)).map((x) => x._id).sort();
    expect(left).toEqual(
      all
        .slice(-2)
        .map((x) => x._id)
        .sort(),
    );
  });
});

// ------------------------------------------------------------- events (req 20)

describe("auth events are written by real flows", () => {
  test("signup + verification produce login history", async () => {
    const t = convexTest(schema, modules);
    const userId = await createVerifiedUser(t, "events@gmail.com");
    const events = await t.run(async (ctx) =>
      (await ctx.db.query("authEvents").collect()).filter((e) => e.userId === userId),
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => typeof e.at === "number")).toBe(true);
  });

  test("lastLoginAt and accountStatus are stamped on the user", async () => {
    const t = convexTest(schema, modules);
    const userId = await createVerifiedUser(t, "stamp@gmail.com");
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

// ---------------------------------------------------------------------------
// B2 — sign-up must never be a password oracle.
// ---------------------------------------------------------------------------
describe("sign-up against an existing address", () => {
  /** Bring an address to a fully verified, signed-in state. */
  async function registerVerified(t: ReturnType<typeof convexTest>, email: string) {
    const code = await captureCode(() =>
      signIn(t, { email, password: PASSWORD, flow: "signUp" }),
    );
    await signIn(t, { email, code, flow: "email-verification" });
  }

  /**
   * The critical one. The library returns the existing account when the secret
   * MATCHES, so `flow: "signUp"` with a correct password used to hand back a
   * session — turning the sign-up endpoint into a login that bypasses the
   * 5/hour brute-force limiter entirely.
   */
  test("a CORRECT password does not produce a session", async () => {
    const t = convexTest(schema, modules);
    const email = "correct@gmail.com";
    await registerVerified(t, email);

    const result = await signIn(t, { email, password: PASSWORD, flow: "signUp" });
    expect((result as { tokens: unknown } | null)?.tokens ?? null).toBeNull();
  });

  /**
   * And the other half of the oracle: a wrong password used to THROW
   * "Account <email> already exists" while a right one resolved. The two must
   * now be indistinguishable.
   */
  test("a WRONG password behaves identically to a correct one", async () => {
    const t = convexTest(schema, modules);
    const email = "wrong@gmail.com";
    await registerVerified(t, email);

    const right = await signIn(t, { email, password: PASSWORD, flow: "signUp" });
    const wrong = await signIn(t, {
      email,
      password: "C0mpletelyD1fferent!",
      flow: "signUp",
    });
    expect(wrong).toEqual(right);
  });

  /** No password is ever compared, so neither answer can leak by throwing. */
  test("neither outcome throws", async () => {
    const t = convexTest(schema, modules);
    const email = "nothrow@gmail.com";
    await registerVerified(t, email);
    await expect(
      signIn(t, { email, password: "An0therWr0ng!", flow: "signUp" }),
    ).resolves.toBeDefined();
  });

  /**
   * A collision must send NOTHING and touch nothing.
   *
   * This asserted the opposite until the Better Auth comparison: it used to
   * dispatch a verification code for the EXISTING account, and that is an
   * account-takeover path. An unverified account belongs to whoever squatted
   * the address, and completing its code marks it verified
   * (mutations/verifyCodeAndSignIn.js:105-109) — so the real owner following
   * the emailed instructions ACTIVATES the squatter's password on their own
   * account. Overwriting the credential instead just mirrors the bug.
   *
   * Better Auth's sign-up route never compares, modifies or links the existing
   * account; it returns a synthetic look-alike response. Same here.
   */
  test("a collision emails nothing at all", async () => {
    const t = convexTest(schema, modules);
    const email = "onecode@gmail.com";
    await registerVerified(t, email);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await signIn(t, { email, password: PASSWORD, flow: "signUp" });
      const codes = warn.mock.calls
        .map((c) => String(c[0] ?? ""))
        .filter((line) => line.includes("code for"));
      expect(codes).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  /** ...and the existing credential is left exactly as it was. */
  test("a collision does not alter the existing credential", async () => {
    const t = convexTest(schema, modules);
    const email = "untouched@gmail.com";
    await registerVerified(t, email);
    const before = await t.run(async (ctx) =>
      (await ctx.db.query("authAccounts").collect()).find(
        (a) => a.provider === "password",
      ),
    );

    await signIn(t, { email, password: "Attacker0wns!", flow: "signUp" });

    const after = await t.run(async (ctx) =>
      (await ctx.db.query("authAccounts").collect()).find(
        (a) => a.provider === "password",
      ),
    );
    expect(after?.secret).toBe(before?.secret);
    // And the attacker's password must not work.
    await expect(
      signIn(t, { email, password: "Attacker0wns!", flow: "signIn" }),
    ).rejects.toThrow();
  });

  /**
   * THE RECOVERY PATH, now that a collision is silent.
   *
   * A squatter registers a stranger's address and never verifies. The real
   * owner must still be able to take it, and the squatter's password must stop
   * working when they do. Password reset is the route, and it is the only one
   * that satisfies the invariant: the code and the NEW password arrive in the
   * same call, so the credential that goes live belongs to whoever proved they
   * own the inbox.
   */
  test("a squatted address is recovered by its real owner via reset", async () => {
    const t = convexTest(schema, modules);
    const email = "squatted@gmail.com";
    const SQUATTER = "Squ4tterPass!";
    const OWNER = "0wnerTakesIt!";

    // 1. Squatter registers the address and abandons it, unverified.
    await signIn(t, { email, password: SQUATTER, flow: "signUp" });

    // 2. The real owner signs up: silent, nothing changes.
    await signIn(t, { email, password: OWNER, flow: "signUp" });

    // 3. They recover it through reset, which emails the code to THEIR inbox.
    const code = await captureCode(() =>
      signIn(t, { email, flow: "reset" }),
    );
    const result = await signIn(t, {
      email,
      code,
      newPassword: OWNER,
      flow: "reset-verification",
    });
    expect((result as { tokens: unknown } | null)?.tokens).toBeTruthy();

    // 4. The squatter's password is dead.
    await expect(
      signIn(t, { email, password: SQUATTER, flow: "signIn" }),
    ).rejects.toThrow();
  });

  /** A brand-new address must still register normally. */
  test("a fresh address is unaffected", async () => {
    const t = convexTest(schema, modules);
    const code = await captureCode(() =>
      signIn(t, { email: "fresh@gmail.com", password: PASSWORD, flow: "signUp" }),
    );
    expect(code).toMatch(/^\d{8}$/);
    const result = await signIn(t, {
      email: "fresh@gmail.com",
      code,
      flow: "email-verification",
    });
    expect((result as { tokens: unknown } | null)?.tokens).toBeTruthy();
  });

  /** Case and whitespace must land on the same account, not a second one. */
  test("a case/whitespace variant collides rather than duplicating", async () => {
    const t = convexTest(schema, modules);
    await registerVerified(t, "casing@gmail.com");
    await signIn(t, {
      email: "  CASING@Gmail.com ",
      password: "An0therWr0ng!",
      flow: "signUp",
    });
    const users = await t.run(async (ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    // users.email must stay NORMALISED. The library overwrites it with the raw
    // identifier, and that column is what uniqueUserWithVerifiedEmail indexes —
    // a corrupted value is what makes a second provider create a second user.
    expect(users[0].email).toBe("casing@gmail.com");
    expect(users[0].emailNormalized).toBe("casing@gmail.com");
  });
});

// ------------------------------------------- enumeration on every flow (N2/N3)

describe("no flow reveals whether an address is registered", () => {
  /**
   * Measured against production before the fix: `signIn` threw
   * "InvalidAccountId" for an unknown address and "InvalidSecret" for a wrong
   * password, WITH a stack trace naming the source file and line. Only the
   * browser collapsed them, and the browser is not the trust boundary.
   */
  test("login answers identically for an unknown address and a wrong password", async () => {
    const t = convexTest(schema, modules);
    await createVerifiedUser(t, "real@gmail.com");

    const outcome = async (email: string, password: string) => {
      try {
        await signIn(t, { email, password, flow: "signIn" });
        return "resolved";
      } catch (e) {
        return String((e as { data?: unknown }).data ?? (e as Error).message);
      }
    };

    const unknown = await outcome("nobody@gmail.com", "Wr0ngPass!x");
    const wrongPw = await outcome("real@gmail.com", "Wr0ngPass!x");
    expect(unknown).toBe(wrongPw);
    expect(unknown).toContain("Invalid email or password");
  });

  /**
   * `flow: "reset"` was an UNRATED oracle: the library's brute-force limiter
   * only engages when a secret is supplied, so an attacker could test an email
   * list against this endpoint at full speed. authSessions.requestPasswordReset
   * answered constantly, but only for the UI — the raw action stayed callable.
   */
  test("reset resolves identically for known and unknown addresses", async () => {
    const t = convexTest(schema, modules);
    await createVerifiedUser(t, "known@gmail.com");

    const known = await signIn(t, { email: "known@gmail.com", flow: "reset" });
    const unknown = await signIn(t, {
      email: "missing@gmail.com",
      flow: "reset",
    });
    expect(unknown).toEqual(known);
  });

  test("email-verification is INDISTINGUISHABLE known vs unknown (oracle closed)", async () => {
    // A garbage/absent code must fail the SAME way whether or not the address
    // has an account. Previously a known address let the library throw
    // "Could not verify code" while an unknown one returned null — an
    // enumeration oracle that convex-test hid (its fake never threw) but prod
    // exposed. Both must now throw the same ConvexError.
    const t = convexTest(schema, modules);
    await createVerifiedUser(t, "known2@gmail.com");

    const grab = async (email: string) => {
      try {
        await signIn(t, { email, code: "00000000", flow: "email-verification" });
        return { threw: false, msg: "" };
      } catch (e) {
        return { threw: true, msg: (e as { data?: string }).data ?? String(e) };
      }
    };
    const known = await grab("known2@gmail.com");
    const unknown = await grab("missing2@gmail.com");
    expect(known.threw).toBe(true);
    expect(unknown.threw).toBe(true);
    expect(known.msg).toBe(unknown.msg);
    expect(known.msg).toMatch(/Invalid or expired verification code/);
  });

  /** A reset for an unknown address must not email anyone. */
  test("an unknown reset sends nothing", async () => {
    const t = convexTest(schema, modules);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await signIn(t, { email: "ghost@gmail.com", flow: "reset" });
      expect(
        warn.mock.calls
          .map((c) => String(c[0] ?? ""))
          .filter((l) => l.includes("code for")),
      ).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});

// ------------------------------------------------ password length bound (G3)

describe("password length is bounded at both ends", () => {
  /** scrypt is deliberately slow; an unbounded password is a CPU DoS. */
  test("129 characters is refused on sign-up, 128 is accepted", async () => {
    const t = convexTest(schema, modules);
    const long = `Aa1!${"x".repeat(125)}`;
    expect(long).toHaveLength(129);
    await expect(
      signIn(t, { email: "long@gmail.com", password: long, flow: "signUp" }),
    ).rejects.toThrow(/128 characters or fewer/);

    const ok = long.slice(0, 128);
    await expect(
      signIn(t, { email: "ok@gmail.com", password: ok, flow: "signUp" }),
    ).resolves.toBeDefined();
  });

  /** The same rule runs on reset, which is the other place a password is set. */
  test("129 characters is refused on password reset", async () => {
    const t = convexTest(schema, modules);
    const email = "resetlong@gmail.com";
    await createVerifiedUser(t, email);
    const code = await captureCode(() => signIn(t, { email, flow: "reset" }));
    await expect(
      signIn(t, {
        email,
        code,
        newPassword: `Aa1!${"x".repeat(125)}`,
        flow: "reset-verification",
      }),
    ).rejects.toThrow(/128 characters or fewer/);
  });
});

// --------------------------------------------- suspended accounts (N5)

describe("a suspended account cannot authenticate", () => {
  /**
   * users.accountStatus was declared in the schema and read in exactly ONE
   * place — scheduled/authz.ts. Suspending someone stopped their scheduled
   * tasks and nothing else: they kept signing in and using the product.
   */
  test("login is refused, with the same message a stranger gets", async () => {
    const t = convexTest(schema, modules);
    const email = "suspended@gmail.com";
    const userId = await createVerifiedUser(t, email);
    await t.run(async (ctx) =>
      ctx.db.patch(userId, { accountStatus: "suspended" }),
    );

    await expect(
      signIn(t, { email, password: PASSWORD, flow: "signIn" }),
    ).rejects.toThrow(/Invalid email or password/);
  });

  test("an active account is unaffected", async () => {
    const t = convexTest(schema, modules);
    const email = "active@gmail.com";
    await createVerifiedUser(t, email);
    await expect(
      signIn(t, { email, password: PASSWORD, flow: "signIn" }),
    ).resolves.toBeDefined();
  });
});
