"use client";

import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@v1/ui/dialog";
import { useConvex, useQuery } from "convex/react";
import { Loader2, MessageSquare, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  cancelPrefetch,
  prefetchThread,
  prefetchThreadNow,
} from "../_lib/prefetch";

/**
 * "Search chats" — the icon beside the logo and the modal it opens.
 *
 * The search itself is the existing server query `chat.search.combined`
 * (title + message full-text, pinned to the caller's userId, archived and
 * deleted chats excluded). Nothing is filtered client-side: the rail only ever
 * holds the first pages of titles.
 */

const DEBOUNCE_MS = 200;
/** The server returns nothing below this, so do not even subscribe. */
const MIN_QUERY = 2;
const RECENT = 8;

export interface RecentChat {
  _id: Id<"chatThreads">;
  title: string;
}

interface Item {
  id: Id<"chatThreads">;
  title: string;
  snippet: string | null;
}

type Hit = {
  threadId: Id<"chatThreads">;
  title: string;
  snippet: string | null;
};

function isModifiedClick(e: ReactMouseEvent) {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

export function SearchChats({
  recent,
  onNavigate,
}: {
  recent: RecentChat[];
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Search chats"
          title="Search chats"
          // Same size and tone as the notification bell. On touch the target
          // grows to 44px; the negative margin keeps the header height fixed.
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-primary/65 transition hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:-my-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
        >
          <Search className="h-4 w-4" />
        </button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        // The mobile drawer closes on ANY Escape through a window listener
        // (workspace-rail.tsx). Radix handles Escape on document in the capture
        // phase, so stopping it here closes this modal and leaves the drawer.
        onEscapeKeyDown={(e) => e.stopPropagation()}
        // Portalled to <body>, so it re-enters the workspace palette itself.
        // Top-anchored rather than centred, so the box does not jump as results
        // arrive; the result list is the only scroller.
        className="workspace top-[calc(1rem+env(safe-area-inset-top))] flex max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] translate-y-0 flex-col gap-0 overflow-hidden rounded-xl p-0 sm:top-[12vh] sm:max-h-[min(34rem,76dvh)] sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Search chats</DialogTitle>
        <SearchPanel
          recent={recent}
          onPick={() => {
            setOpen(false);
            onNavigate?.();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Module scope, never nested inside SearchChats: a nested component is a new
 * type on every render, which remounts the input and steals its focus.
 * Mounted only while the dialog is open, so a closed dialog holds no
 * subscription and every open starts clean.
 */
function SearchPanel({
  recent,
  onPick,
}: {
  recent: RecentChat[];
  onPick: () => void;
}) {
  const router = useRouter();
  const convex = useConvex();
  const { current } = useWorkspace();
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Keeps the previous answer on screen while the next one loads, so typing
  // never flashes the list empty.
  const [shown, setShown] = useState<Hit[]>([]);
  // IME: isComposing alone is not enough — same guard as the composer
  // (chat-input.tsx), so committing a CJK candidate never opens a chat.
  const composing = useRef(false);
  const composedAt = useRef(0);

  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [text]);

  const searching = query.length >= MIN_QUERY;
  const results = useQuery(
    api.chat.search.combined,
    current && searching ? { workspaceId: current, query } : "skip",
  );
  useEffect(() => {
    if (results) setShown(results);
  }, [results]);

  const loading = searching && results === undefined;
  const items: Item[] = searching
    ? (results ?? shown).map((h) => ({
        id: h.threadId,
        title: h.title,
        snippet: h.snippet,
      }))
    : recent
        .slice(0, RECENT)
        .map((t) => ({ id: t._id, title: t.title, snippet: null }));
  // Clamped at read time: the list can shrink under the highlight, and an
  // arrow press on an empty list must not leave it at -1 for the next results.
  const idx = items.length
    ? Math.min(Math.max(active, 0), items.length - 1)
    : -1;

  useEffect(() => {
    if (idx < 0) return;
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  function openChat(id: Id<"chatThreads">) {
    prefetchThreadNow(convex, id);
    router.push(`/chat/${id}`);
    onPick();
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (composing.current || performance.now() - composedAt.current < 40)
        return;
      const it = items[idx];
      if (!it) return;
      e.preventDefault();
      openChat(it.id);
    }
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border py-3 pl-4 pr-12">
        <Search
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-muted-foreground"
        />
        <input
          type="text"
          role="combobox"
          aria-label="Search chats"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items[idx] ? `${listId}-${idx}` : undefined}
          placeholder="Search chats…"
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            if (e.target.value.trim().length < MIN_QUERY) setShown([]);
          }}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
            composedAt.current = performance.now();
          }}
          className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-muted-foreground"
        />
        {loading && (
          <Loader2
            aria-hidden="true"
            className="h-4 w-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        )}
      </div>

      <div
        ref={listRef}
        className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        {!searching && items.length > 0 && (
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recent chats
          </p>
        )}
        <div
          id={listId}
          role="listbox"
          aria-label={searching ? "Search results" : "Recent chats"}
        >
          {items.map((it, i) => (
            <Link
              key={it.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === idx}
              // The listbox pattern: arrows move the highlight, Tab does not
              // stop on every result. Still a real link for middle/ctrl-click.
              tabIndex={-1}
              href={`/chat/${it.id}`}
              prefetch={false}
              onClick={(e) => {
                if (isModifiedClick(e)) return;
                prefetchThreadNow(convex, it.id);
                onPick();
              }}
              onPointerMove={() => {
                if (i !== idx) setActive(i);
              }}
              onPointerEnter={() => prefetchThread(convex, it.id, router)}
              onPointerLeave={() => cancelPrefetch(it.id)}
              className={`flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                i === idx ? "bg-accent text-primary" : "text-muted-foreground"
              }`}
            >
              <MessageSquare
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{it.title}</span>
                {it.snippet && (
                  <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                    {it.snippet}
                  </span>
                )}
              </span>
            </Link>
          ))}
        </div>

        {searching && !loading && items.length === 0 && (
          <p className="px-2.5 py-6 text-center text-sm text-muted-foreground">
            No chats found
          </p>
        )}
        {loading && items.length === 0 && (
          <p className="px-2.5 py-6 text-center text-sm text-muted-foreground">
            Searching…
          </p>
        )}
        {!searching && items.length === 0 && (
          <p className="px-2.5 py-6 text-center text-sm text-muted-foreground">
            Search your chats by title or message
          </p>
        )}
        <p className="sr-only" role="status">
          {searching && !loading
            ? `${items.length} ${items.length === 1 ? "chat" : "chats"} found`
            : ""}
        </p>
      </div>
    </>
  );
}
