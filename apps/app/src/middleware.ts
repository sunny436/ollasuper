import { api } from "@v1/backend/convex/_generated/api";
import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";
import { fetchQuery } from "convex/nextjs";
import { createI18nMiddleware } from "next-international/middleware";

const I18nMiddleware = createI18nMiddleware({
  locales: ["en", "fr", "es"],
  defaultLocale: "en",
  urlMappingStrategy: "rewrite",
});

const isSignInPage = createRouteMatcher(["/login"]);
// Public shared-conversation pages — read-only, token-gated, no auth.
const isPublicShare = createRouteMatcher(["/share", "/share/(.*)"]);

// Best-effort per-IP throttle for public share access. Defense-in-depth only —
// the 192-bit unguessable token is the real guard. Module-level state is
// per-server-instance and resets on redeploy, which is fine for anti-hammering.
const SHARE_WINDOW_MS = 60_000;
const SHARE_MAX = 120;
const shareHits = new Map<string, { start: number; count: number }>();
function shareRateLimited(ip: string): boolean {
  const now = Date.now();
  const e = shareHits.get(ip);
  if (!e || now - e.start >= SHARE_WINDOW_MS) {
    if (shareHits.size > 5000) shareHits.clear();
    shareHits.set(ip, { start: now, count: 1 });
    return false;
  }
  e.count += 1;
  return e.count > SHARE_MAX;
}

// Best-effort per-IP throttle for the auth surface (the /login route). The real
// credential/attempt limiting is server-side on Convex (per-account 5/hr +
// per-email send throttle); the raw signIn action goes straight to Convex and
// never reaches this middleware, so this layer bounds automated hammering of the
// login page from a single IP. In-memory + per-instance, like shareRateLimited.
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX = 40;
const authHits = new Map<string, { start: number; count: number }>();
function authRateLimited(ip: string): boolean {
  const now = Date.now();
  const e = authHits.get(ip);
  if (!e || now - e.start >= AUTH_WINDOW_MS) {
    if (authHits.size > 5000) authHits.clear();
    authHits.set(ip, { start: now, count: 1 });
    return false;
  }
  e.count += 1;
  return e.count > AUTH_MAX;
}

/**
 * Where SERVER-side Convex calls go.
 *
 * NEXT_PUBLIC_CONVEX_URL is the PUBLIC path form (app.ollasuper.com/__cvx).
 * That is right for the browser and wrong for us: this middleware runs on the
 * same VM as the backend, so using it sends every request out to Cloudflare and
 * back down the tunnel to reach a process on 127.0.0.1. Measured on production
 * at ~49ms per request — and it runs on every document load AND every RSC
 * navigation, so it is paid again on each client-side route change.
 *
 * Falls back to the public URL, so local dev, CI and any non-VM deployment
 * behave exactly as before without setting anything.
 */
const SERVER_CONVEX_URL =
  process.env.CONVEX_SERVER_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;

/**
 * Same check as `convexAuth.isAuthenticated()`, over the internal URL.
 *
 * The library cannot be pointed at it: @convex-dev/auth 0.0.80 calls
 * `fetchQuery("auth:isAuthenticated", {}, { token })` with no `url`
 * (nextjs/server/index.js:156), so it always resolves
 * NEXT_PUBLIC_CONVEX_URL — and its `convexUrl` option only reaches the
 * /api/auth proxy, not this call. Same token, same function, same
 * catch-and-return-false semantics; only the network path differs.
 */
async function isAuthenticated(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    return await fetchQuery(
      api.auth.isAuthenticated,
      {},
      { token, url: SERVER_CONVEX_URL },
    );
  } catch (e) {
    // Fail closed, but not silently. The library's isAuthenticated logged the
    // cause here; a bare `catch {}` turned a misconfigured/unreachable
    // SERVER_CONVEX_URL into an undiagnosable "everyone is bounced to /login".
    console.error("[middleware] isAuthenticated check failed:", e);
    return false;
  }
}

export default convexAuthNextjsMiddleware(
  async (request, { convexAuth }) => {
    // Public share pages bypass the auth gate entirely (still get the locale
    // rewrite). Access is authorized server-side by the token + expiry/revocation.
    if (isPublicShare(request)) {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon";
      if (shareRateLimited(ip)) {
        return new Response("Too many requests", { status: 429 });
      }
      return I18nMiddleware(request);
    }

    const isSignIn = isSignInPage(request);
    if (isSignIn) {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon";
      if (authRateLimited(ip)) {
        return new Response("Too many requests", { status: 429 });
      }
    }

    const authed = await isAuthenticated(await convexAuth.getToken());

    // Redirect targets are deliberately unchanged.
    //
    // Sending an authenticated /login straight to /chat looks like an obvious
    // hop to save, and it breaks the post-login navigation: after signIn the
    // client issues an RSC refresh of /login, and the App Router FOLLOWS a
    // middleware redirect for data but does not commit the URL. What actually
    // moves the user today is the server-side redirect("/chat") inside
    // (dashboard)/page.tsx, which emits an RSC redirect the router does act on.
    // Measured: with /login -> /chat here, the browser fetched /chat and then
    // sat on /login indefinitely. The post-login delay is fixed properly in
    // auth-panel.tsx instead, by navigating explicitly.
    if (isSignIn && authed) return nextjsMiddlewareRedirect(request, "/");
    if (!isSignIn && !authed) return nextjsMiddlewareRedirect(request, "/login");

    return I18nMiddleware(request);
  },
  // Routes the /api/auth sign-in/sign-out proxy through the internal URL too.
  // (Token refresh and OAuth code-exchange ignore this option and stay on the
  // public URL — the library passes no `url` for those.)
  { convexUrl: SERVER_CONVEX_URL },
);

export const config = {
  matcher: [
    "/((?!_next/static|api|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",

    // all routes except static assets
    "/((?!.*\\..*|_next).*)",
    "/",
    "/(api|trpc)(.*)",
  ],
};
