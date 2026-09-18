"use client";

import { memo, useEffect, useRef, useState } from "react";

/**
 * Chart.js chart, rendered from a ```chart fenced block whose body is a JSON
 * Chart.js config ({ type, data, options }). Generic + reusable: ANY skill can
 * emit the fence and get a chart — nothing here is hardcoded to a chart or a
 * feature.
 *
 * SECURITY: unlike mermaid.tsx (the one sanctioned dangerouslySetInnerHTML, for
 * its generated SVG), Chart.js draws to a <canvas>. There is NO HTML injection
 * here and a spec is JSON DATA only (JSON carries no functions, and nothing is
 * eval'd), so this is XSS-safe by construction — the `rg dangerouslySetInnerHTML
 * == 1 (mermaid)` invariant in CLAUDE.md is preserved.
 *
 * The engine (~200KB) is behind a dynamic import so it never lands in /chat's
 * first load — exactly like mermaid, shiki and three.js. It only loads when a
 * chart block actually mounts.
 */

let chartPromise: Promise<typeof import("chart.js/auto").default> | null = null;
function getChart() {
  if (!chartPromise) {
    // A failed import (offline, a deploy replacing chunks) must not be cached: the
    // next use retries instead of staying broken for the rest of the session.
    chartPromise = import("chart.js/auto").then(
      (m) => m.default,
      (e) => {
        chartPromise = null;
        throw e;
      },
    );
  }
  return chartPromise;
}

const CHART_TYPES = new Set([
  "bar",
  "line",
  "pie",
  "doughnut",
  "scatter",
  "radar",
  "polarArea",
  "bubble",
]);
const RADIAL = new Set(["pie", "doughnut", "polarArea"]);
const MAX_DATASETS = 24;
const MAX_POINTS = 2000;
// Accessible categorical palette (HSL triples).
//
// DECOUPLED FROM --brand ON PURPOSE. Index 0 used to be replaced by the brand
// token, which worked while the brand was a hue. The brand is now pure black /
// pure white, so that substitution would paint series 1 in the chrome ink while
// series 2..n stayed coloured - an unreadable chart and a meaningless legend.
// Chart series are CONTENT, not chrome, and keep their own colour.
const PALETTE = [
  "224 76% 52%",
  "160 64% 42%",
  "28 90% 52%",
  "280 60% 58%",
  "348 78% 56%",
  "192 70% 45%",
  "45 90% 50%",
  "110 45% 45%",
] as const;

function isDark(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  );
}

function readToken(el: Element, name: string, fallback: string): string {
  try {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}
// The tokens are space-separated HSL triples ("222.2 84% 4.9%"); CSS Color 4
// `hsl(H S% L%)` / `hsl(H S% L% / a)` is canvas-safe in modern browsers.
const hsl = (triple: string) => `hsl(${triple})`;
const hsla = (triple: string, a: number) => `hsl(${triple} / ${a})`;

// biome-ignore lint/suspicious/noExplicitAny: an untrusted Chart.js config shape
type AnyConfig = any;

/** Parse + validate the fence body into a Chart.js config, or null (→ source). */
function parseSpec(raw: string): AnyConfig | null {
  let spec: AnyConfig;
  try {
    spec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!spec || typeof spec !== "object") return null;
  let type = spec.type;
  const area = type === "area";
  if (area) type = "line"; // Chart.js has no "area" type — it is line + fill.
  if (typeof type !== "string" || !CHART_TYPES.has(type)) return null;
  const data = spec.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.datasets)) {
    return null;
  }
  return { ...spec, type, _area: area };
}

/** Apply theme colours to datasets that don't specify their own + force the
 *  responsive layout. Global text/grid colour is set via Chart.defaults. */
