"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@v1/ui/dropdown-menu";
import { useMutation, useQuery } from "convex/react";
import { Bell, Check } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type ReactNode,
  createContext,
  useContext,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "../../(workspace)/scheduled/_components/confirm-dialog";
import { relative } from "../../(workspace)/scheduled/_lib/schedule-format";

/**
 * The notification centre.
 *
 * Two rules define it, and both replace behaviour that was actively wrong:
 *
 *  1. OPENING THE PANEL READS NOTHING. It used to call markAllRead the instant
 *     the popover opened, so a glance at the bell destroyed every unread mark
 *     and the count could never be trusted. Read is now an explicit act on ONE
 *     notification — opening it, or its check button.
 *  2. LOADING IS NOT EMPTY. `useQuery` returns undefined while in flight, and
 *     the old `notifications?.length ? … : "No notifications"` rendered the
 *     empty state every time the panel opened, before the rows arrived.
 *
 * Read state lives on the server, so two tabs agree without any coordination:
 * Convex pushes the patch to every subscriber.
 */

type Severity = "success" | "failure" | "warning" | "action" | "info";

/**
 * Derived from `type`, never stored. A severity column would need a migration
 * and would leave every pre-existing row blank; this classifies history too.
 */
function severityOf(type: string): Severity {
  switch (type) {
    case "scheduled.succeeded":
    case "chat.turn_done":
      return "success";
    case "scheduled.failed":
    case "chat.turn_failed":
      return "failure";
    case "scheduled.email_disabled":
    case "approval.expired":
      return "warning";
    case "approval.required":
      return "action";
    default:
      // Includes `invite` and `scheduled.cancelled`, and anything a future
      // emitter adds — an unknown type must render, never crash.
      return "info";
  }
}

const SEVERITY: Record<Severity, { dot: string; label: string }> = {
  success: { dot: "bg-muted", label: "Success" },
  failure: { dot: "bg-muted", label: "Failed" },
  warning: { dot: "bg-muted", label: "Warning" },
  action: { dot: "bg-brand", label: "Action required" },
  info: { dot: "bg-primary/30", label: "Update" },
};

type Row = {
  _id: Id<"notifications">;
  type: string;
  title: string;
  body?: string;
  read: boolean;
  createdAt: number;
  taskId?: Id<"scheduledTasks">;
  occurrenceId?: Id<"scheduledTaskOccurrences">;
  threadId?: Id<"chatThreads">;
};

/**
 * Where a notification leads, or null when it leads nowhere.
 *
 * A scheduled row opens the RUN, not just the task — `?run=` is the param the
 * task detail already reads. An invite has no destination because the app has
 * no accept surface, and sending someone to a dead page is worse than not
 * linking at all.
 */
function targetOf(n: Row): string | null {
  if (n.taskId) {
    return n.occurrenceId
      ? `/scheduled/${n.taskId}?run=${n.occurrenceId}`
      : `/scheduled/${n.taskId}`;
  }
  if (n.threadId) return `/chat/${n.threadId}`;
  return null;
}

/**
 * Module scope, never nested inside NotificationsBell: a sub-component declared
 * inside its parent is a new component type on every render, so React remounts
 * it. Same rule the chat sidebar and auth form document.
 */
