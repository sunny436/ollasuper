import { OllaSuperLogo } from "./olla-super-logo";

/**
 * The OllaSuper lockup. The ONE brand component — auth, chat rail, settings rail
 * and the files shell all render this, so the brand cannot drift between them.
 *
 * TWO VARIANTS, ONE DOM TEXT NODE.
 *
 *   auth — mark AND wordmark at every size. The sign-in page is the first thing
 *          anyone sees and it is not space-constrained.
 *   app  — mark below `md`, wordmark from `md` up.
 *
 * The app swap is PURE CSS. No `window.innerWidth`, no `useEffect`, no media-query
 * hook: a JS swap renders the wrong half on the server, flashes on hydration, and
 * cannot be right during the first paint. `md` (768px) is not a new breakpoint —
 * it is the same boundary the app already uses everywhere else to decide whether
 * the conversation rail is docked or a drawer.
 *
 * ACCESSIBILITY. The wordmark is `sr-only md:not-sr-only`, not `hidden md:block`.
 * That is the whole trick: below `md` the text is visually gone but still in the
 * accessibility tree, so the mark-only view keeps its name from the SAME text node
 * the desktop view shows. The mark is `aria-hidden`. So the brand is announced
 * exactly once at every size — no "OllaSuper OllaSuper", and no second label to
 * keep in sync.
 */
export function OllaSuperBrand({
  variant = "app",
  className = "",
  markClassName = "",
  textClassName = "",
}: {
  variant?: "auth" | "app";
  className?: string;
  /** Sizing for the mark. Keep it square — the mark must never be stretched. */
  markClassName?: string;
  /** Type scale for the wordmark. */
  textClassName?: string;
}) {
  const auth = variant === "auth";
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <OllaSuperLogo
        className={`${auth ? "" : "md:hidden"} shrink-0 ${markClassName || (auth ? "h-9 w-9" : "h-7 w-7")}`}
      />
      <span
        className={`font-brand font-extrabold tracking-[-0.01em] ${
          auth ? "" : "sr-only md:not-sr-only"
        } ${textClassName || (auth ? "text-2xl" : "text-[15px]")}`}
      >
        OllaSuper
      </span>
    </span>
  );
}
