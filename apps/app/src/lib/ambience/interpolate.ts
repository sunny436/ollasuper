/**
 * Pure ambience math — no DOM, no React. Imported by the provider (runtime) and
 * mirrored by the pre-hydration inline script (ambience-script.tsx). If you
 * change the interpolation here, change the inline script to match or the first
 * paint will flash. The scratchpad parity check (verification) guards this.
 *
 * Surfaces lerp through N stops. Text tokens NEVER lerp through grey: they output
 * whichever ink (onLight, interpolated day->amber / onDark, night) has the higher
 * WCAG contrast against their paired surface — always the max-contrast choice.
 */

import {
  AMBER_T,
  DARK_OFF_LUM,
  DARK_ON_LUM,
  type Ramp,
  ROOT_SURFACE,
  ROOT_TEXT,
  type TextSpec,
  WS_SURFACE,
  WS_TEXT,
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

/** WCAG relative luminance (0..1) of an HSL-triple string. */
function relLuminance(triple: string): number {
  const [r, g, b] = hslToRgb(...parseTriple(triple)).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Non-uniform stop positions so the named phases land on their slider presets:
// 4-stop surfaces are [day@0, amber@0.5, dusk@0.75, night@1] — amber stays the
// 50% preset, and the amber->night darkening is compressed into the top half.
const POS: Record<number, number[]> = {
  2: [0, 1],
  4: [0, 0.5, 0.75, 1],
};
function positions(n: number): number[] {
  return POS[n] ?? Array.from({ length: n }, (_, i) => i / (n - 1));
}

/** Interpolate an N-stop ramp at t (0..1) in RGB. Endpoints snap to the source
 *  strings so 0/1 match the globals.css fallbacks with no round-trip drift. */
export function lerpToken(ramp: Ramp, t: number): string {
  if (t <= 0) return ramp[0]!;
  if (t >= 1) return ramp[ramp.length - 1]!;
  const pos = positions(ramp.length);
  let i = 0;
  while (i < pos.length - 2 && t >= pos[i + 1]!) i++;
  const local = (t - pos[i]!) / (pos[i + 1]! - pos[i]!);
  if (local <= 0) return ramp[i]!;
  const a = hslToRgb(...parseTriple(ramp[i]!));
  const b = hslToRgb(...parseTriple(ramp[i + 1]!));
  return rgbToTriple([
    lerp(a[0], b[0], local),
    lerp(a[1], b[1], local),
    lerp(a[2], b[2], local),
  ]);
}

/** A text token: the higher-contrast of {onLight (day->amber), onDark (night)}
 *  against its already-interpolated surface. Never a mid-grey lerp. */
function pickText(spec: TextSpec, surface: string, t: number): string {
  const onLight = lerpToken(spec.onLight, Math.min(1, t / AMBER_T));
  return contrast(onLight, surface) >= contrast(spec.onDark, surface)
    ? onLight
    : spec.onDark;
}

/** Every `--amb-*` / `--amb-ws-*` var → HSL-triple string, for one intensity. */
export function computeVars(intensity: number): Record<string, string> {
  const t = Math.min(1, Math.max(0, intensity / 100));
  const out: Record<string, string> = {};

  // Pass 1: surfaces (text tokens read these back for the contrast pick).
  for (const token in ROOT_SURFACE)
    out[`--amb-${token}`] = lerpToken(ROOT_SURFACE[token]!, t);
  for (const token in WS_SURFACE)
    out[`--amb-ws-${token}`] = lerpToken(WS_SURFACE[token]!, t);

  // Pass 2: text (max-contrast against the paired surface). The paired surface is
  // resolved from `out`, so a text token may pair with another text token
  // (primary-foreground -> primary) as long as it is declared after it.
  for (const token in ROOT_TEXT) {
    const spec = ROOT_TEXT[token]!;
    out[`--amb-${token}`] = pickText(spec, out[`--amb-${spec.surface}`]!, t);
  }
  for (const token in WS_TEXT) {
    const spec = WS_TEXT[token]!;
    out[`--amb-ws-${token}`] = pickText(spec, out[`--amb-ws-${spec.surface}`]!, t);
  }
  return out;
}

/** Whether `.dark` should be on, from the background luminance, with hysteresis. */
export function intensityToDark(intensity: number, wasDark: boolean): boolean {
  const t = Math.min(1, Math.max(0, intensity / 100));
  const lum = relLuminance(lerpToken(ROOT_SURFACE.background!, t));
  return wasDark ? lum < DARK_OFF_LUM : lum < DARK_ON_LUM;
}

/** CSS colour strings the landing UI consumes directly (greeting, slider glass).
 *  Greeting text is contrast-picked against the CHAT (workspace) background. */
export function colorsFor(intensity: number): {
  text: string;
  glassBg: string;
  glassBorder: string;
  trackFill: string;
} {
  const t = Math.min(1, Math.max(0, intensity / 100));
  const wsBg = lerpToken(WS_SURFACE.background!, t);
  const text = pickText(ROOT_TEXT.foreground!, wsBg, t);
  return {
    text: `hsl(${text})`,
    glassBg: `hsl(${lerpToken(WS_SURFACE.card!, t)} / 0.7)`,
    glassBorder: `hsl(${lerpToken(WS_SURFACE.border!, t)} / 0.6)`,
    trackFill: `hsl(${lerpToken(ROOT_SURFACE.brand!, t)})`,
  };
}
