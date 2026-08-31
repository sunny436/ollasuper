"use client";

import { api } from "@v1/backend/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { Bell } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

/**
 * Module scope, never nested inside NotificationsBell: a sub-component declared
 * inside its parent is a new component type on every render, so React remounts
 * it. Same rule the chat sidebar and auth form document.
 */
function NotificationBody({
  notification,
}: {
  notification: { title: string; body?: string; createdAt: number };
}) {
  return (
    <>
      <p className="font-medium text-primary/80">{notification.title}</p>
      {notification.body && (
        <p className="text-xs text-primary/50">{notification.body}</p>
      )}
      <p className="mt-0.5 text-[10px] text-primary/30">
        {new Date(notification.createdAt).toLocaleString()}
      </p>
    </>
  );
}

export function NotificationsBell() {
  const notifications = useQuery(api.notifications.myNotifications);
  const unread = useQuery(api.notifications.unreadCount) ?? 0;
  const markAllRead = useMutation(api.notifications.markAllRead);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Notifications"
        className="relative flex h-7 w-7 items-center justify-center rounded-md text-primary/50 hover:bg-primary/5 hover:text-primary"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && unread > 0) void markAllRead();
        }}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-medium text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close notifications"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-md border border-border bg-card shadow-lg">
            <div className="border-b border-border px-3 py-2 text-xs font-medium text-primary">
              Notifications
            </div>
            <div className="max-h-80 divide-y divide-border/50 overflow-y-auto">
              {notifications?.length ? (
                notifications.map((n) =>
                  n.taskId ? (
                    // Scheduled-task updates deep-link to the task. If it has
                    // since been deleted the route shows its "deleted" state —
                    // safe, and never a raw error.
                    <Link
                      key={n._id}
                      href={`/scheduled/${n.taskId}`}
                      onClick={() => setOpen(false)}
                      className="block px-3 py-2 text-sm transition hover:bg-primary/5"
                    >
                      <NotificationBody notification={n} />
                    </Link>
                  ) : (
                    <div key={n._id} className="px-3 py-2 text-sm">
                      <NotificationBody notification={n} />
                    </div>
                  ),
                )
              ) : (
                <div className="px-3 py-4 text-sm text-primary/40">
                  No notifications
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
