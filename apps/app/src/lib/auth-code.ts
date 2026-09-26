import type { NextRequest } from "next/server";

/**
 * Is there an outstanding sign-in for this browser to complete? (audit F-14)
 *
 * @convex-dev/auth's middleware, left to its default, treats ANY HTML GET that
 * carries a `code` parameter as an OAuth return — and when that exchange fails
 * it CLEARS the auth cookies. A signed-in user who followed an unsolicited link
 * such as /chat?code=x was therefore logged out.
 *
 * The OAuth start (the /api/auth proxy) sets the verifier cookie, and every
 * code exchange — success or failure — clears it. So its presence means exactly
 * "this browser initiated a sign-in that has not finished". No other flow here
 * sends a code in a URL: emailed codes are typed, never linked. The redirect
 * path is not a useful gate — an attacker picks the path of their own link —
 * the verifier binding is. Cookie name is `__Host-`-prefixed on HTTPS and bare
 * on localhost, hence the suffix match.
 */
export function shouldHandleAuthCode(
  request: Pick<NextRequest, "cookies">,
): boolean {
  return request.cookies
    .getAll()
    .some(
      (c) => c.name.endsWith("__convexAuthOAuthVerifier") && c.value !== "",
    );
}
