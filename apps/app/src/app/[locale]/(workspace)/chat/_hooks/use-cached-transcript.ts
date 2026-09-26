"use client";

import {
  CACHE_KEYS,
  onPrefetchedTranscript,
  readOwnedCache,
  takePrefetchedTranscript,
  writeOwnedCache,
} from "@/lib/display-cache";
import { useCacheOwner } from "@/lib/use-cache-owner";
import { useEffect, useState } from "react";
import type { ChatMessageDoc } from "../_components/chat-message";

const MAX_MSGS = 30;
const MAX_BYTES = 256 * 1024;

type Entry = { threadId: string; msgs: ChatMessageDoc[] };

/**
 * The transcript, but instant on reload.
 *
 * listPaged resolves only after the Convex WebSocket reconnects (~2-3s cold),
 * so a reload sits on a message skeleton for that whole time even though the
 * user is looking at a conversation they just had. This hydrates the last
 * settled transcript for THIS thread from localStorage and paints it while the
 * first page loads, then hands off to live the instant it arrives.
 *
 * Bounded to the active thread only (single key), the last MAX_MSGS messages,
 * and MAX_BYTES — a long transcript is skipped rather than blowing the ~5MB
 * localStorage quota. Hydration is in an EFFECT (no hydration mismatch); the
 * write is guarded so the empty loading state never clobbers the cache; and it
 * is cleared on sign-out. The live in-flight row is never cached here.
 *
 * A thread the rail's hover prefetch has already fetched seeds the same way,
 * from the in-memory copy (display-cache.ts setPrefetchedTranscript), read
 * synchronously on mount: on a client-side navigation there is no hydration
 * to disagree with, and on a full document load the map is empty by
 * construction, so the server and client trees are identical.
 */
export function useCachedTranscript(
  threadId: string | null,
  live: ChatMessageDoc[],
  loadingFirst: boolean,
): ChatMessageDoc[] {
  const owner = useCacheOwner();
  const [cached, setCached] = useState<Entry | null>(null);
  const [prefetched, setPrefetched] = useState<ChatMessageDoc[] | null>(() =>
    threadId ? takePrefetchedTranscript<ChatMessageDoc>(threadId) : null,
  );

  // The seed can land a moment AFTER this mounted (see onPrefetchedTranscript);
  // take it then, as long as the live first page has not arrived. Once it has,
  // `live` is returned and a seed is never looked at again.
  useEffect(() => {
    if (!threadId || prefetched || !loadingFirst) return;
    return onPrefetchedTranscript(threadId, () => {
      const rows = takePrefetchedTranscript<ChatMessageDoc>(threadId);
      if (rows) setPrefetched(rows);
    });
  }, [threadId, prefetched, loadingFirst]);

  // Owner-bound (audit F-09): re-read whenever the verified account changes.
  useEffect(() => {
    setCached(readOwnedCache<Entry>(CACHE_KEYS.transcript, owner));
  }, [owner]);

  useEffect(() => {
    if (!threadId || loadingFirst) return;
    writeOwnedCache<Entry>(
      CACHE_KEYS.transcript,
      owner,
      { threadId, msgs: live.slice(-MAX_MSGS) },
      MAX_BYTES,
    );
  }, [threadId, live, loadingFirst, owner]);

  if (loadingFirst && owner && cached?.threadId === threadId) return cached.msgs;
  if (loadingFirst && owner && prefetched) return prefetched;
  return live;
}
