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
    const authed = await isAuthenticated(await convexAuth.getToken());
    const isSignIn = isSignInPage(request);

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
