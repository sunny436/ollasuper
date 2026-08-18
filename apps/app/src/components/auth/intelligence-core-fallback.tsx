const GRADIENT =
  "bg-[radial-gradient(circle_at_32%_28%,#06B6D4_0%,#7C3AED_45%,#EC4899_78%,#FFBF33_100%)] opacity-90";

/**
 * Static stand-in for the WebGL orb.
 *
 * Rendered in three situations, all of which must look intentional rather than
 * broken: during SSR (the real orb is `ssr: false`), while the three.js chunk is
 * still downloading, and permanently for anyone with `prefers-reduced-motion`.
 *
 * Pure CSS, so it costs nothing and cannot fail.
 */
export function IntelligenceCoreFallback({
  className,
}: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      // Shape follows the caller so the placeholder occupies exactly the
      // silhouette the real orb will, and the swap is invisible.
      className={`h-full w-full ${className ?? "rounded-full"} ${GRADIENT}`}
    />
  );
}
