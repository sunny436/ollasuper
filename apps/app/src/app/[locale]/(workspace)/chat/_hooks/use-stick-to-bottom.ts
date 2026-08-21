"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * Keep the transcript pinned to the bottom while content grows, UNLESS the user
 * has scrolled up — then leave them exactly where they are and resume only when
 * they come back to the bottom themselves.
 *
 * The truth of "is the user at the bottom" comes from ONE authoritative scroll
 * listener that reads the scroll position directly. An earlier version used an
 * IntersectionObserver with a 140px rootMargin whose callback overwrote the
 * at-bottom flag unconditionally: any scroll-up smaller than 140px flipped it
 * back on and the next streamed frame yanked the reader back down. Reading the
 * position covers every modality uniformly — wheel, touch, scrollbar-drag,
 * momentum fling, keyboard — which an intent latch on wheel/touch alone missed.
 */

/**
 * Within this many px of the bottom counts as "following". Small enough that a
 * deliberate scroll-up unsticks at once; comfortably larger than the ~1-3px
 * jitter a programmatic pin leaves during streaming, so it never false-unsticks.
 */
const BOTTOM_THRESHOLD = 64;

export function useStickToBottom(deps: unknown[]) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNew, setHasNew] = useState(false);

  // --- authoritative scroll-position truth --------------------------------
  // Updates the ref SYNCHRONOUSLY (not rAF-throttled): a deferred write would
  // let a reveal-frame pin fire a one-frame yank mid scrollbar-drag. State is
  // mirrored only on transition, so a scroll costs ~2 renders, not hundreds.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const bottom = dist <= BOTTOM_THRESHOLD;
      atBottomRef.current = bottom;
      setAtBottom((prev) => (prev === bottom ? prev : bottom));
      if (bottom) setHasNew(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // --- synchronous user-intent latch --------------------------------------
  // Releases the pin the instant a gesture starts, before its scroll event is
  // dispatched — belt-and-suspenders against a pin landing in that gap. The
  // scroll listener above then reconciles to the real position (a wheel DOWN
  // toward the bottom re-sticks; a wheel UP stays released).
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

  /**
   * Preserve the reader's position when older messages are prepended. Call it
   * BEFORE loadMore to snapshot the height, then invoke the returned closure in
   * a layout effect once the new page has rendered.
   */
  const anchorForPrepend = useCallback(() => {
    const el = scrollerRef.current;
    const before = el?.scrollHeight ?? 0;
    return () => {
      const node = scrollerRef.current;
      if (node) node.scrollTop += node.scrollHeight - before;
    };
  }, []);

  return { scrollerRef, atBottom, hasNew, scrollToBottom, anchorForPrepend };
}
