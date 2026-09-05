"use client";

import { ConfirmButton } from "@/components/confirm-button";
import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { Button } from "@v1/ui/button";
import { useMutation, usePaginatedQuery } from "convex/react";
import { ArchiveRestore, MessageSquare } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

export default function ArchivedSection() {
  const { current } = useWorkspace();
  const { results, status, loadMore } = usePaginatedQuery(
    api.chat.threads.list,
    current ? { workspaceId: current, status: "archived" as const } : "skip",
    { initialNumItems: 20 },
  );
  const archive = useMutation(api.chat.threads.archive);
  const remove = useMutation(api.chat.threads.remove);

  const onUnarchive = async (threadId: Id<"chatThreads">) => {
    try {
      await archive({ threadId, archived: false });
      toast.success("Chat restored");
    } catch {
      toast.error("Couldn't restore that chat");
    }
  };

  const onDelete = async (threadId: Id<"chatThreads">) => {
    await remove({ threadId });
    toast.success("Chat deleted");
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">
          Archived chats
        </h1>
        <p className="mt-1 text-sm text-primary/55">
          Conversations you've archived. Restore one to bring it back to the
          sidebar, or delete it permanently.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {status === "LoadingFirstPage" && (
          <p className="rounded-2xl border border-border bg-card/60 p-8 text-center text-sm text-primary/50 backdrop-blur-xl">
            Loading…
          </p>
        )}

        {status !== "LoadingFirstPage" && results.length === 0 && (
          <p className="rounded-2xl border border-border bg-card/60 p-8 text-center text-sm text-primary/50 backdrop-blur-xl">
            No archived chats. Archive a conversation from its menu to keep it
            out of the sidebar without deleting it.
          </p>
        )}

        {results.map((t) => (
          <div
            key={t._id}
            className="group flex items-center gap-3 rounded-2xl border border-border bg-card/60 p-4 backdrop-blur-xl transition hover:border-brand/25"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/5 text-primary/50">
              <MessageSquare className="h-4 w-4" />
            </span>
            {/*
              OPEN. An archived conversation was reachable only by knowing its
              URL — the row offered Restore and Delete but no way to read the
              thing being managed. Opening it deliberately does NOT unarchive it
              (threads.get admits any non-trashed thread), so a user can check
              what a conversation was before deciding to restore or delete it.
            */}
            <Link
              href={`/chat/${t._id}`}
              className="min-w-0 flex-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <p className="truncate text-sm font-medium text-primary/85 transition group-hover:text-primary">
                {t.title || "Untitled"}
              </p>
              <p className="mt-0.5 text-xs text-primary/45">
                Archived · {new Date(t.updatedAt).toLocaleDateString()}
              </p>
            </Link>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => onUnarchive(t._id)}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-primary/60 transition hover:bg-primary/5 hover:text-primary/90"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                Restore
              </button>
              <ConfirmButton
                label="Delete"
                title="Delete this chat?"
                description="This moves the conversation to trash and it will be permanently removed. This cannot be undone."
                confirmLabel="Delete"
                className="rounded-lg px-2.5 py-1.5 text-xs text-red-500 transition hover:bg-red-500/10"
                onConfirm={() => onDelete(t._id)}
              />
            </div>
          </div>
        ))}
      </div>

      {status === "CanLoadMore" && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => loadMore(20)}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
