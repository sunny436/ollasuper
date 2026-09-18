/**
 * The product mark. Flat, monochrome, static.
 *
 * Replaces the animated WebGL orb that used to sit here (login, chat rail,
 * settings rail). That orb was a three.js canvas rendering a coloured gradient
 * sphere: the single largest decorative cost in the app — measured at 57% of the
 * main thread while idle on the login page — and a multi-hue element in a system
 * that is now one ink on one surface.
 *
 * `currentColor` throughout, so it inverts with the theme for free and a caller
 * can size it with a single className.
 */
export function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-lg bg-foreground text-background ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        className="h-[55%] w-[55%]"
      >
        <circle cx="12" cy="12" r="7" strokeWidth="2.5" />
        <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}
