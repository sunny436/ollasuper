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
// Public documents a signed-out visitor (or an app-marketplace reviewer) must be
// able to open: static, server-rendered, no Convex, nothing per-user.
const isPublicDoc = createRouteMatcher(["/privacy", "/terms", "/support", "/slack"]);
// The generated apple-touch icon (app/apple-icon.tsx).
//
// `icon.svg` needs no entry — the matcher at the foot of this file already
// excludes anything ending in an image extension. `/apple-icon` does NOT end in
// one, so without this it reaches the auth gate and a signed-out fetch — iOS
// asking for a home-screen icon — gets a 302 to /login instead of an image.
//
// It must also skip I18nMiddleware: it lives outside the [locale] segment, so a
// locale rewrite would point it at a route that does not exist.
//
// The share page's opengraph-image is deliberately NOT listed. It lives INSIDE
// [locale], so it needs the locale rewrite, and it is already public via
// isPublicShare below. Next also emits it with a content-hash suffix
// (`/opengraph-image-cap45`), so a matcher here would not catch it reliably —
// and on the day it did, it would break it.
const isBrandAsset = createRouteMatcher(["/apple-icon", "/apple-icon/(.*)"]);

/**
 * One fixed-window counter, and the two properties that matter.
 *
 * SEPARATE MAPS PER THROTTLE. There used to be a single `authHits` shared by the
 * /login-page throttle and the /api/auth throttle, and the two are keyed on
 * DIFFERENT levels of trust — one on client-supplied x-forwarded-for, the other
 * on Cloudflare's cf-connecting-ip. Sharing one map meant a caller who could
 * forge the first key could evict entries belonging to the second: 5001 requests
 * with rotating X-Forwarded-For values tripped the `.clear()` below and wiped
 * the TRUSTED counters for every IP, the attacker's own included. The per-IP
 * limit on the auth API then reset on demand.
 *
 * LRU EVICTION, NOT `.clear()`. Even correctly keyed, emptying the whole map on
 * overflow hands every caller a fresh budget at once. Dropping the oldest entry
 * bounds memory just as well and costs only the one entry it drops — and a Map
 * iterates in insertion order, so the first key is the oldest.
 */
const MAX_TRACKED = 5000;
type Hit = { start: number; count: number };

function limited(
  hits: Map<string, Hit>,
  key: string,
  windowMs: number,
  max: number,
): boolean {
  const now = Date.now();
  const e = hits.get(key);
  if (!e || now - e.start >= windowMs) {
    if (hits.size >= MAX_TRACKED) {
      const oldest = hits.keys().next();
      if (!oldest.done) hits.delete(oldest.value);
    }
    hits.set(key, { start: now, count: 1 });
    return false;
  }
  e.count += 1;
  return e.count > max;
}

// Best-effort per-IP throttle for public share access. Defense-in-depth only —
// the 192-bit unguessable token is the real guard. Module-level state is
// per-server-instance and resets on redeploy, which is fine for anti-hammering.
const SHARE_WINDOW_MS = 60_000;
const SHARE_MAX = 120;
const shareHits = new Map<string, Hit>();

// Per-IP throttle for the auth surface.
//
// The comment that used to sit here said the raw signIn action "goes straight to
// Convex and never reaches this middleware". That was WRONG, and it is why this
// throttle only ever covered GETs of /login. The browser's signIn POSTs to
// /api/auth (@convex-dev/auth/dist/nextjs/client.js:9), the matcher below does
// match that path, and convexAuthNextjsMiddleware intercepts and proxies it
// (dist/nextjs/server/index.js:58-63) BEFORE the custom handler runs — so the
// check has to happen outside that wrapper, which is what the default export
// does now.
//
// HONEST LIMIT: this is defence in depth, not a closure. NEXT_PUBLIC_CONVEX_URL
// is public (app.ollasuper.com/__cvx), so a caller can invoke auth:signIn on the
// Convex deployment directly and never touch Next — exactly what
// e2e/p-auth-oracle.js does. Convex actions get no request object, so no
// application-level limit can cover that path; only a Cloudflare rate-limiting
// rule spanning /__cvx and /api/auth can. See ROADMAP.md.
const AUTH_WINDOW_MS = 60_000;
/** Page loads. */
const AUTH_MAX = 40;
/**
 * /api/auth POSTs. Deliberately generous rather than Better Auth's 3-per-10s:
 * this one bucket carries sign-in, sign-out AND token refresh, and it is keyed
 * on an IP that a whole office or mobile carrier can share behind NAT. A limit
 * tight enough to be interesting to a stuffing attack would lock out real users,
 * and the Cloudflare rule above is the control that can afford to be strict.
 */
