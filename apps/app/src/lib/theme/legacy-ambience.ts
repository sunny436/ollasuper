/**
 * The ONLY file that knows the account preference is stored as a number.
 *
 * `chatSettings.ambience` held a 0-100 intensity for the removed colour-ramp
 * engine. Reusing it avoids a schema change and a migration; keeping that fact
 * behind this adapter avoids 0/100 leaking back into components.
 *
 * THE MAPPING IS EVIDENCE-BASED, not a guess. Audited against production
 * (`convex data chatSettings`, 97 rows):
 *
 *     null  x25 | 0 x9 | 7 x1 | 15 x53 | 47 x1 | 53 x1 | 85 x2 | 100 x5
 *
 * 15 is the old engine's DEFAULT_INTENSITY, and the old sync wrote it to the
 * server on first load for anyone who never touched the slider. So 53 of 97
 * rows — 55% — are "never chose", not "chose a light theme". A plain
 * `0-49 -> light` rule would convert every one of them into an EXPLICIT light
 * preference and override their OS dark setting. They fall through to the OS
 * instead.
 *
 * Someone who deliberately dragged the old slider to exactly 15 is
 * indistinguishable from that default; they also get OS-follow, which respects
 * their system setting rather than pinning them to light. That is the safer of
 * the two possible errors.
 */

import type { ThemeMode } from "./mode";

/** The removed engine's default. Written automatically, so it means nothing. */
const LEGACY_DEFAULT = 15;
/** Above this the old ramp was visually dark. */
const DARK_AT = 50;

export const LIGHT_VALUE = 0;
export const DARK_VALUE = 100;

/**
 * A stored value as a preference: a mode, or null for "no explicit preference".
 * `undefined` in means undefined out — the caller must keep "still loading"
 * distinct from "nothing stored".
 */
export function modeFromLegacy(
  value: number | null | undefined,
): ThemeMode | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isFinite(value)) return null;
  if (value === LEGACY_DEFAULT) return null;
  return value >= DARK_AT ? "dark" : "light";
}

/** What to persist for a mode the user actually chose. */
export function legacyFromMode(mode: ThemeMode): number {
  return mode === "dark" ? DARK_VALUE : LIGHT_VALUE;
}
