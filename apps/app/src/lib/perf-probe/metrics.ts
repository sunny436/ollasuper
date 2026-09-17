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
 * The display's frame budget, inferred from the shortest frame deltas seen.
 * rAF runs at 60 Hz on most phones and at 120 Hz on ProMotion/high-refresh
 * displays; a fixed 16.7 ms budget would count every 120 Hz frame as "on time"
 * and miss real drops there.
 */
export function frameBudget(shortestDeltaMs: number): number {
  if (!Number.isFinite(shortestDeltaMs) || shortestDeltaMs <= 0) return 1000 / 60;
  return shortestDeltaMs < 12 ? 1000 / 120 : 1000 / 60;
}

/** A frame is dropped when it took more than 1.5 budgets (at least one frame missed). */
export function isDropped(deltaMs: number, budgetMs: number): boolean {
  return deltaMs > budgetMs * 1.5;
}

/** Long thread ids in paths are replaced so a copied report identifies no conversation. */
export function scrubPath(path: string): string {
  return path.replace(/[a-z0-9]{20,}/gi, ":id");
}
