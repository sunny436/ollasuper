/**
 * The OllaSuper mark. One path, no raster, no gradient, no filter.
 *
 * GEOMETRY IS GENERATED, NOT DRAWN BY HAND. The mark has 3-fold rotational
 * symmetry, so it is a hexagon with three identical channels cut out of it at
 * 0/120/240 degrees, punched with `fill-rule="evenodd"`. Building it that way is
 * not a shortcut: it is what makes the three negative-space channels provably
 * identical instead of hand-matched three times, and it is why the mark stays
 * balanced at 16px where hand-nudged coordinates would not.
 *
 * Every coordinate sits on the hexagon's own isometric grid — pointy-top,
 * centre (50,50), vertices (50,0) (93.3,25) (93.3,75) (50,100) (6.7,75) (6.7,25)
 * — so every edge lands on a 30/60/90 degree line and stays crisp when rasterised
 * to a favicon.
 *
 * The channels deliberately extend past the hexagon (negative coordinates, and
 * values over 100). They have to: a channel that stopped at the boundary would
 * leave a hairline of ink welding two arms together. The outermost <svg> clips to
 * its viewBox by default, so the overflow never paints.
 *
 * `currentColor`, so ONE file serves both themes — black on light, white on dark,
 * inherited from whatever `text-*` the caller sits in. There is no second asset
 * and no `dark:` variant on the artwork.
 *
 * The path is exported because `app/icon.svg` needs the same geometry in a file
 * that cannot import React. `branding.test.ts` asserts the two are identical, so
 * "one source of truth" is enforced rather than promised.
 */
export const OLLA_MARK_VIEWBOX = "0 0 100 100";

export const OLLA_MARK_PATH =
  "M50 0L93.3 25L93.3 75L50 100L6.7 75L6.7 25Z" +
  "M51.5 -14L51.5 41.18L99.28 68.76L104.78 59.24L62.5 34.82L62.5 -14Z" +
  "M104.68 83.3L56.89 55.71L9.11 83.3L14.61 92.83L56.89 68.41L99.18 92.83Z" +
  "M-6.18 80.7L41.61 53.11L41.61 -2.06L30.61 -2.06L30.61 46.76L-11.68 71.17Z";

/**
 * Decorative by default: every place this renders, "OllaSuper" is already present
 * as real text (visible, or `sr-only` in the mark-only mobile view). A label here
 * would make screen readers announce the brand twice.
 */
export function OllaSuperLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox={OLLA_MARK_VIEWBOX}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path fillRule="evenodd" d={OLLA_MARK_PATH} />
    </svg>
  );
}