const AUTH_API_MAX = 60;
/** Page loads and API posts get their OWN maps — see the note on `limited`. */
const loginPageHits = new Map<string, Hit>();
const authApiHits = new Map<string, Hit>();

/**
 * The client IP, from the one header that cannot be forged here.
 *
 * This deployment sits behind a Cloudflare Tunnel, which sets cf-connecting-ip
 * itself and strips any client-supplied copy.
 *
 * NOW USED BY ALL THREE THROTTLES. The share and login throttles used to read
 * x-forwarded-for, which is client-supplied: an attacker rotated the header and
 * the limit did nothing, and — because the login throttle shared a map with the
 * auth-API throttle — those forged keys could also evict the trusted entries.
 * There is no reason to key anything here on a header the caller controls when
 * the trustworthy one is right there.
 *
 * IPv6 is bucketed to a /64 because a single subscriber is routinely handed a
 * whole /64; limiting one address alone would be evaded by using the next.
 */
function trustedIp(request: Request): string {
  const raw = request.headers.get("cf-connecting-ip")?.trim();
  if (!raw) return "anon";
  if (raw.includes(":")) return `${raw.split(":").slice(0, 4).join(":")}::/64`;
  return raw;
}

/** The proxy route the browser's signIn/signOut actually POST to. */
function isAuthApi(request: Request): boolean {
  const p = new URL(request.url).pathname;
  return p === "/api/auth" || p === "/api/auth/";
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

const authMiddleware = convexAuthNextjsMiddleware(
  async (request, { convexAuth }) => {
    // Public share pages bypass the auth gate entirely (still get the locale
    // rewrite). Access is authorized server-side by the token + expiry/revocation.
    if (isPublicShare(request) || isPublicDoc(request)) {
      if (
        limited(shareHits, trustedIp(request), SHARE_WINDOW_MS, SHARE_MAX)
      ) {
        return new Response("Too many requests", { status: 429 });
      }
      return I18nMiddleware(request);
    }

    const isSignIn = isSignInPage(request);
    if (isSignIn) {
      if (
        limited(loginPageHits, trustedIp(request), AUTH_WINDOW_MS, AUTH_MAX)
      ) {
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

/**
 * Rate-limit the auth API BEFORE the library gets the request.
 *
 * convexAuthNextjsMiddleware short-circuits /api/auth into its own proxy at the
 * top of its handler, so anything placed inside the custom handler never sees
 * auth traffic. This wrapper is the only place the check can run.
 */
export default async function middleware(
  ...args: Parameters<typeof authMiddleware>
) {
  const [request] = args;
  // Before anything else, and deliberately before the auth gate.
  if (isBrandAsset(request)) return;
  if (isAuthApi(request)) {
    if (
      limited(authApiHits, trustedIp(request), AUTH_WINDOW_MS, AUTH_API_MAX)
    ) {
      return new Response("Too many requests", { status: 429 });
    }
  }
  return authMiddleware(...args);
}

export const config = {
  matcher: [
    "/((?!_next/static|api|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",

    // all routes except static assets
    "/((?!.*\\..*|_next).*)",
    "/",
    "/(api|trpc)(.*)",
  ],
};
