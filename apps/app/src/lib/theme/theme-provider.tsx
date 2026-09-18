"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type ThemeMode,
  applyMode,
  currentMode,
  readCachedMode,
  systemMode,
  writeCachedMode,
} from "./mode";

type ThemeCtx = {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
};

const Ctx = createContext<ThemeCtx>({
  mode: "light",
  setMode: () => undefined,
  toggle: () => undefined,
});

export function useTheme(): ThemeCtx {
  return useContext(Ctx);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // "light" on the server AND on the first client render, so SSR and hydration
  // agree; the real value is adopted in the effect below. The pre-paint script
  // has already stamped the class, so nothing visibly changes — this only
  // teaches React what is on screen.
  const [mode, setModeState] = useState<ThemeMode>("light");

  useEffect(() => {
    setModeState(currentMode());
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    applyMode(next);
    writeCachedMode(next);
  }, []);

  const toggle = useCallback(() => {
    // Read the DOM, not state: the class is the live truth (the script, another
    // tab's storage event, or a cross-device sync may have moved it).
    setMode(currentMode() === "dark" ? "light" : "dark");
  }, [setMode]);

  // Follow the OS only while the user has expressed no preference of their own.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (readCachedMode()) return; // an explicit choice outranks the OS
      const next = systemMode();
      setModeState(next);
      applyMode(next);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Another TAB changed it. Same-origin storage events only; the value is
  // validated in readCachedMode, so a corrupt write cannot paint a broken theme.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "theme") return;
      const next = readCachedMode();
      if (next && next !== currentMode()) {
        setModeState(next);
        applyMode(next);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo(() => ({ mode, setMode, toggle }), [mode, setMode, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
