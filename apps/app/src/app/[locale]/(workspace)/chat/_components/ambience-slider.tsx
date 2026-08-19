"use client";

import { Moon, Sun, Sunset } from "lucide-react";
import { useAmbience } from "@/lib/ambience/ambience-provider";
import { phaseWeights } from "../_lib/ambience";

// Custom thumb geometry (px). Travel = pill inner width − padding − thumb.
const PAD = 4;
const THUMB = 28;

function phaseName(i: number) {
  return i < 34 ? "Daylight" : i < 67 ? "Amber" : "Midnight";
}

/**
 * The Ambience control — a glassmorphic pill with a native range input made
 * invisible over a custom track + thumb. The thumb crossfades Sun/Sunset/Moon
 * by the same phase weights the glow orbs use. Replaces the old Light/Dark
 * Select in the chat header. No Radix portal → no `className="workspace"` needed.
 */
export function AmbienceSlider() {
  const { intensity, setIntensity, colors } = useAmbience();
  const w = phaseWeights(intensity);
  const pct = intensity / 100;
  const night = w.night > 0.5;

  return (
    <div className="flex flex-col items-center gap-1">
      <span
        className="hidden text-[10px] font-semibold uppercase tracking-widest sm:block"
        style={{ color: colors.text, opacity: 0.65 }}
      >
        Ambience: {intensity}%
      </span>

      <div
        className="relative flex h-9 w-[150px] items-center rounded-full border backdrop-blur-2xl sm:w-[240px]"
        style={{ background: colors.glassBg, borderColor: colors.glassBorder }}
      >
        {/* Track fill — left edge to thumb centre. */}
        <div
          className="pointer-events-none absolute inset-y-1 left-1 rounded-full"
          style={{
            width: `calc(14px + ${pct} * (100% - ${PAD * 2 + THUMB}px))`,
            background: `linear-gradient(90deg, transparent, ${colors.trackFill})`,
            opacity: 0.45,
          }}
        />

        {/* Snap points at 0 / 50 / 100. */}
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-between px-[18px]"
          style={{ color: colors.text }}
        >
          <span className="h-1 w-1 rounded-full bg-current opacity-25" />
          <span className="h-1 w-1 rounded-full bg-current opacity-25" />
          <span className="h-1 w-1 rounded-full bg-current opacity-25" />
        </div>

        {/* Custom thumb (visual only). */}
        <div
          className="pointer-events-none absolute z-10 grid place-items-center rounded-full shadow-md"
          style={{
            height: THUMB,
            width: THUMB,
            left: `calc(${PAD}px + ${pct} * (100% - ${PAD * 2 + THUMB}px))`,
            background: night ? "#27272a" : "#ffffff",
            border: `1px solid ${colors.glassBorder}`,
          }}
        >
          <Sun
            className="absolute h-4 w-4 text-sky-500"
            style={{ opacity: w.day }}
          />
          <Sunset
            className="absolute h-4 w-4 text-amber-500"
            style={{ opacity: w.dusk }}
          />
          <Moon
            className="absolute h-4 w-4 fill-indigo-400/20 text-indigo-300"
            style={{ opacity: w.night }}
          />
        </div>

        {/* The real, invisible input — keyboard a11y (arrows/Home/End) for free. */}
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={intensity}
          onChange={(e) => setIntensity(Number(e.target.value))}
          className="absolute inset-0 z-20 h-full w-full cursor-pointer opacity-0"
          aria-label="Ambience"
          aria-valuetext={`${phaseName(intensity)}, ${intensity} percent`}
        />
      </div>
    </div>
  );
}
