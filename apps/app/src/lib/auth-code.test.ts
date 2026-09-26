import { describe, expect, test } from "bun:test";
import { shouldHandleAuthCode } from "./auth-code";

/** The slice of NextRequest the predicate reads. */
const request = (cookies: Record<string, string>) => ({
  cookies: {
    getAll: () => Object.entries(cookies).map(([name, value]) => ({ name, value })),
  },
});

describe("shouldHandleAuthCode (audit F-14)", () => {
  test("an unsolicited ?code= is NOT exchanged for a signed-in user", () => {
    // Signed in, no sign-in in progress: the library must leave this alone —
    // a failed exchange would clear the auth cookies (a forced logout).
    expect(
      shouldHandleAuthCode(
        request({
          "__Host-__convexAuthJWT": "jwt",
          "__Host-__convexAuthRefreshToken": "rt",
        }) as never,
      ),
    ).toBe(false);
    expect(shouldHandleAuthCode(request({}) as never)).toBe(false);
  });

  test("a sign-in this browser started IS completed (HTTPS and localhost names)", () => {
    expect(
      shouldHandleAuthCode(
        request({ "__Host-__convexAuthOAuthVerifier": "v" }) as never,
      ),
    ).toBe(true);
    expect(
      shouldHandleAuthCode(request({ __convexAuthOAuthVerifier: "v" }) as never),
    ).toBe(true);
  });

  test("an emptied verifier cookie is not an outstanding sign-in", () => {
    expect(
      shouldHandleAuthCode(
        request({ "__Host-__convexAuthOAuthVerifier": "" }) as never,
      ),
    ).toBe(false);
  });
});
