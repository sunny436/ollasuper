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
 */

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function safeUrl(url: string): string {
  if (!url) return "";
  try {
    // The base makes relative URLs parse; they resolve to https and are safe.
    const u = new URL(url, "https://relative.invalid");
    return SAFE_PROTOCOLS.has(u.protocol) ? url : "";
  } catch {
    return "";
  }
}

/**
 * Images are stricter than links: only https, plus the Convex storage origin
 * that serves our own attachments.
 */
export function safeImageUrl(url: string): string {
  if (!url) return "";
  try {
    const convex = process.env.NEXT_PUBLIC_CONVEX_URL;
    const u = new URL(url, convex || "https://relative.invalid");
    if (u.protocol === "https:") return url;
    if (convex && url.startsWith(convex)) return url;
    return "";
  } catch {
    return "";
  }
}
