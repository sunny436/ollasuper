/**
 * Pure ambience math — no DOM, no React. Imported by the provider (runtime) and
 * mirrored by the pre-hydration inline script (ambience-script.tsx). If you
 * change the interpolation here, change the inline script to match or the first
 * paint will flash. The scratchpad parity check (verification) guards this.
 */

import {
  DARK_OFF_LUM,
  DARK_ON_LUM,
  ROOT,
  type Ramp,
  WORKSPACE,
} from "./palette";

function parseTriple(triple: string): [number, number, number] {
  const [h, s, l] = triple.split(/\s+/);
  return [
    Number.parseFloat(h ?? "0"),
    Number.parseFloat((s ?? "0").replace("%", "")),
    Number.parseFloat((l ?? "0").replace("%", "")),
  ];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = lN - c / 2;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function rgbToTriple([r, g, b]: [number, number, number]): string {
  const rN = r / 255;
  const gN = g / 255;
  const bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rN) h = ((gN - bN) / d) % 6;
    else if (max === gN) h = (bN - rN) / d + 2;
    else h = (rN - gN) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  return `${round(h)} ${round(s * 100)}% ${round(l * 100)}%`;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Interpolate one ramp at t (0..1). Snaps the exact endpoints to the source
 *  strings so 0/100 match the globals.css fallbacks with no round-trip drift. */
export function lerpToken(ramp: Ramp, t: number): string {
  if (t <= 0) return ramp[0];
  if (t >= 1) return ramp[2];
  // Two segments meeting at the amber mid-stop (t=0.5); lerp in RGB so the
  // path never crosses the muddy grey midpoint and hue never wraps the wrong way.
  const [from, to, local] =
    t < 0.5 ? [ramp[0], ramp[1], t / 0.5] : [ramp[1], ramp[2], (t - 0.5) / 0.5];
  const a = hslToRgb(...parseTriple(from));
  const b = hslToRgb(...parseTriple(to));
  return rgbToTriple([
    lerp(a[0], b[0], local),
    lerp(a[1], b[1], local),
    lerp(a[2], b[2], local),
  ]);
}

/** Every `--amb-*` / `--amb-ws-*` var → HSL-triple string, for one intensity. */
export function computeVars(intensity: number): Record<string, string> {
  const t = Math.min(1, Math.max(0, intensity / 100));
  const out: Record<string, string> = {};
  for (const token in ROOT) out[`--amb-${token}`] = lerpToken(ROOT[token]!, t);
  for (const token in WORKSPACE)
    out[`--amb-ws-${token}`] = lerpToken(WORKSPACE[token]!, t);
  return out;
}

/** Relative luminance (0..1) of the interpolated app-wide background. */
function backgroundLuminance(intensity: number): number {
  const t = Math.min(1, Math.max(0, intensity / 100));
  const [r, g, b] = hslToRgb(...parseTriple(lerpToken(ROOT.background!, t)));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Whether `.dark` should be on, with hysteresis around the last state. */
export function intensityToDark(intensity: number, wasDark: boolean): boolean {
  const lum = backgroundLuminance(intensity);
  return wasDark ? lum < DARK_OFF_LUM : lum < DARK_ON_LUM;
}

/** CSS colour strings the landing UI consumes directly (greeting, slider glass). */
export function colorsFor(intensity: number): {
  text: string;
  glassBg: string;
  glassBorder: string;
  trackFill: string;
} {
  const t = Math.min(1, Math.max(0, intensity / 100));
  return {
    text: `hsl(${lerpToken(ROOT.foreground!, t)})`,
    glassBg: `hsl(${lerpToken(WORKSPACE.card!, t)} / 0.7)`,
    glassBorder: `hsl(${lerpToken(WORKSPACE.border!, t)} / 0.6)`,
    trackFill: `hsl(${lerpToken(ROOT.brand!, t)})`,
  };
}
