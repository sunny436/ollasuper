"use client";

import { CACHE_KEYS } from "@/lib/display-cache";
import { useEffect, useState } from "react";

export type CachedThread = {
  _id: string;
  title: string;
  pinned: boolean;
  updatedAt: number;
};

const MAX = 30;

/**
 * The conversation rail, but instant on reload.
 *
 * The live paginated query resolves only after the Convex WebSocket reconnects
 * (~2-3s cold through the tunnel), so the rail shows a six-row skeleton on every
 * reload. This hydrates the last list from localStorage post-mount and hands
 * back the live value the moment it lands.
 *
 * The hydration read is in an EFFECT, not during render, so the first client
 * render still matches the server (no list) — no hydration mismatch, which every
 * e2e script asserts. Display-only; the write is guarded so the empty
 * loading-state array never clobbers a good cache, and it is cleared on sign-out.
 */
export function useCachedThreads(
  live: CachedThread[],
  loadingFirst: boolean,
): { threads: CachedThread[]; showSkeleton: boolean } {
  const [cached, setCached] = useState<CachedThread[] | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(CACHE_KEYS.threads);
      if (raw) setCached(JSON.parse(raw) as CachedThread[]);
    } catch {}
  }, []);

  // Only write once the live list is real (not the empty first-page-loading
  // array), or a reload would immediately cache [] over the good copy.
  useEffect(() => {
    if (loadingFirst || typeof window === "undefined") return;
    try {
      const slice = live.slice(0, MAX).map((t) => ({
        _id: String(t._id),
        title: t.title,
        pinned: t.pinned,
        updatedAt: t.updatedAt,
      }));
      window.localStorage.setItem(CACHE_KEYS.threads, JSON.stringify(slice));
    } catch {}
  }, [live, loadingFirst]);

  if (!loadingFirst) return { threads: live, showSkeleton: false };
  if (cached?.length) return { threads: cached, showSkeleton: false };
  return { threads: live, showSkeleton: true };
}
