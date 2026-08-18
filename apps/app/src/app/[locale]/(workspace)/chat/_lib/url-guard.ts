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

/**
 * Strip ASCII control characters and surrounding whitespace BEFORE parsing,
 * and return the stripped string rather than the caller's original.
 *
 * This is the whole trick, and getting it wrong is a live XSS. Consider a
 * NUL byte inside the scheme: `new URL("javascript\u0000:alert(1)", base)`
 * does NOT parse as javascript: — the NUL makes the scheme invalid, so URL
 * treats the whole thing as a relative path and resolves it against the https
 * base. A guard that checks the PARSED protocol but returns the ORIGINAL
 * string therefore emits href="javascript\u0000:alert(1)", which a browser
 * may strip back to javascript: when it parses the attribute. Same class of
 * bypass for \n, \r and \t inside the scheme.
 *
 * Normalising first means the string we validate is the string we return.
 */
function normalise(url: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return url.replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

export function safeUrl(url: string): string {
  if (!url) return "";
  const cleaned = normalise(url);
  if (!cleaned) return "";
  try {
    // The base makes relative URLs parse; they resolve to https and are safe.
    const u = new URL(cleaned, "https://relative.invalid");
    return SAFE_PROTOCOLS.has(u.protocol) ? cleaned : "";
  } catch {
    return "";
  }
}

/**
 * Images are stricter than links: https only.
 *
 * data: is refused even for images, because data:image/svg+xml can carry
 * script and an <img> is not a safe container for arbitrary SVG.
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
