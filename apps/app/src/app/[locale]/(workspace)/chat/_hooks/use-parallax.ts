"use client";

import { type RefObject, useEffect, useRef } from "react";

/**
 * Mouse parallax for the glow-orb layer — the capped + gated rAF idiom from
 * components/auth/intelligence-core.tsx, adapted to a transform.
 *
 * No per-move setState: the latest normalized pointer (−1..1) lives in a ref,
 * and a 30fps-capped rAF (gated on IntersectionObserver + document visibility)
 * writes a transform on `targetRef` at most once per frame. Off under
 * prefers-reduced-motion, off-screen, background tab, and coarse pointers.
 * `pointer.current` defaults to {0,0} so nothing is read at render time (the
 * first paint transform is identity → hydration-safe).
 */
export function useParallax(
  targetRef: RefObject<HTMLElement>,
  { enabled, maxPx = 20 }: { enabled: boolean; maxPx?: number },
): void {
  const pointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const el = targetRef.current;
    if (!el) return;
    if (
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
      !window.matchMedia?.("(pointer: fine)").matches
    ) {
      return;
    }

    const FRAME_MS = 1000 / 30;
    let onScreen = true;
    let pageVisible = document.visibilityState === "visible";
    let frame: number | null = null;
    let lastMs = Number.NEGATIVE_INFINITY;
    let lastX = Number.NaN;
    let lastY = Number.NaN;

    const onMove = (e: MouseEvent) => {
      pointer.current.x = Math.max(
        -1,
        Math.min(1, (e.clientX / window.innerWidth) * 2 - 1),
      );
      pointer.current.y = Math.max(
        -1,
        Math.min(1, (e.clientY / window.innerHeight) * 2 - 1),
      );
    };

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const ms = performance.now();
      if (ms - lastMs < FRAME_MS) return;
      lastMs = ms;
      const { x, y } = pointer.current;
      if (x === lastX && y === lastY) return;
      lastX = x;
      lastY = y;
      el.style.transform = `translate3d(${x * -maxPx}px, ${y * -maxPx}px, 0)`;
    };

    const start = () => {
      if (frame == null && onScreen && pageVisible) {
        lastMs = Number.NEGATIVE_INFINITY;
        frame = requestAnimationFrame(tick);
      }
    };
    const stop = () => {
      if (frame != null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };
    const sync = () => {
      if (onScreen && pageVisible) start();
      else stop();
    };

    const io = new IntersectionObserver(([entry]) => {
      onScreen = !!entry?.isIntersecting;
      sync();
    });
    io.observe(el);
    const onVis = () => {
      pageVisible = document.visibilityState === "visible";
      sync();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("mousemove", onMove, { passive: true });
    start();

    return () => {
      stop();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("mousemove", onMove);
      el.style.transform = "";
    };
  }, [enabled, maxPx, targetRef]);
}