function buildConfig(cfg: AnyConfig, el: Element): AnyConfig {
  const card = readToken(el, "--card", "0 0% 100%");
  // A local alias so the reads below stay short; the tuple is frozen at module
  // scope, which is what makes PALETTE[0] a definite string for the fallbacks.
  const palette = PALETTE;
  const type: string = cfg.type;
  const area: boolean = !!cfg._area;
  const radial = RADIAL.has(type);

  const datasets = (cfg.data?.datasets ?? [])
    .slice(0, MAX_DATASETS)
    .map((ds: AnyConfig, i: number) => {
      const base = palette[i % palette.length] ?? PALETTE[0];
      const next = { ...ds };
      if (Array.isArray(next.data) && next.data.length > MAX_POINTS) {
        next.data = next.data.slice(0, MAX_POINTS);
      }
      if (radial) {
        if (next.backgroundColor == null) {
          const n = Array.isArray(next.data) ? next.data.length : palette.length;
          next.backgroundColor = Array.from({ length: n }, (_, k) =>
            hsl(palette[k % palette.length] ?? PALETTE[0]),
          );
        }
        if (next.borderColor == null) next.borderColor = hsl(card);
      } else {
        if (next.borderColor == null) next.borderColor = hsl(base);
        if (next.backgroundColor == null) {
          next.backgroundColor =
            area || type === "bar" || type === "bubble" || type === "scatter"
              ? hsla(base, type === "bar" ? 0.7 : 0.35)
              : hsla(base, 0.12);
        }
        if (area && next.fill == null) next.fill = true;
        if (type === "line" && next.tension == null) next.tension = 0.3;
      }
      return next;
    });

  // Model-provided options are honoured; responsive layout is forced last so a
  // spec can never break the pane geometry.
  const options = {
    ...(cfg.options ?? {}),
    responsive: true,
    maintainAspectRatio: false,
  };
  return { type, data: { ...cfg.data, datasets }, options };
}

function ChartBlockImpl({ spec, complete }: { spec: string; complete: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // biome-ignore lint/suspicious/noExplicitAny: Chart instance type is dynamic-imported
  const chartRef = useRef<any>(null);
  const [dark, setDark] = useState<boolean>(isDark);
  const [failed, setFailed] = useState(false);

  // Rebuild when the theme flips so colours track light/dark.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const obs = new MutationObserver(() => setDark(isDark()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    // Never parse in-flight JSON (an incomplete spec is not valid) — the
    // placeholder shows until the fence closes.
    if (!complete) {
      setFailed(false);
      return;
    }
    const cfg = parseSpec(spec);
    if (!cfg) {
      setFailed(true);
      return;
    }
    setFailed(false);
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    getChart()
      .then((Chart) => {
        if (cancelled || !canvasRef.current) return;
        // Global theme (text + grid) — applies to this and later charts; every
        // chart rebuilds on the theme flip, so they stay consistent.
        const fg = hsl(readToken(canvas, "--foreground", "222 47% 11%"));
        const grid = hsla(readToken(canvas, "--border", "214 32% 91%"), 0.5);
        Chart.defaults.color = fg;
        Chart.defaults.borderColor = grid;
        Chart.defaults.font.family = "inherit";
        if (chartRef.current) {
          chartRef.current.destroy();
          chartRef.current = null;
        }
        try {
          chartRef.current = new Chart(canvas, buildConfig(cfg, canvas));
        } catch {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [spec, complete, dark]);

  // Streaming — a subtle placeholder rather than raw partial JSON.
  if (!complete) {
    return (
      <div className="my-3 flex h-24 items-center justify-center rounded-lg border border-border bg-card text-[13px] text-primary/60">
        <span className="animate-pulse">Preparing chart…</span>
      </div>
    );
  }

  // Complete but invalid — show the source so nothing is lost + a quiet note.
  if (failed) {
    return (
      <pre className="my-3 overflow-x-auto rounded-lg bg-black/[0.045] p-4 font-geist-mono text-[12.5px] leading-[1.7] dark:bg-white/[0.04] md:text-[13px]">
        <code>{spec}</code>
        <span className="mt-2 block text-[11px] text-primary/60">
          (chart: spec could not be rendered)
        </span>
      </pre>
    );
  }

  return (
    <div data-chart className="my-3 overflow-x-auto rounded-lg border border-border bg-card p-3">
      <div className="relative h-[clamp(220px,45vw,360px)] w-full">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}

export const ChartBlock = memo(
  ChartBlockImpl,
  (a, b) => a.spec === b.spec && a.complete === b.complete,
);
