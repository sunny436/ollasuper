"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useStickToBottom } from "../_hooks/use-stick-to-bottom";
import { useThrottledValue } from "../_hooks/use-throttled-value";
import { EmptyState } from "./empty-state";
import { type ChatMessage, MessageBubble } from "./message-bubble";
import { MessageSkeleton } from "./message-skeleton";
import { ScrollToBottom } from "./scroll-to-bottom";

const PAGE = 30;

export function MessageList({
  threadId,
  onStreamingChange,
}: {
  threadId: string | null;
  onStreamingChange: (id: Id<"chatMessages"> | null) => void;
}) {
  const [editing, setEditing] = useState<ChatMessage | null>(null);
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
    return [...(results ?? [])].reverse() as unknown as ChatMessage[];
  }, [results]);

  const streamingId = (live?.messageId as Id<"chatMessages"> | undefined) ?? null;
  // Report upward so the composer can swap Send for Stop. An effect, not a
  // memo: this is a side effect on the parent, and useMemo is not guaranteed
  // to run when React decides to discard the memo cache.
  useEffect(() => {
    onStreamingChange(streamingId);
  }, [streamingId, onStreamingChange]);

  const { scrollerRef, sentinelRef, atBottom, hasNew, scrollToBottom } =
    useStickToBottom([liveText, settled.length, threadId]);

  const onEdit = useCallback(
    async (m: ChatMessage) => {
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
  const isEmpty = !loadingFirst && settled.length === 0 && !live;

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

          {isEmpty && <EmptyState threadId={threadId} />}

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
            <MessageBubble
              key={m._id}
              message={m}
              isStreaming={false}
              onEdit={m.role === "user" && !editing ? onEdit : undefined}
            />
          ))}

          {live && streamingId && (
            <MessageBubble
              key={streamingId}
              message={
                {
                  _id: streamingId,
                  role: "assistant",
                  seq: live.seq,
                  content: liveText,
                  status: "streaming",
                  model: live.model,
                  createdAt: live.startedAt,
                } as ChatMessage
              }
              isStreaming
              liveText={liveText}
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
