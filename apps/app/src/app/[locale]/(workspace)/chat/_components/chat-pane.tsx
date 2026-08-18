"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_MODEL } from "../_lib/models";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { useChatSidebar } from "./chat-shell";

export function ChatPane({ threadId }: { threadId: string | null }) {
  const [streamingId, setStreamingId] = useState<Id<"chatMessages"> | null>(
    null,
  );
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const { openSidebar, collapsed, toggleCollapsed } = useChatSidebar();

  // threadId is a raw URL string, so this query takes v.string() and
  // normalizeId's it server-side. Returns null for a bad or foreign id.
  const thread = useQuery(
    api.chat.threads.get,
    threadId ? { threadId } : "skip",
  );

  useEffect(() => {
    if (thread?.model) setModel(thread.model);
  }, [thread?.model]);

  const onStreamingChange = useCallback(
    (id: Id<"chatMessages"> | null) => setStreamingId(id),
    [],
  );

  // A bad/deleted thread id renders inline. Deliberately NOT notFound(): that
  // renders [locale]/not-found.tsx and destroys the whole chat shell.
  const notFound = threadId !== null && thread === null;

  // ComposerProvider is hoisted to ChatShell — the prompt library in the
  // conversation sidebar is a sibling of this pane and shares the same draft.
  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/*
        The workspace header. Always present now, not xl:hidden — with the app
        topbar gone this is the only chrome above the transcript.

        Two buttons, never both visible: below md the rail is a drawer, so the
        control opens it; from md up the rail is docked, so the control toggles
        the dock. They are separate elements rather than one with a switched
        handler because the accessible name has to differ, and Playwright's
        name matcher is substring-based — a label of `Close conversations`
        would collide with the prompt library's `Close` button and throw on
        strict mode. Hence `Hide`.
      */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card/50 px-4 backdrop-blur-xl">
        <button
          type="button"
          onClick={openSidebar}
          aria-label="Open conversations"
          className="rounded-lg border border-border p-2 text-primary/60 transition hover:bg-primary/5 hover:text-primary md:hidden"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Open conversations" : "Hide conversations"}
          className="hidden rounded-lg border border-border p-2 text-primary/60 transition hover:bg-primary/5 hover:text-primary md:block"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </button>

        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span className="hidden text-primary/45 sm:inline">Ollasuper</span>
          <span className="hidden text-primary/25 sm:inline">/</span>
          <span className="truncate font-medium text-primary/85">
            {thread?.title ?? "AI Workspace"}
          </span>
        </div>
      </header>

      {notFound ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <div className="text-center">
            <p className="text-sm text-primary/70">Conversation not found</p>
            <a
              href="/chat"
              className="mt-2 inline-block text-xs text-brand-ink hover:underline"
            >
              ← All conversations
            </a>
          </div>
        </div>
      ) : (
        <>
          <MessageList
            threadId={threadId}
            onStreamingChange={onStreamingChange}
          />
          {/*
              Inside the guard, not beside it. A composer rendered next to
              "Conversation not found" still holds the bad URL string, and
              sending would hand it to a v.id() validator — an
              ArgumentValidationError that the Convex client reports through
              console.error, which fails every e2e script's zero-console-error
              assertion. Offering a send button that cannot work is also just
              a lie about what the UI does.
            */}
          <Composer
            threadId={threadId}
            streamingMessageId={streamingId}
            model={model}
            onModelChange={setModel}
          />
        </>
      )}
    </section>
  );
}
