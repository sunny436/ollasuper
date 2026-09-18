/**
 * The theme, as the rest of the app is allowed to see it.
 *
 * ONE VOCABULARY. Everything above this file speaks `ThemeMode` — "light" or
 * "dark". The legacy numeric representation (`chatSettings.ambience`, a 0-100
 * intensity from the removed colour-ramp engine) is an implementation detail of
 * `legacy-ambience.ts` and appears nowhere else. Spreading 0/100 through
 * components is how the old engine ended up entangled with twelve files.
 *
 * PRECEDENCE, and it is deliberate:
 *
 *     explicit account preference  >  localStorage cache  >  OS  >  light
 *
 * localStorage is a CACHE — it exists so the pre-paint script can stamp the
 * right class with no network — never an independent source of truth. A newer
 * account value therefore wins over a stale local one, which is what stops a
 * second device from silently reverting a choice made on the first.
 */

export type ThemeMode = "light" | "dark";

/** localStorage key. Matches what the pre-paint script reads. */
export const THEME_KEY = "theme";
/** Written beside the value so a newer ACCOUNT write can be recognised. */
export const THEME_TS_KEY = "theme_ts";

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === "light" || v === "dark";
}

/** The OS preference, or "light" when it cannot be read (SSR, old browser). */
export function systemMode(): ThemeMode {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** The cached choice, or null when absent OR corrupt — never a thrown error. */
export function readCachedMode(): ThemeMode | null {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return isThemeMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function readCachedAt(): number {
  try {
    const n = Number(localStorage.getItem(THEME_TS_KEY));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function writeCachedMode(mode: ThemeMode, at: number = Date.now()): void {
  try {
    localStorage.setItem(THEME_KEY, mode);
    localStorage.setItem(THEME_TS_KEY, String(at));
  } catch {
    // Private mode / storage disabled: the app still works, it just cannot
    // remember. Never fail a render over a preference.
  }
}

/** Paint it. The single place the `.dark` class is written after hydration. */
export function applyMode(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", mode === "dark");
  document.documentElement.dataset.theme = mode;
}

/** What the page is showing RIGHT NOW — the class the script or provider wrote. */
export function currentMode(): ThemeMode {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * The startup decision, given what the account holds.
 *
 * `account` is undefined while the query is in flight and null when the user has
 * no explicit preference — the two are NOT the same, and treating "still
 * loading" as "no preference" is what makes a theme flip on a slow connection.
 */
export function resolveMode(account: ThemeMode | null | undefined): ThemeMode {
  if (account) return account;
  return readCachedMode() ?? systemMode();
}
