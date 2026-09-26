import { vi } from "vitest";

/**
 * TEST-ONLY: give the conventional placeholder test identity a REAL
 * authSessions row.
 *
 * Every authenticated helper now requires the JWT's session to exist
 * (accountState.activeUserId — audit F-05: a revoked session must stop working
 * immediately, not at token expiry). Most test files build identities as
 * `${userId}|sess_<anything>` or as a bare `${userId}` — a session id that was
 * never a row, or none at all — so without this each of them would see
 * "signed out".
 *
 * The row is created ONCE per (test instance, user) and never re-created: a test
 * that revokes the session (sign-out, displacement, deletion) keeps seeing it
 * revoked, exactly as production would. Any other subject — including the real
 * session ids the heartbeat tests build — passes through untouched, and so does
 * a placeholder whose user part is not a real users id.
 */
// A subject with NO session part, or a `sess_*` placeholder session id.
const PLACEHOLDER = /^([^|]+)(?:\|sess_[^|]*)?$/;
const FAR_FUTURE_MS = 100 * 365 * 24 * 60 * 60 * 1000;

vi.mock("convex-test", async (importOriginal) => {
  const mod = await importOriginal<typeof import("convex-test")>();

  const convexTest = ((...args: Parameters<typeof mod.convexTest>) => {
    const t = mod.convexTest(...args);
    const sessions = new Map<string, Promise<string | null>>();

    // null = the user part is not a real users id (a deliberately bogus
    // identity) — that identity is then left exactly as the test wrote it.
    const sessionFor = (userId: string): Promise<string | null> => {
      let sid = sessions.get(userId);
      if (!sid) {
        sid = t
          .run(async (ctx) =>
            ctx.db.normalizeId("users", userId)
              ? ctx.db.insert("authSessions", {
                  // biome-ignore lint/suspicious/noExplicitAny: test ids are strings
                  userId: userId as any,
                  expirationTime: Date.now() + FAR_FUTURE_MS,
                })
              : null,
          )
          .catch(() => null);
        sessions.set(userId, sid);
      }
      return sid;
    };

    return {
      ...t,
      withIdentity(identity: Parameters<typeof t.withIdentity>[0]) {
        const match = PLACEHOLDER.exec(identity.subject ?? "");
        if (!match) return t.withIdentity(identity);
        const userId = match[1] as string;
        const bound = async () => {
          const sid = await sessionFor(userId);
          return sid
            ? t.withIdentity({ ...identity, subject: `${userId}|${sid}` })
            : t.withIdentity(identity);
        };
        // Every method of the identity-bound accessor is async, so resolve the
        // session first and then delegate. `then` stays undefined so the proxy
        // is never mistaken for a promise.
        return new Proxy({} as ReturnType<typeof t.withIdentity>, {
          get(_target, prop) {
            if (prop === "then" || typeof prop === "symbol") return undefined;
            return async (...rest: unknown[]) => {
              const accessor = (await bound()) as unknown as Record<
                string,
                (...a: unknown[]) => unknown
              >;
              const method = accessor[prop];
              if (typeof method !== "function") {
                throw new Error(`convex-test accessor has no method ${prop}`);
              }
              return method(...rest);
            };
          },
        });
      },
    };
  }) as typeof mod.convexTest;

  return { ...mod, convexTest };
});
