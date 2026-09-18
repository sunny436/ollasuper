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
  type AccentName,
  applyAccent,
  currentAccent,
  readCachedAccent,
  writeCachedAccent,
} from "./accent";
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
  accent: AccentName;
  setAccent: (accent: AccentName) => void;
};

const Ctx = createContext<ThemeCtx>({
  mode: "light",
  setMode: () => undefined,
  toggle: () => undefined,
  accent: "blue",
  setAccent: () => undefined,
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
  // Same SSR-safe shape as mode: the default on the server and the first client
  // render, adopted from the DOM in the effect. The pre-paint script has already
  // stamped the attribute, so nothing visibly changes — this only tells React
  // what is on screen.
  const [accent, setAccentState] = useState<AccentName>("blue");

  useEffect(() => {
    setModeState(currentMode());
    setAccentState(currentAccent());
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    applyMode(next);
    writeCachedMode(next);
  }, []);

  // Accent is written and compared entirely separately from mode — different
  // storage keys, different DOM hook — so setting one cannot disturb the other.
  const setAccent = useCallback((next: AccentName) => {
    setAccentState(next);
    applyAccent(next);
    writeCachedAccent(next);
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

  // Ctrl/Cmd+Shift+L, app-wide.
  //
  // This lived inside ThemeToggle, which is only mounted in the chat header, the
  // dashboard sidebar and the settings rail — so the shortcut silently did
  // nothing on /projects, /scheduled and /files, the three routes where the
  // button is not rendered either. A shortcut that works on some routes is worse
  // than one that works on none, because the user learns it and then it fails.
  // The provider wraps every route, so here it is simply global.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  // Another TAB changed it. Same-origin storage events only; the value is
  // validated in readCachedMode, so a corrupt write cannot paint a broken theme.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "theme") {
        const next = readCachedMode();
        if (next && next !== currentMode()) {
          setModeState(next);
          applyMode(next);
        }
        return;
      }
      // Accent crosses tabs the same way, and is validated on the way in for the
      // same reason: a storage event carries whatever another tab wrote, and a
      // value that is not one of the literals must never reach the attribute.
      if (e.key === "accent") {
        const next = readCachedAccent();
        if (next && next !== currentAccent()) {
          setAccentState(next);
          applyAccent(next);
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo(
    () => ({ mode, setMode, toggle, accent, setAccent }),
    [mode, setMode, toggle, accent, setAccent],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
