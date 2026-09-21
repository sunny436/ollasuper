import { setPrefetchedTranscript } from "@/lib/display-cache";
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
 * listPaged: usePaginatedQuery keys its first page on a private per-mount id,
 * so the warmed subscription is NEVER the one the transcript reads — measured
 * on production, a hovered thread painted no sooner than an unhovered one and
 * the ~200 KB page crossed the wire twice. So the page this warm receives is
 * handed to use-cached-transcript through setPrefetchedTranscript, which seeds
 * the transcript from it while the paginated query is still loading, the same
 * way the localStorage copy seeds a reload.
 *
 * Held subscriptions are bounded: a TTL releases them, and an LRU cap keeps at
 * most MAX warm at once, so hovering the whole rail never leaks subscriptions.
 *
 * INTENT, NOT CONTACT: the fetch starts only after the pointer has rested on a
 * row for INTENT_MS (cancelled on leave/blur). A sweep down the rail used to
 * fire a prefetch per row — measured at ~600 KB over the socket for ten rows
 * in under a second, competing with the click that followed. On a
 * data-saver / 2G connection the transcript warm is skipped entirely; the two
 * small warms (thread meta, stream) are kept.
 */
const TTL_MS = 20_000;
const MAX = 6;
const INTENT_MS = 150;
const PAGE = 30;

const pending = new Map<string, ReturnType<typeof setTimeout>>();

function constrained(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
    .connection;
  return !!c && (c.saveData === true || c.effectiveType === "slow-2g" || c.effectiveType === "2g");
}

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

/** Arm a prefetch; it fires after INTENT_MS unless cancelPrefetch is called. */
export function prefetchThread(
  client: ConvexReactClient,
  threadId: string,
): void {
  if (held.has(threadId) || pending.has(threadId)) return; // already warm / armed
  pending.set(
    threadId,
    setTimeout(() => {
      pending.delete(threadId);
      warmThread(client, threadId);
    }, INTENT_MS),
  );
}

/** The pointer left before INTENT_MS: nothing is fetched. */
export function cancelPrefetch(threadId: string): void {
  const t = pending.get(threadId);
  if (t === undefined) return;
  clearTimeout(t);
  pending.delete(threadId);
}

function warmThread(client: ConvexReactClient, threadId: string): void {
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
  if (!constrained()) {
    try {
      const w = client.watchQuery(api.chat.messages.listPaged, {
        threadId,
        paginationOpts: { numItems: PAGE, cursor: null },
      });
      unsubs.push(
        w.onUpdate(() => {
          // localQueryResult() THROWS when the subscription is in an error
          // state — e.g. the row was hovered and then deleted, so the held
          // subscription re-ran listPaged on a thread that no longer exists
          // ("Not found"). The no-op callback this replaced never observed
          // that; an uncaught throw here is a console error in a flow that is
          // perfectly normal. No seed for that thread is the right outcome.
          let page: ReturnType<typeof w.localQueryResult>;
          try {
            page = w.localQueryResult();
          } catch {
            return;
          }
          // listPaged is newest-first; the transcript displays oldest-first —
          // the same reversal message-list.tsx applies to the live result.
          if (page) setPrefetchedTranscript(threadId, [...page.page].reverse());
        }),
      );
    } catch {}
  }
  held.set(threadId, {
    unsubs,
    timer: setTimeout(() => release(threadId), TTL_MS),
  });
}

/** Drop a thread's warm subs once its own components have taken over. */
export function releasePrefetch(threadId: string): void {
  cancelPrefetch(threadId);
  release(threadId);
}
