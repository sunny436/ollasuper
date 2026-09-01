/**
 * The one place a scheduled report's mail subject is computed.
 *
 * Shared because it is now needed in TWO runtimes: `email.ts` (`"use node"`)
 * builds the subject when sending, and `scheduled/delivery.ts` (default Convex
 * runtime) rebuilds it when reconciling a crashed send against the provider's
 * outbound log. Two copies of this would drift, and a drifted subject means
 * reconciliation silently stops matching — the worst kind of failure, because
 * it looks like "no message found" and would re-send the report.
 */

const MAX_SUBJECT = 120;

/**
 * The task title is user-authored and lands in a mail header. Strip CR/LF and
 * control characters (header injection on the SMTP path, and cheap insurance on
 * the JSON one) and clamp the length.
 */
export function safeSubject(title: string): string {
  const clean = title
    // \p{Cc} is the Unicode control-character category: no literal control
    // bytes in the source, which are invisible in a diff and easy to mangle.
    .replace(/\p{Cc}+/gu, " ")
    .trim();
  return (clean || "Scheduled task").slice(0, MAX_SUBJECT);
}

/** The exact subject a report email carries, given its title and outcome. */
export function reportSubject(title: string, outcome: string): string {
  return safeSubject(
    outcome === "succeeded" ? title : `${title} — ${outcome}`,
  );
}
