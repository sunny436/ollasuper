"use client";

/**
 * Display-only localStorage caches that mask the Convex WebSocket cold-connect
 * (~2-3s through the tunnel) so chrome and transcript paint instantly on reload
 * instead of flashing a skeleton. Every value here is reconciled by a live query
 * the moment it lands; nothing security- or send-related reads from these keys.
 *
 * They MUST be cleared on sign-out. Otherwise the next account signed in on a
 * shared browser briefly sees the previous user's name, thread list and
 * transcript before the live queries overwrite them.
 */
export const CACHE_KEYS = {
  /** api.users.getUser display slice — see use-cached-user.ts. */
  user: "user",
  /** api.chat.threads.list first page — see use-cached-threads.ts. */
  threads: "chat:threads",
  /** The active thread's settled transcript — see use-cached-transcript.ts. */
  transcript: "chat:transcript",
} as const;

export function clearDisplayCaches(): void {
  prefetchedTranscripts.clear();
  if (typeof window === "undefined") return;
  try {
    for (const key of Object.values(CACHE_KEYS)) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Private mode / blocked storage — nothing to clear.
  }
}

/**
 * Transcripts the hover prefetch (chat/_lib/prefetch.ts) has already received,
 * keyed by thread id — IN MEMORY, not localStorage.
 *
 * The rail's hover prefetch warms `messages.listPaged` for the hovered thread,
 * but `usePaginatedQuery` keys its first page on a private per-mount id, so
 * the warmed result was never the one the transcript subscribed to: the page
 * was fetched on hover (~200 KB) and fetched AGAIN on click, and the user
 * waited for the second one. This is the seam that lets the first fetch be the
 * one that paints: prefetch stores the page here, use-cached-transcript seeds
 * from it while the paginated query is still loading, exactly as it already
 * seeds from the localStorage copy of the active thread on reload.
 *
 * In memory because it is written on every hover (a 256 KB synchronous
 * localStorage write per hover is not free), it must never survive a page
 * load (a full load has no hover to seed from, and SSR/hydration must agree),
 * and it must not clobber the active-thread reload cache. Bounded to the same
 * handful of threads the prefetch itself holds warm. Cleared with the other
 * caches on sign-out, so a second account on a shared browser can never seed
 * from the first one's transcript.
 */
const PREFETCH_MAX = 6;
// biome-ignore lint/suspicious/noExplicitAny: the transcript row type lives in the chat route; this cache is type-agnostic by design
const prefetchedTranscripts = new Map<string, any[]>();

export function setPrefetchedTranscript<T>(threadId: string, rows: T[]): void {
  prefetchedTranscripts.delete(threadId);
  if (prefetchedTranscripts.size >= PREFETCH_MAX) {
    const oldest = prefetchedTranscripts.keys().next().value;
    if (oldest !== undefined) prefetchedTranscripts.delete(oldest);
  }
  prefetchedTranscripts.set(threadId, rows);
}

export function getPrefetchedTranscript<T>(threadId: string): T[] | null {
  return (prefetchedTranscripts.get(threadId) as T[] | undefined) ?? null;
}
