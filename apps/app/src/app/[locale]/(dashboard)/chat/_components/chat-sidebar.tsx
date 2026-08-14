"use client";

import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, usePaginatedQuery } from "convex/react";
import {
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { timeBucket } from "../_lib/format";

const PAGE = 30;

interface ThreadItem {
  _id: Id<"chatThreads">;
  title: string;
  pinned: boolean;
  folderId: Id<"chatFolders"> | null;
  updatedAt: number;
  isStreaming: boolean;
}

export function ChatSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const params = useParams<{ threadId?: string }>();
  const activeId = params?.threadId ?? null;
  const { current } = useWorkspace();
  const [query, setQuery] = useState("");

  const createThread = useMutation(api.chat.threads.create);
  const createFolder = useMutation(api.chat.folders.create);
  const renameThread = useMutation(api.chat.threads.rename);
  const removeThread = useMutation(api.chat.threads.remove);
  const setPinned = useMutation(api.chat.threads.setPinned);

  const { results, status, loadMore } = usePaginatedQuery(
    api.chat.threads.list,
    current ? { workspaceId: current } : "skip",
    { initialNumItems: PAGE },
  );

  const threads = (results ?? []) as unknown as ThreadItem[];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((t) => t.title.toLowerCase().includes(q));
  }, [threads, query]);

  // Pinned first, then bucketed by recency the way ChatGPT does it.
  const groups = useMemo(() => {
    const pinned = filtered.filter((t) => t.pinned);
    const rest = filtered.filter((t) => !t.pinned);
    const out: { label: string; items: ThreadItem[] }[] = [];
    if (pinned.length) out.push({ label: "Pinned", items: pinned });
    const byBucket = new Map<string, ThreadItem[]>();
    for (const t of rest) {
      const b = timeBucket(t.updatedAt);
      const arr = byBucket.get(b);
      if (arr) arr.push(t);
      else byBucket.set(b, [t]);
    }
    for (const [label, items] of byBucket) out.push({ label, items });
    return out;
  }, [filtered]);

  const guard = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
    } catch {
      toast.error(msg);
    }
  };

  const onNewChat = async () => {
    if (!current) return;
    // Navigating to a fresh /chat is enough — the thread is created on the
    // first send, so an abandoned "New chat" never leaves an empty row.
    router.push("/chat");
    onNavigate?.();
  };

  const onNewFolder = async () => {
    if (!current) return;
    const name = window.prompt("Folder name");
    if (!name?.trim()) return;
    await guard(
      () => createFolder({ workspaceId: current, name }),
      "Couldn't create that folder",
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <button
          type="button"
          onClick={() => void onNewChat()}
          className="flex flex-1 items-center gap-2 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-foreground transition hover:brightness-110"
        >
          <Plus className="h-4 w-4" />
          New chat
        </button>
        <button
          type="button"
          onClick={() => void onNewFolder()}
          aria-label="New folder"
          title="New folder"
          className="rounded-lg border border-border p-2 text-primary/60 transition hover:bg-primary/5"
        >
          <FolderPlus className="h-4 w-4" />
        </button>
      </div>

      <div className="border-b border-border p-3">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-primary/35" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="w-full bg-transparent text-xs text-primary outline-none placeholder:text-primary/35"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {status === "LoadingFirstPage" && (
          <div className="space-y-1.5 px-1">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-8 animate-pulse rounded-md bg-primary/5" />
            ))}
          </div>
        )}

        {status !== "LoadingFirstPage" && filtered.length === 0 && (
          <div className="px-2 py-6 text-center">
            <p className="text-xs text-primary/50">
              {query ? `No conversations match “${query}”` : "No conversations yet"}
            </p>
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="mt-1 text-xs text-brand-ink hover:underline"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {groups.map((group) => (
          <div key={group.label} className="mb-3">
            <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-primary/35">
              {group.label}
            </p>
            {group.items.map((t) => {
              const active = activeId === t._id;
              return (
                <div
                  key={t._id}
                  className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition ${
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-primary/70 hover:bg-primary/5"
                  }`}
                >
                  <Link
                    href={`/chat/${t._id}`}
                    prefetch={false}
                    onClick={onNavigate}
                    className="min-w-0 flex-1 truncate"
                  >
                    {t.title}
                  </Link>
                  {t.isStreaming && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand animate-pulse motion-reduce:animate-none" />
                  )}
                  <ThreadMenu
                    pinned={t.pinned}
                    onPin={() =>
                      guard(
                        () => setPinned({ threadId: t._id, pinned: !t.pinned }),
                        "Couldn't pin that",
                      )
                    }
                    onRename={async () => {
                      const title = window.prompt("Rename conversation", t.title);
                      if (!title?.trim() || title === t.title) return;
                      await guard(
                        () => renameThread({ threadId: t._id, title }),
                        "Couldn't rename that",
                      );
                    }}
                    onDelete={async () => {
                      if (!window.confirm(`Delete “${t.title}”?`)) return;
                      await guard(
                        () => removeThread({ threadId: t._id }),
                        "Couldn't delete that",
                      );
                      if (active) router.push("/chat");
                    }}
                  />
                </div>
              );
            })}
          </div>
        ))}

        {status === "CanLoadMore" && (
          <button
            type="button"
            onClick={() => loadMore(PAGE)}
            className="w-full rounded-md px-2 py-1.5 text-xs text-primary/50 transition hover:bg-primary/5"
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}

function ThreadMenu({
  pinned,
  onPin,
  onRename,
  onDelete,
}: {
  pinned: boolean;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label="Conversation actions"
        onClick={() => setOpen((v) => !v)}
        className="rounded p-0.5 text-primary/30 opacity-0 transition hover:bg-primary/10 hover:text-primary/70 focus:opacity-100 group-hover:opacity-100"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-away dismiss */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute right-0 z-50 mt-1 w-36 overflow-hidden rounded-md border border-border bg-card py-1 shadow-lg">
            <MenuItem
              onClick={() => {
                setOpen(false);
                onPin();
              }}
            >
              {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
              {pinned ? "Unpin" : "Pin"}
            </MenuItem>
            <MenuItem
              onClick={() => {
                setOpen(false);
                onRename();
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              Rename
            </MenuItem>
            <MenuItem
              destructive
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </MenuItem>
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  destructive,
}: {
  children: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-primary/5 ${
        destructive ? "text-destructive" : "text-primary/75"
      }`}
    >
      {children}
    </button>
  );
}
