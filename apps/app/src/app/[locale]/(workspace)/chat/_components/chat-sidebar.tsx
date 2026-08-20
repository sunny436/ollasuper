"use client";

import { FilesSection } from "./files-section";
import { IntelligenceCore } from "./intelligence-core";
import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useCachedUser } from "../_hooks/use-cached-user";
import {
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Share2,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { timeBucket } from "../_lib/format";
import { useAuthActions } from "@convex-dev/auth/react";

const PAGE = 30;

interface ThreadItem {
  _id: Id<"chatThreads">;
  title: string;
  pinned: boolean;
  updatedAt: number;
  isStreaming: boolean;
}


/**
 * Module scope, never nested inside ChatSidebar.
 *
 * A sub-component declared inside its parent is a NEW component type on every
 * parent render, so React unmounts and remounts it — which in this file would
 * blow away the search input's focus and value on each keystroke. The same bug
 * is documented above Shell in components/auth/auth-form.tsx.
 */
function BrandHeader() {
  return (
    <div className="group flex cursor-pointer items-center gap-3 px-4 py-4">
      <IntelligenceCore />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-tight text-primary">
            Ollasuper
          </span>
          <span className="rounded-md bg-brand/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand-ink">
            v4.0
          </span>
        </div>
        <p className="truncate text-[11px] font-medium text-muted-foreground">
          AI Workspace
        </p>
      </div>
    </div>
  );
}

function ProfileMenuItem({
  href,
  icon: Icon,
  label,
  onNavigate,
}: {
  href: string;
  icon: typeof Settings;
  label: string;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs text-primary/75 transition hover:bg-primary/5 hover:text-primary"
    >
      <Icon className="h-3.5 w-3.5 text-primary/45" />
      {label}
    </Link>
  );
}

/**
 * The workspace has no app rail, so this footer is the ONLY route out to
 * Settings (which itself carries the dashboard aside → Files/Billing). Losing
 * the Settings link would strand the user in /chat.
 */
function ProfileFooter({ onNavigate }: { onNavigate?: () => void }) {
  const user = useCachedUser();
  const { signOut } = useAuthActions();
  const [open, setOpen] = useState(false);

  // Escape closes, matching the drawer and the command palette.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative border-t border-border p-2">
      {open && (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled above */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute bottom-[calc(100%-0.25rem)] left-2 right-2 z-20 rounded-xl border border-border bg-popover p-1.5 shadow-xl">
            <ProfileMenuItem
              href="/settings"
              icon={Settings}
              label="Settings"
              onNavigate={onNavigate}
            />
            <ProfileMenuItem
              href="/settings/shared"
              icon={Share2}
              label="Shared Chats"
              onNavigate={onNavigate}
            />
            <div className="my-1.5 border-t border-border" />
            <button
              type="button"
              onClick={() => void signOut()}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs text-primary/75 transition hover:bg-primary/5 hover:text-primary"
            >
              <LogOut className="h-3.5 w-3.5 text-primary/45" /> Log out
            </button>
          </div>
        </>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Account menu"
        className="group flex w-full items-center gap-2.5 rounded-xl border border-border bg-card/60 p-2 text-left transition-colors duration-200 hover:bg-accent"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand text-xs font-semibold text-brand-foreground shadow-sm">
          {(user?.name || user?.email || "?").charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-primary">
            {user?.name || "Account"}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {user?.email}
          </span>
        </span>
        <Settings className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    </div>
  );
}
export function ChatSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const params = useParams<{ threadId?: string }>();
  const activeId = params?.threadId ?? null;
  const { current } = useWorkspace();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  // Debounced so each keystroke does not fire a new search subscription.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(id);
  }, [query]);

  const createThread = useMutation(api.chat.threads.create);
  const renameThread = useMutation(api.chat.threads.rename);
  const removeThread = useMutation(api.chat.threads.remove);
  const setPinned = useMutation(api.chat.threads.setPinned);


  const { results, status, loadMore } = usePaginatedQuery(
    api.chat.threads.list,
    current ? { workspaceId: current } : "skip",
    { initialNumItems: PAGE },
  );

  const threads = (results ?? []) as unknown as ThreadItem[];

  // Real server-side full-text search. Client-side filtering would only ever
  // match the ~30 titles already loaded, silently missing everything older and
  // every message body.
  const searchResults = useQuery(
    api.chat.search.combined,
    current && debounced.length >= 2
      ? { workspaceId: current, query: debounced }
      : "skip",
  );
  const searching = debounced.length >= 2;

  const filtered = useMemo(() => {
    if (!searching) return threads;
    if (!searchResults) return [];
    // Reuse the loaded row when we have it (so pin/stream state is right),
    // otherwise synthesise from the search hit.
    const byId = new Map(threads.map((t) => [t._id as string, t]));
    return searchResults.map(
      (r) =>
        byId.get(r.threadId as string) ?? {
          _id: r.threadId,
          title: r.title,
          pinned: false,
          updatedAt: r.updatedAt,
          isStreaming: false,
        },
    ) as ThreadItem[];
  }, [threads, searchResults, searching]);

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


  return (
    <div className="flex h-full flex-col">
      <BrandHeader />

      {/* Grouped header block — New chat, Files, Search — with no internal
          dividers, matching the reference's grouping. */}
      <div className="flex flex-col gap-3 px-3 py-3">
        <button
          type="button"
          onClick={() => void onNewChat()}
          className="group flex w-full items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-sm font-medium text-primary shadow-sm transition-all duration-200 hover:border-brand/30 hover:shadow-md active:scale-[0.98]"
        >
          <span className="rounded-lg bg-brand/10 p-1 text-brand-ink transition-colors group-hover:bg-brand group-hover:text-brand-foreground">
            <Plus className="h-4 w-4 transition-transform duration-300 group-hover:rotate-90 motion-reduce:transition-none" />
          </span>
          New chat
        </button>

        <FilesSection />

        <div className="group flex items-center gap-2 rounded-xl border border-transparent bg-muted/60 px-2.5 py-2 transition-all focus-within:border-brand/30 focus-within:bg-card focus-within:ring-2 focus-within:ring-brand/15">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-focus-within:text-brand-ink" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations..."
            aria-label="Search conversations"
            className="w-full bg-transparent text-sm text-primary outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {status === "LoadingFirstPage" && (
          <div className="space-y-1.5 px-1">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-8 animate-pulse rounded-md bg-primary/5"
              />
            ))}
          </div>
        )}

        {status !== "LoadingFirstPage" && filtered.length === 0 && (
          <div className="px-2 py-6 text-center">
            <p className="text-xs text-primary/50">
              {query
                ? `No conversations match “${query}”`
                : "No conversations yet"}
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
          <div key={group.label} className="mb-4">
            <p className="mb-1 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </p>
            {group.items.map((t) => {
              const active = activeId === t._id;
              return (
                <div
                  key={t._id}
                  className={`group flex items-center gap-1 rounded-lg px-2 py-2 text-sm transition-colors duration-200 ${
                    active
                      ? "bg-brand/10 font-medium text-brand-ink"
                      : "text-muted-foreground hover:bg-accent hover:text-primary"
                  }`}
                >
                  <Link
                    href={`/chat/${t._id}`}
                    prefetch={false}
                    onClick={onNavigate}
                    className="flex min-w-0 flex-1 items-center gap-2.5 truncate"
                  >
                    <MessageSquare
                      className={`h-3.5 w-3.5 shrink-0 ${
                        active
                          ? "text-brand-ink"
                          : "text-muted-foreground group-hover:text-primary"
                      }`}
                    />
                    <span className="truncate">{t.title}</span>
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
                      const title = window.prompt(
                        "Rename conversation",
                        t.title,
                      );
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

        {status === "CanLoadMore" && !searching && (
          <button
            type="button"
            onClick={() => loadMore(PAGE)}
            className="w-full rounded-md px-2 py-1.5 text-xs text-primary/50 transition hover:bg-primary/5"
          >
            Load more
          </button>
        )}
      </div>

      <ProfileFooter onNavigate={onNavigate} />
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
              {pinned ? (
                <PinOff className="h-3.5 w-3.5" />
              ) : (
                <Pin className="h-3.5 w-3.5" />
              )}
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
