"use client";

import type { PaginationStatus } from "convex/react";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";

/**
 * Automatic pagination for a Convex `usePaginatedQuery` list — the "Load more"
 * button, replaced by scrolling.
 *
 * WHY THIS IS SO SMALL. Everything that makes pagination hard is already the
 * library's job, and reading it is what kept this from becoming a second
 * pagination system:
 *
 *   - `loadMore` is a NO-OP function while the status is LoadingFirstPage,
 *     LoadingMore or Exhausted, and in CanLoadMore it is latched by a closure
 *     flag so a second call in the same generation is swallowed
 *     (convex/react/use_paginated_query.js). Duplicate requests are therefore
 *     impossible, not merely guarded against.
 *   - The whole status object lives in a useMemo, so `loadMore` is
 *     REFERENTIALLY STABLE and the effect below re-runs once per page rather
 *     than once per render.
 *   - Results are one reactive subscription over accumulated page cursors, so
 *     appending, de-duplication by document id, ordering and stale-response
 *     protection are all handled upstream.
 *
 * So the only thing left to get right is WHEN to call it.
 */

const SCROLLABLE = /^(auto|scroll|overlay)$/;

/**
 * The scroll container this sentinel actually lives in, or null for the page.
 *
 * Found rather than passed in: of the eleven lists using this, the rail, the
 * chat Files section and the Move-to-project dialog own their scroller, the
 * five Settings lists scroll inside (settings)/layout.tsx — a container their
 * page components hold no ref to — and /files scrolls the document. Walking up
 * costs one pass at observer-creation time and removes all of that plumbing.
 *
 * `hidden` is deliberately NOT treated as a scroller: the card wrappers in
 * (dashboard)/files are `overflow-hidden` and would otherwise be picked as the
 * root, which is not what clips the sentinel.
 */
function nearestScroller(el: HTMLElement): HTMLElement | null {
  for (
    let p = el.parentElement;
    p && p !== document.body && p !== document.documentElement;
    p = p.parentElement
  ) {
    if (SCROLLABLE.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

export function InfiniteSentinel({
  status,
  loadMore,
  pageSize,
  className,
}: {
  status: PaginationStatus;
  loadMore: (numItems: number) => void;
  pageSize: number;
  /** Spacing for the loading row, so each list can match its own rhythm. */
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // No observer exists unless there is something to fetch. Exhausted
    // therefore means one is never created again — pagination stops for good,
    // with no listener, no timer and no polling left behind.
    if (status !== "CanLoadMore") return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    const root = nearestScroller(el);

    /**
     * Derived from the root, NOT a constant.
     *
     * `rootMargin` expands the root only. A flat 400px against the chat Files
     * section — a 256px `max-h-64` scroller — makes the effective root 1056px,
     * so the sentinel intersects on first render and the list fetches every
     * page the moment it opens. Half the root's height, floored at 120 and
     * capped at 400, preloads before the bottom everywhere without that.
     */
    const h = root ? root.clientHeight : window.innerHeight;
    const margin = Math.max(120, Math.min(400, Math.round(h / 2)));

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore(pageSize);
      },
      { root, rootMargin: `${margin}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
    // `loadMore` changes identity exactly when a page lands, which re-runs this
    // and OBSERVES AFRESH. That is load-bearing, not incidental: an observer
    // fires on threshold CROSSINGS, so when a new page does not fill the
    // viewport the sentinel is still intersecting, no crossing happens, and
    // pagination would stop dead after one page. A fresh observe() always
    // delivers an initial callback with the current state, which chains it.
  }, [status, loadMore, pageSize]);

  return (
    <>
      {/*
        h-px, not h-0: a zero-area target makes isIntersecting unreliable.
        aria-hidden with no tabIndex, so it is never a tab stop.
      */}
      <div ref={ref} aria-hidden="true" className="h-px" />
      {status === "LoadingMore" && (
        <div
          role="status"
          className={`flex items-center justify-center py-3 ${className ?? ""}`}
        >
          {/*
            motion-reduce:animate-none is required, not decorative:
            e2e/qa-responsive.js fails the run on any animation still running
            with infinite iterations under prefers-reduced-motion.
          */}
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
          <span className="sr-only">Loading more</span>
        </div>
      )}
    </>
  );
}
