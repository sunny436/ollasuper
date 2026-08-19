/**
 * Ambience palette — the 3-stop colour ramps that drive the whole app.
 *
 * Each token maps to `[day, amber, night]` as HSL-triple strings ("H S% L%"),
 * the same format the CSS custom properties expect (consumed as hsl(var(--x))).
 *
 *   day   = VERBATIM the current light literal in packages/ui/src/globals.css
 *   night = VERBATIM the current .dark literal
 *   amber = the new warm mid-tone (design rules in the plan §7)
 *
 * Keeping day/night verbatim is load-bearing: interpolate.ts snaps t=0/t=1 to
 * these exact strings, so intensity 0 and 100 match the globals.css var()
 * fallbacks pixel-for-pixel (engine-on at the extremes === engine-off).
 *
 * ROOT drives `--amb-<token>` (app-wide: dashboard, settings, portals).
 * WORKSPACE drives `--amb-ws-<token>` (the .chat subtree surface palette).
 */

export type Ramp = readonly [day: string, amber: string, night: string];

export const AMBIENCE_KEY = "ambience";

/** SSR + first-client-render default (constant → no hydration mismatch). The
 *  real value is stamped pre-paint by the inline script and reconciled in the
 *  provider's mount effect. A low value keeps the un-scripted default light. */
export const DEFAULT_INTENSITY = 15;

/** Luminance thresholds (0..1) for toggling the `.dark` class off the
 *  interpolated background, with a hysteresis dead-band so a drag across the
 *  boundary doesn't strobe binary `dark:` styles. */
export const DARK_ON_LUM = 0.4; // become dark when bg darker than this
export const DARK_OFF_LUM = 0.47; // leave dark when bg brighter than this

export const ROOT: Record<string, Ramp> = {
  background: ["0 0% 100%", "38 60% 96%", "0 0% 0%"],
  foreground: ["222.2 84% 4.9%", "25 40% 15%", "0 0% 100%"],
  card: ["0 0% 100%", "40 55% 98%", "0 0% 3%"],
  "card-foreground": ["222.2 84% 4.9%", "25 40% 15%", "0 0% 100%"],
  popover: ["0 0% 100%", "40 55% 98%", "0 0% 3%"],
  "popover-foreground": ["222.2 84% 4.9%", "25 40% 15%", "0 0% 100%"],
  primary: ["222.2 47.4% 11.2%", "25 45% 18%", "0 0% 100%"],
  "primary-foreground": ["210 40% 98%", "40 50% 97%", "0 0% 0%"],
  secondary: ["210 40% 96.1%", "38 45% 90%", "0 0% 10%"],
  "secondary-foreground": ["222.2 47.4% 11.2%", "25 45% 18%", "0 0% 100%"],
  muted: ["210 40% 96.1%", "38 45% 90%", "0 0% 10%"],
  "muted-foreground": ["215.4 16.3% 46.9%", "30 25% 40%", "0 0% 70%"],
  accent: ["210 40% 96.1%", "38 40% 88%", "0 0% 15%"],
  "accent-foreground": ["222.2 47.4% 11.2%", "25 45% 18%", "0 0% 100%"],
  destructive: ["0 84.2% 60.2%", "8 75% 50%", "0 100% 30%"],
  "destructive-foreground": ["210 40% 98%", "40 50% 97%", "0 0% 100%"],
  border: ["214.3 31.8% 91.4%", "36 40% 82%", "0 0% 20%"],
  input: ["214.3 31.8% 91.4%", "36 40% 82%", "0 0% 20%"],
  ring: ["222.2 84% 4.9%", "35 85% 44%", "0 0% 80%"],
  // brand fill stays DARK (blue -> bronze) across day->amber so near-white text
  // is always legible on it (the blue<->amber midpoint is muddy, and a light
  // amber fill would fail white text at the amber preset). It brightens to sky
  // and flips to dark ink only in the amber->night half.
  brand: ["224 76% 50%", "28 80% 30%", "204 94% 62%"],
  "brand-foreground": ["210 40% 98%", "40 60% 96%", "226 95% 10%"],
  "brand-ink": ["226 64% 40%", "30 80% 30%", "204 94% 62%"],
};

export const WORKSPACE: Record<string, Ramp> = {
  background: ["220 43% 98%", "40 55% 97.5%", "228 27% 4%"],
  card: ["0 0% 100%", "44 60% 99%", "230 30% 7%"],
  "card-foreground": ["224 47% 11%", "25 42% 16%", "0 0% 100%"],
  popover: ["0 0% 100%", "44 60% 99%", "231 28% 10%"],
  "popover-foreground": ["224 47% 11%", "25 42% 16%", "0 0% 100%"],
  secondary: ["220 33% 96%", "40 45% 92%", "230 26% 9%"],
  muted: ["220 33% 96%", "40 45% 92%", "230 26% 9%"],
  "muted-foreground": ["220 12% 46%", "30 25% 42%", "220 14% 65%"],
  accent: ["220 33% 94%", "38 42% 90%", "228 25% 14%"],
  border: ["220 25% 90%", "36 38% 84%", "225 20% 17%"],
  input: ["220 25% 90%", "36 38% 84%", "225 20% 17%"],
};
