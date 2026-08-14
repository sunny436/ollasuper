"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Bottom-pinning that does not fight the user.
 *
 * Three mechanisms, each for a specific failure mode:
 *
 *  1. An IntersectionObserver sentinel decides "am I at the bottom".
 *     Not `scrollHeight - scrollTop - clientHeight < N`: that reads three
 *     layout properties on every scroll event, forcing a synchronous reflow at
 *     60fps while the transcript is simultaneously growing, and it is
 *     unreliable under browser zoom and fractional device pixel ratios (the
 *     sum is off by sub-pixels and "at bottom" never becomes true). IO is
 *     batched by the browser and rootMargin gives free hysteresis.
 *
 *  2. Pinning happens in useLayoutEffect, before paint, so growth and scroll
 *     land in the same frame with no visible tear. Direct `scrollTop =`
 *     rather than scrollIntoView({behavior:"smooth"}) — smooth scrolls are
 *     animations, and firing one every 60ms queues overlapping animations that
 *     visibly fight each other and never converge.
 *
 *  3. A SYNCHRONOUS user-intent latch on wheel/touch/keys. The IO callback is
 *     asynchronous and can be a frame late; in that frame the layout effect
 *     would yank the user back down. That is exactly the "it fights me" bug.
 */
export function useStickToBottom(deps: unknown[]) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNew, setHasNew] = useState(false);

  // --- IO sentinel: state only -------------------------------------------
  useEffect(() => {
    const root = scrollerRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;

    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        atBottomRef.current = visible;
        // Mirror into state only on transition, so a user scroll costs ~2
        // renders rather than 200.
        setAtBottom((prev) => (prev === visible ? prev : visible));
        if (visible) setHasNew(false);
      },
      { root, rootMargin: "0px 0px 140px 0px", threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, []);

  // --- synchronous user-intent latch --------------------------------------
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const release = () => {
      atBottomRef.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (["PageUp", "Home", "ArrowUp"].includes(e.key)) release();
    };
    el.addEventListener("wheel", release, { passive: true });
    el.addEventListener("touchstart", release, { passive: true });
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("wheel", release);
      el.removeEventListener("touchstart", release);
      el.removeEventListener("keydown", onKey);
    };
  }, []);

  // --- pin before paint ----------------------------------------------------
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (!atBottomRef.current) {
      setHasNew(true);
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, deps);

  // --- late-arriving content (shiki swap, images, web fonts) ---------------
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current && scrollerRef.current) {
        scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
      }
    });
    const inner = el.firstElementChild;
    if (inner) ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    atBottomRef.current = true;
    setAtBottom(true);
    setHasNew(false);
    // Smooth is used ONLY here, for an explicit user action.
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  /** Preserve position when older messages are prepended. */
  const anchorForPrepend = useCallback(() => {
    const el = scrollerRef.current;
    const before = el?.scrollHeight ?? 0;
    return () => {
      const node = scrollerRef.current;
      if (node) node.scrollTop += node.scrollHeight - before;
    };
  }, []);

  return {
    scrollerRef,
    sentinelRef,
    atBottom,
    hasNew,
    scrollToBottom,
    anchorForPrepend,
  };
}
