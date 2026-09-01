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
 * Images are stricter than links: https only.
 *
 * data: is refused even for images, because data:image/svg+xml can carry
 * script and an <img> is not a safe container for arbitrary SVG.
 *
 * Stays in the app: it resolves against NEXT_PUBLIC_CONVEX_URL, which only
 * exists in the browser bundle.
 */
export function safeImageUrl(url: string): string {
  if (!url) return "";
  const cleaned = normalise(url);
  if (!cleaned) return "";
  try {
    const convex = process.env.NEXT_PUBLIC_CONVEX_URL;
    const u = new URL(cleaned, convex || "https://relative.invalid");
    if (u.protocol === "https:") return cleaned;
    // The self-hosted Convex storage origin is http in some deployments.
    if (convex && cleaned.startsWith(convex)) return cleaned;
    return "";
  } catch {
    return "";
  }
}
