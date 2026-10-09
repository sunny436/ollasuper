"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useCachedTranscript } from "../_hooks/use-cached-transcript";
import { useChatSession } from "../_hooks/use-chat-session";
import { useReveal } from "../_hooks/use-reveal";
import { useStickToBottom } from "../_hooks/use-stick-to-bottom";
import { useThrottledValue } from "../_hooks/use-throttled-value";
import {
  type EventAcc,
  accumulateEvents,
  afterSeqFor,
} from "../_lib/stream-events";
import { type Accumulated, accumulate, needsCommitted } from "../_lib/stream-text";
import { ChatMessage, type ChatMessageDoc } from "./chat-message";
import { ShareDialog } from "./share-dialog";
import { preloadMarkdown } from "./lazy-markdown";
import { MessageSkeleton } from "./message-skeleton";
import { ScrollToBottom } from "./scroll-to-bottom";

const PAGE = 30;

export function MessageList({ threadId }: { threadId: string | null }) {
  const { setStreamingId, pendingUsers, setPendingUsers } = useChatSession();
  const [editing, setEditing] = useState<ChatMessageDoc | null>(null);
  const [shareMsgId, setShareMsgId] = useState<Id<"chatMessages"> | null>(null);
  const editMessage = useMutation(api.chat.messages.editUserMessage);
  const resolveApproval = useMutation(api.chat.approvals.resolve);

  const {
    results,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.chat.messages.listPaged,
    threadId ? { threadId } : "skip",
    { initialNumItems: PAGE },
  );

  // Separate, tiny subscription for the in-flight reply. listPaged excludes
  // in-flight rows on purpose: Convex returns fresh object identities on every
  // push, so if the streaming row lived in that array every token would
  // invalidate the whole page and re-render every message in the thread.
  const live = useQuery(
    api.chat.stream.active,
    threadId ? { threadId } : "skip",
  );

  // The text is accumulated HERE, from the resident chunks each push carries
  // (see _lib/stream-text.ts): the query no longer re-sends the whole answer
  // per delta. The committed prefix is fetched only while this subscriber is
  // missing it — a mid-stream mount, reload or reconnect — then dropped.
  const accRef = useRef<Accumulated | null>(null);
  const gap = needsCommitted(accRef.current, live);
  const committed = useQuery(
    api.chat.stream.committed,
    gap && live ? { messageId: live.messageId } : "skip",
  );
  const liveTextRaw = useMemo(() => {
    const next = accumulate(accRef.current, live, committed);
    accRef.current = next;
    return next?.text ?? "";
  }, [live, committed]);
  // Typed events ride their own subscription, which re-fires on append rather
  // than on every text delta (and only when the turn has any) — and carries
  // only what is ABOVE the high-water mark, with the rest kept here. Sending
  // the whole timeline per append made a tool turn quadratic: 47,406 bytes over
  // 16 pushes for a 733-character answer, 43% of that turn's socket traffic.
  // See _lib/stream-events.ts for why a swap of `afterSeq` cannot drop one.
  const eventsAccRef = useRef<EventAcc | null>(null);
  const liveMessageId = live?.messageId ?? null;
  const afterSeq = afterSeqFor(eventsAccRef.current, liveMessageId);
  const liveEventsPage = useQuery(
    api.chat.stream.events,
    live?.hasEvents
      ? afterSeq === undefined
        ? { messageId: live.messageId }
        : { messageId: live.messageId, afterSeq }
      : "skip",
  );
  const liveEvents = useMemo(() => {
    const next = accumulateEvents(
      eventsAccRef.current,
      liveMessageId,
      liveEventsPage,
    );
    eventsAccRef.current = next;
    // undefined, not [], when the turn has none — the timeline's existing
    // contract, so nothing downstream changes.
    return next && next.events.length > 0 ? next.events : undefined;
  }, [liveMessageId, liveEventsPage]);

  // ~16 updates/sec: below the threshold where text reads as stalling, and
  // 3-5x fewer renders than the raw delta rate.
  const liveText = useThrottledValue(liveTextRaw, 60);

  const settledLive = useMemo(() => {
    // listPaged is newest-first for backwards pagination; display oldest-first.
    return [...(results ?? [])].reverse() as unknown as ChatMessageDoc[];
  }, [results]);

  // Instant on reload: seed the transcript from localStorage while the first
  // page reconnects (~2-3s cold), then hand off to live the moment it lands.
  // Seeds only when the cache is for THIS thread and the first page is still
  // loading; never caches or touches the in-flight row.
  const loadingFirst = threadId !== null && status === "LoadingFirstPage";
  const settled = useCachedTranscript(threadId, settledLive, loadingFirst);

  // Optimistic user rows: shown the instant a message is sent, dropped the
  // moment their settled twin (same clientId) lands in listPaged. The
  // render-time filter — not just the prune effect below — is what prevents a
  // one-frame duplicate bubble during the handoff.
  const settledClientIds = useMemo(
    () =>
      new Set(
        settled.map((m) => m.clientId).filter(Boolean) as string[],
      ),
    [settled],
  );
  const pendingToShow = useMemo(
    () =>
      pendingUsers.filter(
        (p) => p.threadId === threadId && !settledClientIds.has(p.clientId),
      ),
    [pendingUsers, settledClientIds, threadId],
  );

  // Drop this thread's settled twins from the shared pending list. Only ever
  // removes rows for THIS thread (another thread's MessageList prunes its own),
  // and is guarded so it writes only when something actually settled.
  useEffect(() => {
    if (pendingUsers.length === 0) return;
    const next = pendingUsers.filter(
      (p) => p.threadId !== threadId || !settledClientIds.has(p.clientId),
    );
    if (next.length !== pendingUsers.length) setPendingUsers(next);
  }, [pendingUsers, settledClientIds, threadId, setPendingUsers]);

  // The markdown renderer is a lazy chunk (kept out of /chat's first-load so the
  // empty landing hydrates faster). Preload it only when a transcript ACTUALLY has
  // messages — so settled messages never show the raw-text fallback. An EMPTY chat
  // no longer idle-preloads it (that competed with composer readiness); it warms
  // instead on composer focus and at the top of a send (see chat-input.tsx).
  useEffect(() => {
    if (settled.length > 0) void preloadMarkdown();
  }, [settled.length]);

  const streamingId = (live?.messageId as Id<"chatMessages"> | undefined) ?? null;
  // Published so the composer — which now lives above this route segment — can
  // swap Send for Stop. An effect, not a memo: this is a side effect on shared
  // state, and useMemo is not guaranteed to run when React discards its cache.
  useEffect(() => {
    setStreamingId(streamingId);
  }, [streamingId, setStreamingId]);

  // Smooth the arrival of tokens. See use-reveal.ts for why this converges on
  // the backlog rather than running at a fixed chars/sec.
  const revealed = useReveal(liveText, streamingId !== null);

  // Keyed on the REVEALED text, not liveText: the scroller has to follow what
  // is actually painted, or it pins to a height the reader cannot see yet.
  const { scrollerRef, atBottom, hasNew, scrollToBottom, anchorForPrepend } =
    useStickToBottom([revealed, settled.length, threadId]);

  // Sending is an explicit "bring me to my message" intent: re-engage the pin
  // and reveal the optimistic row the instant it appears.
  const pendingShownCount = pendingToShow.length;
  useEffect(() => {
    if (pendingShownCount > 0) scrollToBottom();
  }, [pendingShownCount, scrollToBottom]);

  // Preserve the reader's position across a "Load earlier" prepend. anchor is
  // captured on click (before the fetch); the closure runs once the older page
  // has rendered — detected by the OLDEST message (settled[0]) changing, which
  // only a prepend does, so an append at the bottom never triggers it.
  const prependRestore = useRef<(() => void) | null>(null);
  const onLoadEarlier = useCallback(() => {
    prependRestore.current = anchorForPrepend();
    loadMore(PAGE);
  }, [anchorForPrepend, loadMore]);
  const oldestId = settled[0]?._id ?? null;
  useLayoutEffect(() => {
    if (prependRestore.current) {
      prependRestore.current();
      prependRestore.current = null;
    }
  }, [oldestId]);

  const onEdit = useCallback(
    async (m: ChatMessageDoc) => {
      const next = window.prompt("Edit your message", m.content);
      if (next === null || !next.trim() || next === m.content) return;
      setEditing(m);
      try {
        await editMessage({
          messageId: m._id,
          content: next,
          clientId: crypto.randomUUID(),
        });
      } catch {
        toast.error("Couldn't edit that message");
      } finally {
        setEditing(null);
      }
    },
    [editMessage],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        // Focusable and named so the transcript can be scrolled from the keyboard
        // (axe scrollable-region-focusable, found on prod by e2e/qa-responsive.js).
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-reachable (WCAG 2.1.1)
        tabIndex={0}
        role="region"
        aria-label="Conversation"
        // overflow-anchor:none — browser scroll anchoring silently adjusts
        // scrollTop to keep an anchor node stationary, which fights the manual
        // pin during streaming and produces 1-3px jitter per token.
        //
        // scrollbar-gutter both-edges, once the pane is wide enough that the
        // column is capped (from 50rem): the scrollbar's gutter is mirrored on the
        // left, so the transcript centres on the same axis as the composer, which
        // has no scrollbar — they were 4px off (half an 8px bar). Not below 50rem:
        // there the column is the full width, and a second gutter only narrows it.
        className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none] [@container(min-width:50rem)]:[scrollbar-gutter:stable_both-edges]"
      >
        {/*
          overflow-wrap is INHERITED, and it is set here rather than per renderer:
          measured on production, a bare URL rendered as a link inside a list item
          — the shape of every research answer's source list — could not break, so
          the transcript scrolled sideways to 892 px against a 390 px viewport
          (WebKit/iOS). Only markdown's `p` set break-words; li, ol, headings,
          blockquote, cells, agent activity, sources and approval cards set
          nothing. One declaration here covers all of them.

          break-word, NOT anywhere: `anywhere` also shrinks min-content, which
          would make wide tables wrap instead of scroll inside their wrapper.
        */}
        <div className="mx-auto w-full max-w-content px-4 py-6 [overflow-wrap:break-word] md:px-6">
          {loadingFirst && settled.length === 0 && pendingToShow.length === 0 && (
            <>
              <MessageSkeleton align="right" />
              <MessageSkeleton />
              <MessageSkeleton align="right" />
            </>
          )}

          {status === "CanLoadMore" && (
            <div className="mb-4 flex justify-center">
              <button
                type="button"
                onClick={onLoadEarlier}
                className="rounded-full border border-border px-3 py-1 text-xs text-primary/60 transition hover:bg-primary/5"
              >
                Load earlier messages
              </button>
            </div>
          )}

          {settled.map((m) => (
            <ChatMessage
              key={m._id}
              message={m}
              isStreaming={false}
              onEdit={m.role === "user" && !editing ? onEdit : undefined}
              onShare={setShareMsgId}
            />
          ))}

          {pendingToShow.map((p) => (
            <ChatMessage
              key={`pending-${p.clientId}`}
              message={
                {
                  _id: `pending-${p.clientId}` as Id<"chatMessages">,
                  role: "user",
                  // After every settled row so it always sorts to the bottom.
                  seq: Number.MAX_SAFE_INTEGER,
                  content: p.text,
                  status: "complete",
                  clientId: p.clientId,
                  createdAt: p.createdAt,
                } as ChatMessageDoc
              }
              isStreaming={false}
            />
          ))}

          {pendingToShow.length > 0 && !live && (
            <ChatMessage
              key="pending-assistant"
              message={
                {
                  _id: "pending-assistant" as Id<"chatMessages">,
                  role: "assistant",
                  seq: Number.MAX_SAFE_INTEGER,
                  content: "",
                  status: "streaming",
                  createdAt: Date.now(),
                } as ChatMessageDoc
              }
              isStreaming
              liveText=""
            />
          )}

          {live && streamingId && (
            <ChatMessage
              key={streamingId}
              message={
                {
                  _id: streamingId,
                  role: "assistant",
                  seq: live.seq,
                  content: revealed,
                  status: "streaming",
                  // Live typed events (Phase 3) — empty for normal text turns.
                  events: liveEvents ?? undefined,
                  createdAt: live.startedAt,
                } as ChatMessageDoc
              }
              isStreaming
              liveText={revealed}
              pendingApprovals={live.pendingApprovals}
              onResolveApproval={(approvalId, decision) => {
                resolveApproval({
                  approvalId: approvalId as Id<"chatApprovals">,
                  decision,
                }).catch(() => {
                  toast.error("Couldn't submit your decision");
                });
              }}
            />
          )}
        </div>
      </div>

      <div className="relative">
        <ScrollToBottom
          visible={!atBottom}
          hasNew={hasNew}
          onClick={scrollToBottom}
        />
      </div>

      <ShareDialog
        open={shareMsgId !== null}
        onOpenChange={(o) => {
          if (!o) setShareMsgId(null);
        }}
        params={
          shareMsgId ? { shareType: "single_turn", messageId: shareMsgId } : null
        }
      />
    </div>
  );
}
