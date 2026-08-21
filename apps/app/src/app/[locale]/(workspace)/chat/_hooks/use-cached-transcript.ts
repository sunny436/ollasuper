"use client";

import { CACHE_KEYS } from "@/lib/display-cache";
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
 */
export function useCachedTranscript(
  threadId: string | null,
  live: ChatMessageDoc[],
  loadingFirst: boolean,
): ChatMessageDoc[] {
  const [cached, setCached] = useState<Entry | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(CACHE_KEYS.transcript);
      if (raw) setCached(JSON.parse(raw) as Entry);
    } catch {}
  }, []);

  useEffect(() => {
    if (!threadId || loadingFirst || typeof window === "undefined") return;
    try {
      const payload = JSON.stringify({
        threadId,
        msgs: live.slice(-MAX_MSGS),
      } satisfies Entry);
      if (payload.length <= MAX_BYTES) {
        window.localStorage.setItem(CACHE_KEYS.transcript, payload);
      } else {
        window.localStorage.removeItem(CACHE_KEYS.transcript);
      }
    } catch {}
  }, [threadId, live, loadingFirst]);

  if (loadingFirst && cached?.threadId === threadId) return cached.msgs;
  return live;
}
