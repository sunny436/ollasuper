"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useChatSession } from "../_hooks/use-chat-session";
import { useReveal } from "../_hooks/use-reveal";
import { useStickToBottom } from "../_hooks/use-stick-to-bottom";
import { useThrottledValue } from "../_hooks/use-throttled-value";
import { ChatMessage, type ChatMessageDoc } from "./chat-message";
import { MessageSkeleton } from "./message-skeleton";
import { ScrollToBottom } from "./scroll-to-bottom";

const PAGE = 30;

export function MessageList({ threadId }: { threadId: string | null }) {
  const { setStreamingId } = useChatSession();
  const [editing, setEditing] = useState<ChatMessageDoc | null>(null);
  const editMessage = useMutation(api.chat.messages.editUserMessage);

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

  const liveTextRaw = useMemo(() => {
    if (!live) return "";
    const chunks = [...live.chunks].sort((a, b) => a.seq - b.seq);
    return live.committedText + chunks.map((c) => c.text).join("");
  }, [live]);

  // ~16 updates/sec: below the threshold where text reads as stalling, and
  // 3-5x fewer renders than the raw delta rate.
  const liveText = useThrottledValue(liveTextRaw, 60);

  const settled = useMemo(() => {
    // listPaged is newest-first for backwards pagination; display oldest-first.
    return [...(results ?? [])].reverse() as unknown as ChatMessageDoc[];
  }, [results]);

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
  const { scrollerRef, sentinelRef, atBottom, hasNew, scrollToBottom } =
    useStickToBottom([revealed, settled.length, threadId]);

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

  const loadingFirst = threadId !== null && status === "LoadingFirstPage";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        // overflow-anchor:none — browser scroll anchoring silently adjusts
        // scrollTop to keep an anchor node stationary, which fights the manual
        // pin during streaming and produces 1-3px jitter per token.
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
      >
        <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
          {loadingFirst && (
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
                onClick={() => loadMore(PAGE)}
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
            />
          ))}

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
                  model: live.model,
                  createdAt: live.startedAt,
                } as ChatMessageDoc
              }
              isStreaming
              liveText={revealed}
              // The orb is a live WebGL context and browsers cap those (~16
              // before the oldest get dropped), so exactly one exists: on the
              // turn being generated. Settled turns keep the flat glyph.
              showOrb
            />
          )}

          <div ref={sentinelRef} className="h-px w-full" />
        </div>
      </div>

      <div className="relative">
        <ScrollToBottom
          visible={!atBottom}
          hasNew={hasNew}
          onClick={scrollToBottom}
        />
      </div>
    </div>
  );
}
