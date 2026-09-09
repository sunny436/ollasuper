"use client";

import { useEffect } from "react";
import { useAmbience } from "@/lib/ambience/ambience-provider";

/**
 * The Light/Dark theme control — one 36px square, Sun or Moon.
 *
 * Replaces the Ambience sliders and the three-stop Select. Those exposed the
 * full 0–100 ambience ramp; this exposes only its two ends, because the product
 * decision is a binary white/dark theme.
 *
 * IT DOES NOT INTRODUCE THEME STATE. `useAmbience` remains the single
 * authoritative source — it owns the ~31 CSS vars, the `.dark` class on <html>,
 * the localStorage persistence and the pre-paint script. This button is one more
 * writer of that same state, and `setIntensityAnimated` gives the smooth colour
 * transition for free (a 260ms eased tween that already respects
 * prefers-reduced-motion). That is why there is no global `*` transition rule:
 * the tween writes every var each frame, so a transition on `*` would restart on
 * every element on every frame and fight it.
 *
 * THE ICONS ARE PURE CSS. Their state comes from `dark:` variants, not from
 * React. `ambience-script.tsx` stamps `.dark` before first paint, so the correct
 * icon is already correct in the first frame — no effect, no hydration
 * mismatch, and no possibility of flashing the wrong one on load. Reading
 * `intensity` to pick an icon would have reintroduced exactly that flash.
 */

/** The two ends of the ambience ramp. 0 is the `Daylight` stop, 100 `Midnight`. */
const LIGHT = 0;
const DARK = 100;

export function ThemeToggle() {
  const { setIntensityAnimated } = useAmbience();

  // The live truth, not derived state: whichever class the provider (or the
  // pre-paint script) last wrote is what the user is actually looking at.
  const toggle = () => {
    const isDark = document.documentElement.classList.contains("dark");
    setIntensityAnimated(isDark ? LIGHT : DARK);
  };

  useEffect(() => {
    // No centralized shortcut system exists in this app — every other keydown
    // handler is component-local — so there is nothing to register with. Only
    // one instance mounts at a time: the chat, settings and dashboard shells are
    // separate route groups and never render together.
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle dark and light theme"
      title="Toggle Theme (Ctrl+Shift+L)"
      className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200/80 bg-slate-100 text-slate-600 transition-all duration-200 hover:bg-white hover:text-amber-500 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-indigo-500/40 active:scale-90 dark:border-slate-700/80 dark:bg-slate-800/80 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-indigo-400 dark:hover:shadow-indigo-900/20"
    >
      {/* Sun — visible in light, spins away and shrinks in dark. Absolute so the
          two icons occupy the same centre and the morph has nothing to reflow. */}
      <svg
        aria-hidden="true"
        className="theme-icon-spring absolute h-4 w-4 rotate-0 scale-100 text-amber-500 opacity-100 dark:-rotate-90 dark:scale-50 dark:opacity-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <circle cx="12" cy="12" r="4" fill="currentColor" />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          d="M12 2v2m0 16v2m10-10h-2M4 10H2m15.364-6.364l-1.414 1.414M6.05 17.95l-1.414 1.414M17.95 17.95l-1.414-1.414M6.05 6.05L4.636 7.464"
        />
      </svg>

      {/* Moon — the mirror image of the Sun's state. */}
      <svg
        aria-hidden="true"
        className="theme-icon-spring absolute h-4 w-4 rotate-90 scale-50 text-indigo-400 opacity-0 dark:rotate-0 dark:scale-100 dark:opacity-100"
        fill="currentColor"
        viewBox="0 0 24 24"
      >
        <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
      </svg>
    </button>
  );
}
