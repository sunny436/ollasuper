"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Coalesce a rapidly-changing value with a trailing flush.
 *
 * Streaming deltas arrive faster than is useful to render. ~60ms is ~16
 * updates/sec — below the threshold where text reads as stalling, and 3-5x
 * fewer React renders than the raw delta rate.
 *
 * The trailing flush matters: without it the final tokens of a reply can sit
 * unrendered until some later change happens to trigger one.
 */
export function useThrottledValue<T>(value: T, ms = 60): T {
  const [throttled, setThrottled] = useState(value);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const elapsed = Date.now() - last.current;
    if (elapsed >= ms) {
      last.current = Date.now();
      setThrottled(value);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      last.current = Date.now();
      setThrottled(value);
    }, ms - elapsed);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, ms]);

  return throttled;
}
