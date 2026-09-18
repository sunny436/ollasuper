/**
 * Accent colour — the vocabulary, mirroring mode.ts.
 *
 * AN ACCENT IS AN ENUM, NEVER A COLOUR STRING. The only value that ever reaches
 * the DOM is one of the literals below, written to `data-accent`; every colour
 * lives in packages/ui/src/globals.css. So a stored value cannot become styling:
 * it either matches a literal or it does not, and anything that does not falls
 * back to the default. There is no path by which a user-supplied string is
 * interpolated into CSS, which is why this needs no sanitising.
 *
 * NOT `--accent`. globals.css already defines an `--accent` token: the neutral
 * hover surface behind `hover:bg-accent`. It predates this feature, is untouched
 * by it, and shares only the English word. The accent COLOUR is `data-accent`
 * plus the `--brand*` trio.
 *
 * Accent and light/dark are independent by construction — separate keys, separate
 * timestamps, separate DOM hooks — so changing one can never reset the other.
 */
export const ACCENTS = [
  { name: "blue", label: "Blue" },
  { name: "green", label: "Green" },
  { name: "yellow", label: "Yellow" },
  { name: "pink", label: "Pink" },
  { name: "orange", label: "Orange" },
  { name: "purple", label: "Purple" },
  { name: "neutral", label: "Neutral" },
] as const;

export type AccentName = (typeof ACCENTS)[number]["name"];

/** Blue, per the product spec. Also the value baked into :root, so a page that
 *  never receives the attribute still renders the default. */
export const DEFAULT_ACCENT: AccentName = "blue";

export const ACCENT_KEY = "accent";
export const ACCENT_TS_KEY = "accent_ts";

export function isAccent(v: unknown): v is AccentName {
  return (
    typeof v === "string" && ACCENTS.some((a) => a.name === v)
  );
}

/** The cached choice, or null when absent OR corrupt — the caller decides. */
export function readCachedAccent(): AccentName | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(ACCENT_KEY);
    return isAccent(v) ? v : null;
  } catch {
    return null; // private mode / blocked storage
  }
}

export function readCachedAccentAt(): number {
  if (typeof window === "undefined") return 0;
  try {
    const n = Number(window.localStorage.getItem(ACCENT_TS_KEY));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function writeCachedAccent(
  accent: AccentName,
  at: number = Date.now(),
): void {
  try {
    window.localStorage.setItem(ACCENT_KEY, accent);
    window.localStorage.setItem(ACCENT_TS_KEY, String(at));
  } catch {
    // Non-fatal: the accent still applies for this session.
  }
}

export function applyAccent(accent: AccentName): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.accent = accent;
}

/** Reads the live attribute — the DOM is the truth, as with the `dark` class. */
export function currentAccent(): AccentName {
  if (typeof document === "undefined") return DEFAULT_ACCENT;
  const v = document.documentElement.dataset.accent;
  return isAccent(v) ? v : DEFAULT_ACCENT;
}

/**
 * account preference > localStorage cache > default.
 *
 * `undefined` means the query is still in flight and must NOT be read as "no
 * preference" — that is what flips an accent on a slow connection.
 */
export function resolveAccent(account: AccentName | null | undefined): AccentName {
  if (isAccent(account)) return account;
  return readCachedAccent() ?? DEFAULT_ACCENT;
}
