"use client";

import { FilesSection } from "./files-section";
import { InfiniteSentinel } from "@/components/infinite-sentinel";
import { ChatInstructionsDialog } from "./chat-instructions-dialog";
import { MoveToProjectDialog } from "./move-to-project-dialog";
import { OllaSuperBrand } from "@/components/branding";
import { clearDisplayCaches } from "@/lib/display-cache";
import { preloadLocale } from "@/locales/client";
import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import {
  useConvex,
  useMutation,
  usePaginatedQuery,
} from "convex/react";
import { useCachedThreads, type CachedThread } from "../_hooks/use-cached-threads";
import { useCachedUser } from "../_hooks/use-cached-user";
import {
  cancelPrefetch,
  cancelRoutePrefetch,
  prefetchRoute,
  prefetchThread,
  prefetchThreadNow,
  releasePrefetch,
} from "../_lib/prefetch";
import {
  Archive,
  CalendarClock,
  CreditCard,
  FolderInput,
  SlidersHorizontal,
  FolderKanban,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
    <div className="flex shrink-0 items-center px-4 py-4 text-foreground">
      <OllaSuperBrand variant="app" />
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
      // Settings / Shared / Billing sit under the dynamic [locale] segment; the
      // default partial prefetch fetches nothing useful there, so entering
      // settings paid a full RSC round trip. See settings-sidebar.tsx.
      prefetch={true}
      onClick={onNavigate}
      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs text-primary/75 transition hover:bg-primary/5 hover:text-primary"
    >
      <Icon className="h-3.5 w-3.5 text-primary/60" />
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
  // Opening this menu is the intent to enter Settings; see preloadLocale.
  const { locale } = useParams<{ locale?: string }>() ?? {};
  useEffect(() => {
    if (open) preloadLocale(locale);
  }, [open, locale]);

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
    <div className="relative shrink-0 border-t border-border p-2">
      {open && (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled above */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute bottom-[calc(100%-0.25rem)] left-2 right-2 z-20 rounded-xl border border-border bg-popover p-1.5 shadow-md">
            <ProfileMenuItem
              href="/settings"
              icon={Settings}
              label="Settings"
              onNavigate={onNavigate}
            />
            <ProfileMenuItem
              href="/settings/billing"
              icon={CreditCard}
              label="Billing"
              onNavigate={onNavigate}
            />
            <div className="my-1.5 border-t border-border" />
            <button
              type="button"
              onClick={() => {
                clearDisplayCaches();
                void signOut();
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs text-primary/75 transition hover:bg-primary/5 hover:text-primary"
            >
              <LogOut className="h-3.5 w-3.5 text-primary/60" /> Log out
            </button>
          </div>
        </>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Account menu"
        className="group flex w-full items-center gap-2.5 rounded-xl border border-border bg-card p-2 text-left transition-colors duration-200 hover:bg-accent"
      >
        {/* THE PHOTO WAS NEVER RENDERED HERE. Settings and the dashboard rail
            both show `avatarUrl`, and useCachedUser already fetches and caches
            it — this footer just painted the initial unconditionally, so a new
            profile photo appeared everywhere except the surface the user looks
            at most, which reads as "the avatar did not sync". The initial stays
            as the fallback for an account with no photo. */}
        {user?.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt=""
            className="h-8 w-8 shrink-0 rounded-lg object-cover"
          />
        ) : (
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand text-xs font-semibold text-brand-foreground">
            {(user?.displayName || user?.name || user?.email || "?")
              .charAt(0)
              .toUpperCase()}
          </span>
        )}
        {/* displayName FIRST: getUser returns `name` as `username || name`, so
            binding `name` here showed the username to anyone who had set one.
            Falling through to `name` keeps the existing display for accounts
            with no Display name set. */}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-primary">
            {user?.displayName || user?.name || "Account"}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {user?.email}
          </span>
        </span>
        <Settings className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100" />
      </button>
    </div>
  );
}
export function ChatSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const convex = useConvex();
  const params = useParams<{ threadId?: string }>();
  const activeId = params?.threadId ?? null;
  // The rail is shared by /chat and /scheduled, so the entry highlights from
  // the pathname rather than from a chat-only param.
  const pathname = usePathname();
  const scheduledActive = (pathname ?? "").includes("/scheduled");
  const projectsActive = (pathname ?? "").includes("/projects");
  const { current } = useWorkspace();

  // Once a thread is the active route, its own components subscribe to the same
  // queries the hover-prefetch warmed — release the held warm subs so they do
  // not linger past their usefulness (the TTL is only a backstop).
  useEffect(() => {
    if (activeId) releasePrefetch(activeId);
  }, [activeId]);

  const createThread = useMutation(api.chat.threads.create);
  const renameThread = useMutation(api.chat.threads.rename);
  const removeThread = useMutation(api.chat.threads.remove);
  const archiveThread = useMutation(api.chat.threads.archive);
  const setPinned = useMutation(api.chat.threads.setPinned);
  const [instructThread, setInstructThread] = useState<Id<"chatThreads"> | null>(
    null,
  );
  const [movingThread, setMovingThread] = useState<Id<"chatThreads"> | null>(
    null,
  );


  const { results, status, loadMore } = usePaginatedQuery(
    api.chat.threads.list,
    // Phase 2: a chat placed in a Project leaves the rail and lives on its
    // Project page, so the same conversation is never listed twice.
    current ? { workspaceId: current, unassignedOnly: true } : "skip",
    { initialNumItems: PAGE },
  );

  // Instant on reload: paint the last thread list from localStorage while the
  // live paginated query reconnects, then hand off to live. showSkeleton is only
  // true when there is no cache to paint.
  const loadingFirst = status === "LoadingFirstPage";
  const { threads: cachedThreads, showSkeleton } = useCachedThreads(
    (results ?? []) as unknown as CachedThread[],
    loadingFirst,
  );
  const threads = cachedThreads as unknown as ThreadItem[];

  // The full thread list. (The conversation search bar was removed.)
  const filtered = threads;

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

  // Returns whether the call SUCCEEDED. The existing callers ignore it, so
  // Pin/Rename/Delete are unchanged — but a caller that also shows a success
  // toast needs to know, or a failed mutation reports "done" and "failed" at
  // the same time.
  const guard = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      return true;
    } catch {
      toast.error(msg);
      return false;
    }
  };

  const onNewChat = async () => {
    if (!current) return;
    cancelRoutePrefetch("/chat"); // the click supersedes a still-pending intent
    // Navigating to a fresh /chat is enough — the thread is created on the
    // first send, so an abandoned "New chat" never leaves an empty row.
    router.push("/chat");
    onNavigate?.();
  };

  /**
   * Warm the rail's two other destinations once the rail itself has painted.
   *
   * Not `<Link prefetch>`: that fires the moment the links enter the viewport,
   * which on sign-in is the exact moment the chat route is hydrating and the
   * WebSocket is connecting — three RSC fetches and seven chunks competing
   * with the composer becoming usable (seen in the sign-in request trace).
   * Waiting for the first thread page and then for idle keeps them off the
   * critical path; a tap still finds both routes in the router cache.
   */
  useEffect(() => {
    if (loadingFirst) return;
    const warm = () => {
      for (const href of ["/projects", "/scheduled"]) prefetchRoute(router, href);
    };
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(warm, { timeout: 4000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(warm, 1500);
    return () => clearTimeout(t);
  }, [loadingFirst, router]);


  return (
    <div className="flex h-full flex-col">
      <BrandHeader />

      {/* Grouped header block — New chat, Files — with no internal
          dividers, matching the reference's grouping. */}
      <div className="flex shrink-0 flex-col gap-3 px-3 py-3">
        <button
          type="button"
          onClick={() => void onNewChat()}
          // router.push("/chat") pays an RSC round trip unless the route is
          // already in the router cache; warm it on intent, like a thread row.
          onPointerEnter={() => prefetchRoute(router, "/chat")}
          onPointerLeave={() => cancelRoutePrefetch("/chat")}
          onFocus={() => prefetchRoute(router, "/chat")}
          onBlur={() => cancelRoutePrefetch("/chat")}
          className="group flex w-full items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-sm font-medium text-primary transition-all duration-200 hover:border-brand/30 active:scale-[0.98]"
        >
          <span className="rounded-lg bg-brand/10 p-1 text-brand-ink transition-colors group-hover:bg-brand group-hover:text-brand-foreground">
            <Plus className="h-4 w-4 transition-transform duration-300 group-hover:rotate-90 motion-reduce:transition-none" />
          </span>
          New chat
        </button>

        <FilesSection />

        {/*
          The workspace's second destination. Placed above the conversation
          list so the rail reads as navigation-then-history, and given the same
          active treatment a selected thread gets.
        */}
        <Link
          href="/projects"
          // Under the dynamic [locale] segment the default partial prefetch
          // fetches nothing a navigation can use, so the click paid an RSC
          // round trip; the idle warm-up above (and hover, for a stale entry)
          // is a full prefetch. One small request per five minutes.
          prefetch={false}
          onPointerEnter={() => prefetchRoute(router, "/projects")}
          onPointerLeave={() => cancelRoutePrefetch("/projects")}
          onClick={() => {
            cancelRoutePrefetch("/projects");
            onNavigate?.();
          }}
          aria-current={projectsActive ? "page" : undefined}
          className={`mt-2 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors duration-200 ${
            projectsActive
              ? "bg-brand/10 font-medium text-brand-ink"
              : "text-muted-foreground hover:bg-accent hover:text-primary"
          }`}
        >
          <FolderKanban className="h-4 w-4 shrink-0" />
          Projects
        </Link>

        <Link
          href="/scheduled"
          prefetch={false}
          onPointerEnter={() => prefetchRoute(router, "/scheduled")}
          onPointerLeave={() => cancelRoutePrefetch("/scheduled")}
          onClick={() => {
            cancelRoutePrefetch("/scheduled");
            onNavigate?.();
          }}
          aria-current={scheduledActive ? "page" : undefined}
          className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors duration-200 ${
            scheduledActive
              ? "bg-brand/10 font-medium text-brand-ink"
              : "text-muted-foreground hover:bg-accent hover:text-primary"
          }`}
        >
          <CalendarClock className="h-4 w-4 shrink-0" />
          Scheduled
        </Link>
      </div>

      <div className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {showSkeleton && (
          <div className="space-y-1.5 px-1">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-8 animate-pulse rounded-md bg-primary/5"
              />
            ))}
          </div>
        )}

        {!showSkeleton && filtered.length === 0 && (
          <div className="px-2 py-6 text-center">
            <p className="text-xs text-primary/65">No conversations yet</p>
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
                  className={`group flex items-center gap-1 rounded-lg px-2 py-2 text-sm transition-colors duration-200 [@media(pointer:coarse)]:py-0 ${
                    active
                      ? "bg-brand/10 font-medium text-brand-ink"
                      : "text-muted-foreground hover:bg-accent hover:text-primary"
                  }`}
                >
                  <Link
                    href={`/chat/${t._id}`}
                    prefetch={false}
                    onClick={() => {
                      prefetchThreadNow(convex, t._id);
                      onNavigate?.();
                    }}
                    onPointerEnter={() => prefetchThread(convex, t._id, router)}
                    onPointerLeave={() => cancelPrefetch(t._id)}
                    onFocus={() => prefetchThread(convex, t._id, router)}
                    onBlur={() => cancelPrefetch(t._id)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 truncate [@media(pointer:coarse)]:min-h-11"
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
                    onArchive={async () => {
                      // No confirm: archiving is reversible and non-destructive,
                      // and no navigation either — unlike Delete, the thread is
                      // still perfectly valid to read, so yanking the user out of
                      // a conversation they are looking at would be a surprise.
                      // It simply leaves the sidebar.
                      const ok = await guard(
                        () =>
                          archiveThread({ threadId: t._id, archived: true }),
                        "Couldn't archive that",
                      );
                      // Only on success: the row is still in the sidebar if the
                      // mutation failed, so claiming otherwise would be a lie the
                      // user can see.
                      if (ok) toast.success("Chat archived");
                    }}
                    onMove={() => setMovingThread(t._id)}
                    onInstructions={() => setInstructThread(t._id)}
                    onDelete={async () => {
                      if (!window.confirm(`Delete “${t.title}”?`)) return;
                      // The row was hovered to reach this menu, so its prefetch
                      // is warm; drop it before the thread goes away rather than
                      // let the held subscription re-run against a deleted
                      // thread for its remaining TTL.
                      releasePrefetch(t._id);
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

        <InfiniteSentinel status={status} loadMore={loadMore} pageSize={PAGE} />
      </div>

      <ChatInstructionsDialog
        threadId={instructThread}
        onClose={() => setInstructThread(null)}
      />
      <MoveToProjectDialog
        threadId={movingThread}
        onClose={() => setMovingThread(null)}
      />

      <ProfileFooter onNavigate={onNavigate} />
    </div>
  );
}

function ThreadMenu({
  pinned,
  onPin,
  onRename,
  onMove,
  onInstructions,
  onArchive,
  onDelete,
}: {
  pinned: boolean;
  onPin: () => void;
  onRename: () => void;
  onMove: () => void;
  onInstructions: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  /**
   * PORTALLED, not absolutely positioned — and that is the whole fix.
   *
   * This menu used to be `absolute` inside the row, which sits inside the
   * rail's `overflow-y-auto` scroller. A positioned descendant is clipped by
   * any ancestor whose overflow is not visible, so on the last few rows the
   * menu was cut off and looked like it was hiding behind the account footer
   * (a sibling BELOW that scroller). No z-index can fix that; leaving the clip
   * context can.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const menuH = menuRef.current?.getBoundingClientRect().height ?? 0;
    // Flip up from the menu's REAL height once it exists, rather than an
    // estimate taken before the browser reacted to the click — the mistake
    // scheduled/task-row.tsx documents ("52px of it unreachable" at 1280x800).
    // useLayoutEffect, so it is never painted in the wrong place.
    const below = r.bottom + 4;
    const flip = menuH > 0 && below + menuH > window.innerHeight - 8;
    setPos({
      top: flip ? Math.max(8, r.top - 4 - menuH) : below,
      right: Math.max(8, window.innerWidth - r.right),
    });
    // The portal put the menu at the END of <body>, out of the tab order next
    // to its trigger, so it takes focus itself — the disclosure-menu contract.
    // preventScroll: a focus-induced scroll would trip the scroll-to-close
    // listener below and shut the menu the instant it opened.
    menuRef.current
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus({ preventScroll: true });
  }, [open]);

  // This menu never handled Escape; the portal made that matter, because the
  // menu now owns focus. Close, and hand focus back to the trigger.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // A fixed menu would otherwise hang in place while its row scrolls away.
  // Capture, because scroll does not bubble: this catches the rail's scroller
  // as well as the page.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const menu = (
    <div className="workspace">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-away dismiss */}
      <div
        className="fixed inset-0 z-40"
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />
      <div
        ref={menuRef}
        // No role="menu": that requires menuitem children, and the items must
        // stay buttons — seven e2e scripts click them by button role.
        onBlur={(e) => {
          // relatedTarget is where focus is GOING. Null means a click on the
          // click-away layer or outside the page — the layer handles that.
          const next = e.relatedTarget as Node | null;
          if (next && !e.currentTarget.contains(next)) setOpen(false);
        }}
        style={{ top: pos?.top ?? -9999, right: pos?.right ?? 0 }}
        className="fixed z-50 w-36 overflow-hidden rounded-md border border-border bg-card py-1 shadow-md"
      >
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
          onClick={() => {
            setOpen(false);
            onMove();
          }}
        >
          <FolderInput className="h-3.5 w-3.5" />
          Move to project
        </MenuItem>
        <MenuItem
          onClick={() => {
            setOpen(false);
            onInstructions();
          }}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Chat instructions
        </MenuItem>
        <MenuItem
          onClick={() => {
            setOpen(false);
            onArchive();
          }}
        >
          <Archive className="h-3.5 w-3.5" />
          Archive
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
    </div>
  );

  return (
    <div className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Conversation actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`rounded p-0.5 text-muted-foreground transition hover:bg-primary/10 hover:text-primary/70 focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(menu, document.body)
        : null}
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
