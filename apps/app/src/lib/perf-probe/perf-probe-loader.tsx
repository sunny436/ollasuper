"use client";

import { useEffect } from "react";
import { PROBE_KEY } from "./metrics";

/**
 * Opt-in real-device performance probe (see ./probe.ts).
 *
 * `?perf=1` on any page turns it on for this browser (persisted), `?perf=0` turns
 * it off. When it is off this component does nothing but one localStorage read:
 * the probe itself is a separate chunk that is never downloaded. Renders nothing,
 * so SSR and the first client render are identical (no hydration mismatch).
 */
export function PerfProbeLoader() {
  useEffect(() => {
    let on = false;
    try {
      const flag = new URLSearchParams(window.location.search).get("perf");
      if (flag === "1") window.localStorage.setItem(PROBE_KEY, "1");
      if (flag === "0") window.localStorage.removeItem(PROBE_KEY);
      on = window.localStorage.getItem(PROBE_KEY) === "1";
    } catch {
      return;
    }
    if (!on) return;
    import("./probe").then(
      (m) => m.startProbe(),
      () => {
        /* chunk failed to load — the app must not notice */
      },
    );
  }, []);
  return null;
}
