/**
 * Pure helpers for the perf probe — kept free of DOM access so they are unit
 * tested (metrics.test.ts) and the probe's arithmetic is not trusted blindly.
 */

export const PROBE_KEY = "ollasuper:perf-probe";

export type Stat = { n: number; p50: number; p90: number; max: number };

/** Nearest-rank percentiles, rounded to whole ms. null for no samples. */
export function summarize(samples: readonly number[]): Stat | null {
  if (samples.length === 0) return null;
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] ?? 0;
  return {
    n: s.length,
    p50: Math.round(at(0.5)),
    p90: Math.round(at(0.9)),
    max: Math.round(s[s.length - 1] ?? 0),
  };
}

/**
 * The display's frame interval, inferred from the typical (10th-percentile) rAF
 * delta rather than assumed: phones run at 60, 90 or 120 Hz and desktops at up to
 * 240 Hz, so any fixed budget either hides real drops or invents them. Clamped to
 * 4–34 ms (240 Hz … 30 Hz); falls back to 60 Hz without samples.
 */
export function frameBudget(typicalDeltaMs: number): number {
  if (!Number.isFinite(typicalDeltaMs) || typicalDeltaMs <= 0) return 1000 / 60;
  return Math.min(34, Math.max(4, typicalDeltaMs));
}

/** A frame is dropped when it took more than 1.5 intervals (at least one frame missed). */
export function isDropped(deltaMs: number, budgetMs: number): boolean {
  return deltaMs > budgetMs * 1.5;
}

/** Long thread ids in paths are replaced so a copied report identifies no conversation. */
export function scrubPath(path: string): string {
  return path.replace(/[a-z0-9]{20,}/gi, ":id");
}
