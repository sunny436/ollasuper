import { api } from "@v1/backend/convex/_generated/api";
import type { ConvexReactClient } from "convex/react";

/**
 * Intent-based (hover/focus) prefetch for thread navigation.
 *
 * useQuery reads a value out of the client's local store
 * (watchQuery(...).localQueryResult()). A plain client.query() subscribes, reads
 * once and immediately unsubscribes, so its value is not reliably in the store
 * when the target page mounts a frame later. To make the switch instant we must
 * RETAIN a watchQuery subscription for a short while, so threads.get and
 * stream.active resolve synchronously on arrival with no skeleton flash.
 *
 * listPaged is warmed best-effort: usePaginatedQuery keys its first page on
 * internal paginationOpts, so the token may not match for synchronous reuse —
 * but the warm still pre-pays the round-trip. The reliable instant transcript
 * comes from the localStorage cache (use-cached-transcript), not this.
 *
 * Held subscriptions are bounded: a TTL releases them, and an LRU cap keeps at
 * most MAX warm at once, so hovering the whole rail never leaks subscriptions.
 */
const TTL_MS = 20_000;
const MAX = 6;

type Held = { unsubs: Array<() => void>; timer: ReturnType<typeof setTimeout> };
const held = new Map<string, Held>();

function release(threadId: string): void {
  const h = held.get(threadId);
  if (!h) return;
  clearTimeout(h.timer);
  for (const u of h.unsubs) {
    try {
      u();
    } catch {}
  }
  held.delete(threadId);
}

export function prefetchThread(
  client: ConvexReactClient,
  threadId: string,
): void {
  if (held.has(threadId)) return; // already warm
  if (held.size >= MAX) {
    const oldest = held.keys().next().value as string | undefined;
    if (oldest) release(oldest);
  }
  const unsubs: Array<() => void> = [];
  const warm = (
    q: Parameters<ConvexReactClient["watchQuery"]>[0],
    args: Record<string, unknown>,
  ) => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: generic query-ref warming
      const w = client.watchQuery(q as any, args as any);
      unsubs.push(w.onUpdate(() => {}));
    } catch {}
  };
  warm(api.chat.threads.get, { threadId });
  warm(api.chat.stream.active, { threadId });
  warm(api.chat.messages.listPaged, {
    threadId,
    paginationOpts: { numItems: 30, cursor: null },
  });
  held.set(threadId, {
    unsubs,
    timer: setTimeout(() => release(threadId), TTL_MS),
  });
}

/** Drop a thread's warm subs once its own components have taken over. */
export function releasePrefetch(threadId: string): void {
  release(threadId);
}
