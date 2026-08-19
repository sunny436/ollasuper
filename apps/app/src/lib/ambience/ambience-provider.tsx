"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { colorsFor, computeVars, intensityToDark } from "./interpolate";
import { AMBIENCE_KEY, DEFAULT_INTENSITY } from "./palette";

/** Kill-switch: NEXT_PUBLIC_AMBIENCE="off" makes the provider a pass-through
 *  (no var writes, no `.dark`) so every token falls back to the globals.css
 *  literal = today's light app. Instant rollback with no code revert. */
const ENABLED = process.env.NEXT_PUBLIC_AMBIENCE !== "off";

type AmbienceCtx = {
  intensity: number;
  setIntensity: (n: number) => void;
  setIntensityAnimated: (n: number) => void;
  colors: ReturnType<typeof colorsFor>;
};

const AmbienceContext = createContext<AmbienceCtx | null>(null);

export function useAmbience(): AmbienceCtx {
  const ctx = useContext(AmbienceContext);
  if (!ctx) throw new Error("useAmbience must be used within <AmbienceProvider>");
  return ctx;
}

const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

export function AmbienceProvider({ children }: { children: React.ReactNode }) {
  const [intensity, setIntensityState] = useState(DEFAULT_INTENSITY);
  const raf = useRef<number | null>(null);
  const pending = useRef(DEFAULT_INTENSITY);
  const lastWrite = useRef(Number.NEGATIVE_INFINITY);
  const wasDark = useRef(false);
  const tween = useRef<number | null>(null);

  // Write the ~31 vars + `.dark` + dataset. One full-document repaint each call.
  const write = useCallback((v: number) => {
    if (!ENABLED || typeof document === "undefined") return;
    const root = document.documentElement;
    const vars = computeVars(v);
    for (const k in vars) root.style.setProperty(k, vars[k]!);
    const dark = intensityToDark(v, wasDark.current);
    wasDark.current = dark;
    root.classList.toggle("dark", dark);
    root.dataset.ambience = String(v);
    try {
      localStorage.setItem(AMBIENCE_KEY, String(v));
    } catch {}
  }, []);

  // Coalesce to one write per frame, capped at ~30fps (repaints are the cost).
  const schedule = useCallback(
    (v: number) => {
      pending.current = v;
      if (raf.current != null) return;
      const tick = () => {
        const now =
          typeof performance !== "undefined" ? performance.now() : 0;
        if (now - lastWrite.current < 33) {
          raf.current = requestAnimationFrame(tick);
          return;
        }
        raf.current = null;
        lastWrite.current = now;
        write(pending.current);
      };
      raf.current = requestAnimationFrame(tick);
    },
    [write],
  );

  const setIntensity = useCallback(
    (n: number) => {
      const v = clamp(n);
      if (tween.current != null) {
        cancelAnimationFrame(tween.current);
        tween.current = null;
      }
      setIntensityState(v);
      schedule(v);
    },
    [schedule],
  );

  // JS-tween for preset/threshold jumps (no CSS transitions on the tokens).
  const setIntensityAnimated = useCallback(
    (target: number) => {
      const to = clamp(target);
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (reduce) {
        setIntensity(to);
        return;
      }
      if (tween.current != null) cancelAnimationFrame(tween.current);
      const from = pending.current;
      const start = performance.now();
      const DUR = 260;
      const step = () => {
        const p = Math.min(1, (performance.now() - start) / DUR);
        const eased = 1 - (1 - p) ** 3;
        const v = clamp(from + (to - from) * eased);
        setIntensityState(v);
        schedule(v);
        tween.current = p < 1 ? requestAnimationFrame(step) : null;
      };
      tween.current = requestAnimationFrame(step);
    },
    [schedule, setIntensity],
  );

  // Reconcile from the value the inline script already applied pre-paint. Read
  // in an effect (not a useState initializer) so SSR === first client render →
  // no hydration mismatch (the zero-console-error e2e gate).
  useEffect(() => {
    wasDark.current = document.documentElement.classList.contains("dark");
    const stamped = document.documentElement.dataset.ambience;
    let v = stamped != null ? Number(stamped) : Number.NaN;
    if (!Number.isFinite(v)) {
      try {
        const stored = localStorage.getItem(AMBIENCE_KEY);
        if (stored != null) v = Number(stored);
      } catch {}
    }
    if (Number.isFinite(v)) {
      const c = clamp(v);
      pending.current = c;
      setIntensityState(c);
      // If the script never ran (e.g. it errored) but a value exists, apply now.
      if (stamped == null) write(c);
    }
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
      if (tween.current != null) cancelAnimationFrame(tween.current);
    };
  }, [write]);

  const colors = colorsFor(intensity);

  return (
    <AmbienceContext.Provider
      value={{ intensity, setIntensity, setIntensityAnimated, colors }}
    >
      {children}
    </AmbienceContext.Provider>
  );
}
