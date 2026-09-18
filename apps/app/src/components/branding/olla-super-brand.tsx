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
 * SIZE STEPS WITH THE VIEWPORT. A fixed 15px wordmark read as an afterthought on
 * a wide monitor — the rail is a constant 272px, so the brand was the only thing
 * on screen that did not grow with the window. Both halves step at lg/xl, which
 * is the same scale the rest of the app uses, so it stays proportionate from a
 * laptop to an ultrawide without ever threatening the rail width.
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
        className={`${auth ? "" : "md:hidden"} shrink-0 ${
          markClassName || (auth ? "h-9 w-9" : "h-8 w-8")
        }`}
      />
      <span
        className={`font-brand font-extrabold tracking-[-0.01em] ${
          auth ? "" : "sr-only md:not-sr-only"
        } ${
          textClassName ||
          (auth ? "text-2xl" : "text-[19px] lg:text-[21px] xl:text-[22px]")
        }`}
      >
        OllaSuper
      </span>
    </span>
  );
}
