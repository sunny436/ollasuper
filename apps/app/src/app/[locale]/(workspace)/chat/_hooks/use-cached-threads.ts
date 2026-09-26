"use client";

import {
  CACHE_KEYS,
  readOwnedCache,
  writeOwnedCache,
} from "@/lib/display-cache";
import { useCacheOwner } from "@/lib/use-cache-owner";
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
  const owner = useCacheOwner();
  const [cached, setCached] = useState<CachedThread[] | null>(null);

  // Owner-bound (audit F-09): re-read whenever the verified account changes.
  useEffect(() => {
    setCached(readOwnedCache<CachedThread[]>(CACHE_KEYS.threads, owner));
  }, [owner]);

  // Only write once the live list is real (not the empty first-page-loading
  // array), or a reload would immediately cache [] over the good copy.
  useEffect(() => {
    if (loadingFirst) return;
    writeOwnedCache<CachedThread[]>(
      CACHE_KEYS.threads,
      owner,
      live.slice(0, MAX).map((t) => ({
        _id: String(t._id),
        title: t.title,
        pinned: t.pinned,
        updatedAt: t.updatedAt,
      })),
    );
  }, [live, loadingFirst, owner]);

  if (!loadingFirst) return { threads: live, showSkeleton: false };
  if (owner && cached?.length) return { threads: cached, showSkeleton: false };
  return { threads: live, showSkeleton: true };
}
