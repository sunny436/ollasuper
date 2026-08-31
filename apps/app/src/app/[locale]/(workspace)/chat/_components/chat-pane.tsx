"use client";

import { api } from "@v1/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import { ChevronRight, PanelLeft, Share2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useChatSession } from "../_hooks/use-chat-session";
import { MessageList } from "./message-list";
import { useChatSidebar } from "./chat-shell";
import { AmbienceSlider } from "./ambience-slider";
import { ShareDialog } from "./share-dialog";
import { NotificationsBell } from "../../../(dashboard)/_components/notifications-bell";

export function ChatPane({ threadId }: { threadId: string | null }) {
  const { openSidebar, collapsed, toggleCollapsed } = useChatSidebar();
  const { setThreadStatus, setModel } = useChatSession();
  const [shareOpen, setShareOpen] = useState(false);

  // threadId is a raw URL string, so this query takes v.string() and
  // normalizeId's it server-side. Returns null for a bad or foreign id.
  const thread = useQuery(
    api.chat.threads.get,
    threadId ? { threadId } : "skip",
  );

  useEffect(() => {
    if (thread?.model) setModel(thread.model);
  }, [thread?.model, setModel]);

  // The composer now lives above the route segment (chat-layout.tsx), so it
  // cannot see this query. Publish the outcome instead of making the shell run
  // a second copy of it: "notfound" is what withholds the composer, and
  // use-send-message.ts casts the id to Id<"chatThreads">, so letting someone
  // send with a bad URL id would throw ArgumentValidationError and fail every
  // e2e run on its zero-console-error assertion.
  useEffect(() => {
    if (threadId === null) setThreadStatus("none");
    else if (thread === undefined) setThreadStatus("loading");
    else if (thread === null) setThreadStatus("notfound");
    else setThreadStatus("ok");
  }, [threadId, thread, setThreadStatus]);

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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card/50 px-4 backdrop-blur-xl">
        <button
          type="button"
          onClick={openSidebar}
          aria-label="Open conversations"
          className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-primary md:hidden"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Open conversations" : "Hide conversations"}
          className="hidden rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-primary md:block"
        >
          <PanelLeft className="h-4 w-4" />
        </button>

        {/* Breadcrumb — Ollasuper › current conversation. */}
        <div className="flex min-w-0 items-center gap-1 text-sm">
          <Link
            href="/chat"
            className="hidden shrink-0 rounded-md px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-primary sm:inline-block"
          >
            Ollasuper
          </Link>
          <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-muted-foreground sm:block" />
          <span className="truncate px-1 font-semibold text-primary">
            {thread?.title ?? "AI Workspace"}
          </span>
        </div>

        {/* Share + Notifications + Ambience — top-right of the chat header.
            The bell sits between Share and the ambience (theme) control; it
            used to live at the foot of the conversation rail, which predates
            this header existing. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {thread && (
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              disabled={thread.isStreaming}
              aria-label="Share conversation"
              className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground shadow-sm transition-all hover:bg-accent hover:text-primary active:scale-95 disabled:opacity-40"
            >
              <Share2 className="h-3.5 w-3.5" /> Share
            </button>
          )}
          <NotificationsBell />
          <AmbienceSlider />
        </div>
      </header>

      {threadId && (
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          params={{ shareType: "full_chat", threadId }}
        />
      )}

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
        <MessageList threadId={threadId} />
      )}
    </section>
  );
}
