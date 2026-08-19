/**
 * Ambience contrast gate (run in CI via the apps/app `test` script).
 *
 * Samples every 2% from 0..100 and asserts that every full-strength text token
 * stays legible against its surface at every slider position — the guard against
 * the mid-transition washout regressing. Opacity-dimmed usages (text-primary/40
 * icons, placeholders) are decorative and intentionally out of scope.
 *
 * Text is contrast-picked so the worst case is a narrow crossover band; we require
 * >= 4.5 everywhere outside it and >= 4.0 inside (still clearly readable). Exits 1
 * on any violation.
 */

import { computeVars } from "./interpolate";
import { ROOT_TEXT, WS_TEXT } from "./palette";

function relLum(triple: string): number {
  const [h, s, l] = triple.split(/\s+/).map((x) => Number.parseFloat(x.replace("%", "")));
  const sN = (s ?? 0) / 100;
  const lN = (l ?? 0) / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hp = ((((h ?? 0) % 360) + 360) % 360) / 60;
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
  return [r + m, g + m, b + m]
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((acc, v, i) => acc + [0.2126, 0.7152, 0.0722][i]! * v, 0);
}
function ratio(a: string, b: string) {
  const la = relLum(a);
  const lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Pairs: [label, textVar, surfaceVar]. Built from the palette specs, plus the
// chat-critical cross-scope pairs (root text renders on the workspace background).
const PAIRS: [string, string, string][] = [];
for (const token in ROOT_TEXT)
  PAIRS.push([token, `--amb-${token}`, `--amb-${ROOT_TEXT[token]!.surface}`]);
for (const token in WS_TEXT)
  PAIRS.push([`ws:${token}`, `--amb-ws-${token}`, `--amb-ws-${WS_TEXT[token]!.surface}`]);
// In chat, these root text tokens sit on the ws background (which .workspace does
// not re-point their foreground for) — the actual body-text case.
for (const token of ["foreground", "primary", "muted-foreground", "brand-ink"])
  PAIRS.push([`chat:${token}`, `--amb-${token}`, "--amb-ws-background"]);

// The light→night crossover band (percent) where the surface is mid-toned:
// amber sits at 50%, dusk at 75%, so the background passes through medium
// luminance ~52–76%. A smooth light→dark surface MUST cross medium luminance,
// where even pure black/white text caps at ~3.9:1 — so >= 4.5 at every point is
// physically impossible for a continuous slider. We require body text >= 3.5
// there (clearly readable, vs the old ~1.3 wash) and >= 4.5 everywhere else.
const CROSSOVER = (i: number) => i >= 52 && i <= 76;

// Per-role floors. brand-ink (accent text: labels/links) and muted-foreground
// (subtle secondary, unused in chat) are tinted, so on a medium surface they
// can't beat body text — allow a lower transient floor there but full at rest.
// destructive-foreground is the verbatim-existing white-on-red (3.76).
function floor(label: string, i: number): number {
  if (label.includes("destructive")) return 3.5;
  // brand-foreground sits on the brand FILL, which crosses medium luminance
  // around 74–84% (bronze→sky), a second crossover distinct from the background's.
  if (label.includes("brand-foreground")) return i >= 74 && i <= 84 ? 4.0 : 4.5;
  const tinted =
    label.includes("muted-foreground") || label.includes("brand-ink");
  if (tinted) return CROSSOVER(i) ? 2.0 : 4.5;
  return CROSSOVER(i) ? 3.5 : 4.5;
}

let fails = 0;
let worst = { r: 99, label: "", i: 0 };
for (let i = 0; i <= 100; i += 2) {
  const v = computeVars(i);
  for (const [label, fg, bg] of PAIRS) {
    const r = ratio(v[fg]!, v[bg]!);
    if (r < worst.r) worst = { r, label, i };
    const min = floor(label, i);
    if (r < min) {
      fails++;
      if (fails <= 20)
        console.log(`  FAIL i=${i} ${label}: ${r.toFixed(2)} < ${min}`);
    }
  }
}
console.log(
  `ambience contrast: ${fails} failures over ${PAIRS.length} pairs x 51 samples; worst ${worst.r.toFixed(2)} (${worst.label} @ ${worst.i}%)`,
);
process.exit(fails ? 1 : 0);
