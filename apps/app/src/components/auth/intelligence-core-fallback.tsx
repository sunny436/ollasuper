/**
 * Static stand-in for the WebGL orb.
 *
 * Rendered in three situations, all of which must look intentional rather than
 * broken: during SSR (the real orb is `ssr: false`), while the three.js chunk is
 * still downloading, and permanently for anyone with `prefers-reduced-motion`.
 *
 * Pure CSS, so it costs nothing and cannot fail.
 */
export function IntelligenceCoreFallback() {
  return (
    <div
      aria-hidden="true"
      className="h-full w-full rounded-full bg-[radial-gradient(circle_at_30%_25%,#5AC8FA_0%,#007AFF_45%,#5856D6_75%,#AF52DE_100%)]"
    />
  );
}
