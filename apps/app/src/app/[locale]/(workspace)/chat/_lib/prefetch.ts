import { setPrefetchedTranscript } from "@/lib/display-cache";
import { api } from "@v1/backend/convex/_generated/api";
import type { ConvexReactClient } from "convex/react";
import { preloadMarkdown } from "../_components/lazy-markdown";

/** The one router method used here; `useRouter()` satisfies it. */
export type RoutePrefetcher = { prefetch: (href: string) => void };

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
 *
 * ROUTE, NOT ONLY DATA: the same intent also prefetches the /chat/[threadId]
 * route through the Next router (`router.prefetch` defaults to a FULL
 * prefetch, the same thing `<Link prefetch>` does; the rail's rows are
 * `prefetch={false}` because a full prefetch of every row in the viewport
 * would be ~70 requests). Without it a click still paid one RSC round trip
 * before the URL could change — 100 ms from the US, 260+ ms from India — even
 * though the page component is a one-liner. The markdown chunk rides along:
 * the first transcript of a session used to fetch it (and its helpers) after
 * the route committed, which put the first painted row ~450 ms (US) behind the
 * URL. Both are no-ops once warm.
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

type Held = {
  unsubs: Array<() => void>;
  timer: ReturnType<typeof setTimeout>;
  /** A transcript page is on its way and has not been handed over yet. */
  awaitingSeed: boolean;
  /** release() was asked for while the page was still in flight. */
  releaseOnSeed: boolean;
};
const held = new Map<string, Held>();

function release(threadId: string, force = false): void {
  const h = held.get(threadId);
  if (!h) return;
  // The route can become active BEFORE the warmed page lands — a tap starts
  // the warm at click time and the RSC round trip is often the shorter one.
  // Dropping the subscription here would throw the page away one round trip
  // before it could seed the transcript; keep it until it lands. The TTL
  // (force) still bounds it, so an answer that never comes cannot leak it.
  if (h.awaitingSeed && !force) {
    h.releaseOnSeed = true;
    return;
  }
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
  router?: RoutePrefetcher,
): void {
  if (held.has(threadId) || pending.has(threadId)) return; // already warm / armed
  pending.set(
    threadId,
    setTimeout(() => {
      pending.delete(threadId);
      warmThread(client, threadId);
      if (router) prefetchRouteNow(router, `/chat/${threadId}`);
      void preloadMarkdown().catch(() => {});
    }, INTENT_MS),
  );
}

/**
 * The click itself: no intent to wait for. A tap (no hover) or a keyboard
 * activation used to start the transcript's queries only once the new segment
 * mounted, i.e. one RSC round trip after the click; starting them here puts
 * that round trip and the data round trip in parallel. No-op if the hover
 * already warmed the thread.
 */
export function prefetchThreadNow(
  client: ConvexReactClient,
  threadId: string,
): void {
  cancelPrefetch(threadId);
  warmThread(client, threadId);
}

/**
 * Intent-gated route prefetch for the other in-app destinations that a
 * `<Link prefetch>` cannot cover: a `router.push` button (New chat) and
 * lists whose length is unbounded (project cards). Same INTENT_MS gate; a
 * warm entry is reused by the router for five minutes (staleTimes.static),
 * so this is at most one small RSC request per destination per five minutes.
 */
const routePending = new Map<string, ReturnType<typeof setTimeout>>();
const routeWarm = new Map<string, number>();
const ROUTE_WARM_MS = 5 * 60_000;

function prefetchRouteNow(router: RoutePrefetcher, href: string): void {
  const at = routeWarm.get(href);
  if (at !== undefined && Date.now() - at < ROUTE_WARM_MS) return;
  routeWarm.set(href, Date.now());
  try {
    router.prefetch(href);
  } catch {}
}

export function prefetchRoute(router: RoutePrefetcher, href: string): void {
  if (routePending.has(href)) return;
  routePending.set(
    href,
    setTimeout(() => {
      routePending.delete(href);
      prefetchRouteNow(router, href);
    }, INTENT_MS),
  );
}

export function cancelRoutePrefetch(href: string): void {
  const t = routePending.get(href);
  if (t === undefined) return;
  clearTimeout(t);
  routePending.delete(href);
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
    if (oldest) release(oldest, true); // the bound wins over a late seed
  }
  const unsubs: Array<() => void> = [];
  const entry: Held = {
    unsubs,
    timer: setTimeout(() => release(threadId, true), TTL_MS),
    awaitingSeed: false,
    releaseOnSeed: false,
  };
  const seeded = () => {
    entry.awaitingSeed = false;
    if (entry.releaseOnSeed) release(threadId);
  };
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
      entry.awaitingSeed = true;
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
            seeded(); // nothing will ever land for this one
            return;
          }
          // listPaged is newest-first; the transcript displays oldest-first —
          // the same reversal message-list.tsx applies to the live result.
          if (page) {
            setPrefetchedTranscript(threadId, [...page.page].reverse());
            seeded();
          }
        }),
      );
    } catch {
      entry.awaitingSeed = false;
    }
  }
  held.set(threadId, entry);
}

/** Drop a thread's warm subs once its own components have taken over. */
export function releasePrefetch(threadId: string): void {
  cancelPrefetch(threadId);
  release(threadId);
}
