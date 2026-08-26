/**
 * Ambience palette — the colour ramps that drive the whole app.
 *
 * Two kinds of token, and the split is load-bearing for legibility:
 *
 *  SURFACES / fills interpolate continuously through 4 stops
 *  [day, amber, dusk, night] (dusk = a genuine deep warm MID, ~L30, not near-black:
 *  this eases the amber->night darkening into a gradual curve instead of a cliff, so
 *  dragging the slider through the top half reads as a smooth dusk rather than a
 *  sudden washout/jump — see the velocity note on the dusk stops below). day/night are
 *  VERBATIM the current light/.dark literals in globals.css so intensity 0/100 match
 *  the var() fallbacks.
 *
 *  TEXT / on-surface tokens NEVER lerp through grey (that is what washes out
 *  mid-transition). Each has two inks — `onLight` (interpolated day->amber, dark)
 *  and `onDark` (night, light) — and a paired `surface`; interpolate.ts outputs
 *  whichever ink has the higher contrast against that surface at the current
 *  intensity, so text is always the max-contrast choice.
 *
 * `primary` is a TEXT token (paired with background): `text-primary/*` is the
 * dominant body text in chat; its only fills are translucent (bg-primary/10).
 * `brand-ink` is brand-hued text: its inks are dark-brand / light-brand shades so
 * it stays branded AND legible. brand-foreground/*-foreground pair with their fill.
 */

export type Ramp = readonly string[];
export type TextSpec = {
  onLight: Ramp; // [day, amber] dark inks, interpolated over the light range
  onDark: string; // night, light ink
  surface: string; // paired surface token (same scope)
};

export const AMBIENCE_KEY = "ambience";
export const DEFAULT_INTENSITY = 15;

/** Amber is stop index 1 of 4 → peaks at t = 0.5 (non-uniform stops). onLight inks interpolate over
 *  [0, AMBER_T] then hold. */
export const AMBER_T = 0.5;

/** `.dark` toggle off the interpolated background's WCAG relative luminance, with
 *  a hysteresis dead-band (values are relative luminance 0..1). Set at the text
 *  contrast-crossover (~0.22) so `dark:` utilities + Shiki flip together with the
 *  contrast-picked text — one clean light→night moment. */
export const DARK_ON_LUM = 0.22;
export const DARK_OFF_LUM = 0.25;

// ── Surfaces (4-stop) ────────────────────────────────────────────────────────
// Dusk (stop index 2) is a genuine deep warm MID (~L30), not near-black. The
// amber(0.5)->night(1) darkening used to plunge amber(L~97)->dusk(L~14) across the
// 50-75 range — a velocity CLIFF (peak ~4.2 dL*/step) that reads as a sudden
// mid-slider washout/jump. Lifting every neutral dusk stop by a uniform ~+18 L (hue,
// saturation and elevation ORDER preserved) spreads the darkening evenly across the
// top half (peak ~2.9), so the settle points stay crisp and only brief transients dim.
// Non-neutral accents (destructive/brand/ring) are unchanged — they are not part of
// the light<->dark surface field. day/night endpoints are untouched.
export const ROOT_SURFACE: Record<string, Ramp> = {
  background: ["0 0% 100%", "38 60% 96%", "25 35% 32%", "0 0% 0%"],
  card: ["0 0% 100%", "40 55% 98%", "26 34% 34%", "0 0% 3%"],
  popover: ["0 0% 100%", "40 55% 98%", "26 32% 36%", "0 0% 3%"],
  secondary: ["210 40% 96.1%", "38 45% 90%", "25 25% 38%", "0 0% 10%"],
  muted: ["210 40% 96.1%", "38 45% 90%", "25 25% 38%", "0 0% 10%"],
  accent: ["210 40% 96.1%", "38 40% 88%", "25 24% 42%", "0 0% 15%"],
  border: ["214.3 31.8% 91.4%", "36 40% 82%", "25 20% 46%", "0 0% 20%"],
  input: ["214.3 31.8% 91.4%", "36 40% 82%", "25 20% 46%", "0 0% 20%"],
  destructive: ["0 84.2% 60.2%", "8 75% 50%", "4 68% 42%", "0 100% 30%"],
  brand: ["224 76% 50%", "28 80% 30%", "215 70% 46%", "204 94% 62%"],
  ring: ["222.2 84% 4.9%", "35 85% 44%", "30 70% 40%", "0 0% 80%"],
};