function NotificationRow({
  n,
  onOpen,
  onRead,
}: {
  n: Row;
  onOpen: (n: Row) => void;
  onRead: (id: Id<"notifications">) => void;
}) {
  const sev = SEVERITY[severityOf(n.type)];
  const href = targetOf(n);
  return (
    <div
      className={`flex items-start gap-2.5 px-3 py-2.5 transition ${
        n.read ? "" : "bg-primary/[0.03]"
      }`}
    >
      <span
        aria-hidden
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${sev.dot}`}
      />
      <button
        type="button"
        onClick={() => onOpen(n)}
        // Not a <Link>: a link-less notification must still be openable to be
        // marked read, and the row does both jobs.
        className="min-w-0 flex-1 text-left"
      >
        <p
          className={`truncate text-sm ${
            n.read ? "text-primary/70" : "font-medium text-primary"
          }`}
        >
          <span className="sr-only">{sev.label}. </span>
          {n.title}
        </p>
        {n.body && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {n.body}
          </p>
        )}
        <p className="mt-1 text-[10px] text-muted-foreground">
          {relative(n.createdAt)}
          {href ? "" : " · no details"}
        </p>
      </button>
      {!n.read && (
        <button
          type="button"
          aria-label={`Mark “${n.title}” as read`}
          title="Mark as read"
          onClick={(e) => {
            e.stopPropagation();
            onRead(n._id);
          }}
          className="mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-primary/5 hover:text-primary"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

type Latest = ReturnType<
  typeof useQuery<typeof api.notifications.myNotifications>
>;
const NotificationsCtx = createContext<{
  latest: Latest;
  unread: number | undefined;
} | null>(null);

/**
 * Holds the centre's two live subscriptions — the newest page and the unread
 * count — ABOVE the panes, in a layout that survives navigation.
 *
 * The bell is rendered inside each pane's header (chat, scheduled, projects),
 * and panes remount on navigation — chat panes even per thread. With the
 * queries in the bell, every navigation dropped and re-added both
 * subscriptions and re-downloaded the page (measured: +2/−2 on every step,
 * ~9.4 KB for a full page). Here they live once for the whole workspace; the
 * bell only reads them. Realtime is unchanged — Convex pushes to this one
 * subscription exactly as it did to the bell's.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const latest = useQuery(api.notifications.myNotifications, {});
  const unread = useQuery(api.notifications.unreadCount);
  const value = useMemo(() => ({ latest, unread }), [latest, unread]);
  return (
    <NotificationsCtx.Provider value={value}>{children}</NotificationsCtx.Provider>
  );
}

export function NotificationsBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [before, setBefore] = useState<number | undefined>(undefined);

  // Inside a NotificationsProvider the newest page and the count come from it;
  // only an OLDER page ("Show older") is a subscription of the bell's own. A
  // bell with no provider above it (the dashboard topbar, whose layout already
  // persists) subscribes for itself, exactly as before.
  const shared = useContext(NotificationsCtx);
  const own = useQuery(
    api.notifications.myNotifications,
    shared && before === undefined ? "skip" : { before },
  );
  const ownUnread = useQuery(
    api.notifications.unreadCount,
    shared ? "skip" : {},
  );
  const result = shared && before === undefined ? shared.latest : own;
  const unread = (shared ? shared.unread : ownUnread) ?? 0;
  const markRead = useMutation(api.notifications.markRead);
  const markAllRead = useMutation(api.notifications.markAllRead);
  const [confirmClear, setConfirmClear] = useState(false);
  // Optimistic: every mounted page of the centre (one per pane's bell, and an
  // older page if one is open) empties and the badge drops the instant the
  // user confirms; Convex rolls both back by itself if the mutation fails.
  const clearAll = useMutation(api.notifications.clearAll).withOptimisticUpdate(
    (store) => {
      for (const q of store.getAllQueries(api.notifications.myNotifications)) {
        store.setQuery(api.notifications.myNotifications, q.args, {
          page: [],
          nextCursor: null,
        });
      }
      store.setQuery(api.notifications.unreadCount, {}, 0);
    },
  );

  const loading = result === undefined;
  const rows = (result?.page ?? []) as Row[];

  async function onClearAll() {
    try {
      await clearAll();
      // AFTER the mutation, not before: resetting first would mount a fresh
      // page-one subscription the optimistic update never saw, and a user on
      // an older page would watch the old rows flash back until it resolved.
      setBefore(undefined);
    } catch {
      toast.error("Couldn't clear notifications");
    }
  }

  function openNotification(n: Row) {
    if (!n.read) void markRead({ notificationId: n._id });
    const href = targetOf(n);
    if (href) {
      setOpen(false);
      router.push(href);
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Notifications"
          className="relative flex h-7 w-7 items-center justify-center rounded-md text-primary/65 transition hover:bg-primary/5 hover:text-primary [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span
              aria-label={`${unread > 9 ? "9+" : unread} unread`}
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[9px] font-medium text-background"
            >
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>

      {/* Radix portals to document.body, so the content re-enters the workspace
          palette explicitly — the same rule share-dialog and edit-task-dialog
          follow. Width-capped and near-full-width on a narrow viewport. */}
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="scrollbar-quiet workspace max-h-[var(--radix-dropdown-menu-content-available-height)] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto p-0"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="text-xs font-medium text-primary">Notifications</span>
          <div className="flex items-center gap-1">
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="rounded-md px-1.5 py-0.5 text-[11px] text-primary/65 transition hover:bg-primary/5 hover:text-primary"
              >
                Mark all as read
              </button>
            )}
            {rows.length > 0 && (
              // A menu ITEM, not a plain button: this panel is a Radix menu,
              // which swallows Tab, so only items are keyboard-reachable
              // (arrow keys). preventDefault keeps the panel open behind the
              // confirmation. Muted like its neighbour; the destructive tint
              // appears only on hover/focus.
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  setConfirmClear(true);
                }}
                className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-primary/65 transition hover:bg-primary/5 hover:text-destructive focus:bg-primary/5 focus:text-destructive"
              >
                Clear all
              </DropdownMenuItem>
            )}
          </div>
        </div>

        <div className="scrollbar-quiet max-h-80 divide-y divide-border/50 overflow-y-auto">
          {loading ? (
            <div className="space-y-3 px-3 py-3" aria-busy="true">
              <span className="sr-only">Loading notifications</span>
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-1.5">
                  <div className="h-3 w-2/3 animate-pulse rounded bg-primary/10" />
                  <div className="h-2.5 w-1/2 animate-pulse rounded bg-primary/5" />
                </div>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-primary/60">
              No notifications
            </div>
          ) : (
            rows.map((n) => (
              <NotificationRow
                key={n._id}
                n={n}
                onOpen={openNotification}
                onRead={(id) => void markRead({ notificationId: id })}
              />
            ))
          )}
        </div>

        {result?.nextCursor != null && (
          <button
            type="button"
            onClick={() => setBefore(result.nextCursor ?? undefined)}
            className="w-full border-t border-border px-3 py-2 text-xs text-primary/65 transition hover:bg-primary/5 hover:text-primary"
          >
            Show older
          </button>
        )}
        {before !== undefined && (
          <button
            type="button"
            onClick={() => setBefore(undefined)}
            className="w-full border-t border-border px-3 py-2 text-xs text-primary/65 transition hover:bg-primary/5 hover:text-primary"
          >
            Back to latest
          </button>
        )}

        {/* Inside the menu's React tree, so Radix treats the portalled dialog
            as part of the menu and does not dismiss the panel under it; and
            outside the rows conditional, so the optimistic empty list cannot
            unmount it mid-confirm. */}
        <ConfirmDialog
          open={confirmClear}
          onOpenChange={setConfirmClear}
          title="Clear all notifications?"
          body="This permanently deletes every notification you have now. New notifications will still arrive."
          confirmLabel="Clear all"
          destructive
          onConfirm={onClearAll}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
