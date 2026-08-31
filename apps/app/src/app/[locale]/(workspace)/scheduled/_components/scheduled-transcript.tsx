"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { usePaginatedQuery } from "convex/react";
import {
  ChatMessage,
  type ChatMessageDoc,
} from "../../chat/_components/chat-message";

/**
 * The task's execution transcript, read-only.
 *
 * This is what "Open chat" opens, and it deliberately does NOT route into
 * /chat: Phase 2 hides scheduled threads from the conversation list, and
 * dropping the user into the chat shell would give them a composer whose sends
 * the backend refuses.
 *
 * Deliberately does NOT reuse MessageList either — that component depends on
 * useChatSession, the stick-to-bottom controller, the cached transcript and the
 * edit/approval mutations, none of which exist outside ChatShell. Rendering
 * ChatMessage directly keeps the identical look with no send path at all.
 */
export function ScheduledTranscript({ taskId }: { taskId: string }) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.scheduled.tasks.transcript,
    { taskId: taskId as Id<"scheduledTasks"> },
    { initialNumItems: 20 },
  );

  if (status === "LoadingFirstPage") {
    return (
      <div className="space-y-2" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-4 animate-pulse rounded bg-primary/5" />
        ))}
      </div>
    );
  }
  if (!results.length) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        This task has not run yet.
      </p>
    );
  }

  // The query pages newest-first; display oldest-first like a conversation.
  const ordered = [...results].reverse();

  return (
    <div>
      {status === "CanLoadMore" && (
        <button
          type="button"
          onClick={() => loadMore(20)}
          className="mb-3 w-full rounded-lg border border-border py-1.5 text-xs text-primary/60 transition hover:bg-accent"
        >
          Load earlier runs
        </button>
      )}
      {ordered.map((m) => (
        <ChatMessage
          key={m._id}
          message={m as unknown as ChatMessageDoc}
          isStreaming={false}
          readOnly
        />
      ))}
    </div>
  );
}