export const WS_SURFACE: Record<string, Ramp> = {
  background: ["220 43% 98%", "40 55% 97.5%", "25 28% 30%", "228 27% 4%"],
  card: ["0 0% 100%", "44 60% 99%", "26 30% 33%", "230 30% 7%"],
  popover: ["0 0% 100%", "44 60% 99%", "26 28% 36%", "231 28% 10%"],
  secondary: ["220 33% 96%", "40 45% 92%", "25 22% 36%", "230 26% 9%"],
  muted: ["220 33% 96%", "40 45% 92%", "25 22% 36%", "230 26% 9%"],
  accent: ["220 33% 94%", "38 42% 90%", "25 22% 40%", "228 25% 14%"],
  border: ["220 25% 90%", "36 38% 84%", "25 18% 44%", "225 20% 17%"],
  input: ["220 25% 90%", "36 38% 84%", "25 18% 44%", "225 20% 17%"],
};

// ── Text / on-surface (contrast-picked, never lerp through grey) ──────────────
const DARK_INK: Ramp = ["222.2 84% 4.9%", "25 40% 15%"];
const DARK_INK_SOFT: Ramp = ["222.2 47.4% 11.2%", "25 45% 18%"];
const LIGHT_INK = "0 0% 100%";

export const ROOT_TEXT: Record<string, TextSpec> = {
  foreground: { onLight: DARK_INK, onDark: LIGHT_INK, surface: "background" },
  primary: { onLight: DARK_INK_SOFT, onDark: LIGHT_INK, surface: "background" },
  "muted-foreground": {
    onLight: ["215.4 16.3% 46.9%", "28 28% 34%"],
    onDark: "0 0% 84%",
    surface: "background",
  },
  "card-foreground": { onLight: DARK_INK, onDark: LIGHT_INK, surface: "card" },
  "popover-foreground": { onLight: DARK_INK, onDark: LIGHT_INK, surface: "popover" },
  "secondary-foreground": {
    onLight: DARK_INK_SOFT,
    onDark: LIGHT_INK,
    surface: "secondary",
  },
  "accent-foreground": {
    onLight: DARK_INK_SOFT,
    onDark: LIGHT_INK,
    surface: "accent",
  },
  // Text on the primary FILL (which is itself contrast-picked, so its ink flips
  // opposite): light on the dark day/amber fill, dark on the light night fill.
  "primary-foreground": {
    onLight: ["210 40% 98%", "40 50% 97%"],
    onDark: "0 0% 0%",
    surface: "primary",
  },
  "destructive-foreground": {
    onLight: ["210 40% 98%", "40 50% 97%"],
    onDark: LIGHT_INK,
    surface: "destructive",
  },
  "brand-foreground": {
    onLight: ["210 40% 98%", "40 60% 96%"],
    onDark: "226 95% 10%",
    surface: "brand",
  },
  // Brand-hued text on the page: dark-brand for light bg, light-brand for dark bg.
  // Inks pushed toward the extremes (deep navy-bronze / bright sky) so the accent
  // stays legible where the background is mid-toned, keeping a brand tint.
  "brand-ink": {
    onLight: ["226 64% 40%", "26 85% 18%"],
    onDark: "200 95% 74%",
    surface: "background",
  },
};

export const WS_TEXT: Record<string, TextSpec> = {
  "card-foreground": {
    onLight: ["224 47% 11%", "25 42% 16%"],
    onDark: LIGHT_INK,
    surface: "card",
  },
  "popover-foreground": {
    onLight: ["224 47% 11%", "25 42% 16%"],
    onDark: LIGHT_INK,
    surface: "popover",
  },
  "muted-foreground": {
    onLight: ["220 12% 46%", "28 26% 36%"],
    onDark: "220 10% 84%",
    surface: "background",
  },
};
