/**
 * Pure, SSR-safe helpers for the landing ambience visuals.
 *
 * `phaseWeights` is the single source of the three crossfade weights, shared by
 * the glow orbs and the slider's Sun/Sunset/Moon icons so they can never drift.
 * `makeStars` uses Math.random and MUST be called only inside an effect (a
 * render-time call diverges server vs client → hydration mismatch → console
 * error → every e2e fails).
 */

export type Star = {
  top: number;
  left: number;
  size: number;
  kind: "ping" | "pulse";
  delay: number;
};

export function phaseWeights(intensity: number): {
  day: number;
  dusk: number;
  night: number;
} {
  const i = Math.min(100, Math.max(0, intensity));
  return {
    day: Math.max(0, 1 - i / 50),
    dusk: 1 - Math.abs(50 - i) / 50,
    night: Math.max(0, (i - 50) / 50),
  };
}

export function makeStars(count: number): Star[] {
  const stars: Star[] = [];
  for (let n = 0; n < count; n++) {
    stars.push({
      top: Math.random() * 100,
      left: Math.random() * 100,
      size: Math.random() < 0.3 ? 2 : 1,
      kind: Math.random() < 0.35 ? "ping" : "pulse",
      delay: Math.random() * 4,
    });
  }
  return stars;
}
