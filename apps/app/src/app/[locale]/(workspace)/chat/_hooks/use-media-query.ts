"use client";

import { useEffect, useState } from "react";

/**
 * SSR-safe matchMedia.
 *
 * Always false on the server and on first client render, then resolved in an
 * effect. Reading matchMedia during render would produce a server/client
 * mismatch, which React reports via console.error — and every e2e script
 * asserts zero console errors.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
