/**
 * URL allowlist for anything rendered from model output.
 *
 * MOVED HERE from apps/app chat/_lib/url-guard.ts, which now re-exports it.
 * Two renderers need this guard — the chat markdown component and the report
 * EMAIL renderer — and they run in different packages. `apps/app` depends on
 * `@v1/backend`, so this direction works and the app's import sites are
 * unchanged; the reverse would not. One implementation of a security control
 * beats two that can drift.
 *
 * It also gains the test coverage here that it never had in the app.
 *
 * `safeImageUrl` deliberately stays in the app: it reads
 * NEXT_PUBLIC_CONVEX_URL and is specific to the browser bundle.
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
 * The character class is written as ESCAPES, never literal control bytes:
 * those are invisible in a diff and easy to mangle in transit.
 */
export function normalise(url: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return url.replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

/** The URL to emit, or "" when it is not safe to emit one at all. */
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
