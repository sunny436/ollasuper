"use client";

import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { FolderKanban, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useModalFocus } from "../_hooks/use-modal-focus";

/**
 * Move a chat into a Project, between Projects, or out of one.
 *
 * One dialog for all three, because they are one backend mutation
 * (`projects.moveThread`) and splitting them in the UI would imply they have
 * different semantics. Only ACTIVE projects are offered — an archived project
 * accepts no new work — while "Remove from project" stays available whatever
 * state the current project is in, so a chat is never stranded inside one the
 * user has archived.
 *
 * The dialog holds no chat state of its own; it mutates and closes.
 *
 * IT MUST BE PORTALLED. This renders from inside ChatSidebar, and the rail that
 * contains it (`workspace-rail.tsx`) is `backdrop-blur-xl` + `overflow-hidden`.
 * `backdrop-filter` makes that element the containing block for `position:
 * fixed` descendants, so `left-1/2 -translate-x-1/2` centred the dialog on the
 * 272px RAIL rather than the viewport: 136 - 208 = -72px, and `overflow-hidden`
 * then clipped it. The reported symptom was "Move to project is hard to read" —
 * it was not a contrast problem, the first 72px of every line was off-screen
 * ("Move to project" read as "to project"). Portalling to document.body escapes
 * both the containing block and the clip. `className="workspace"` is required
 * on anything portalled out of the chat subtree or it renders against the base
 * palette instead of the workspace tokens (see share-dialog.tsx).
 */

const PAGE = 30;

export function MoveToProjectDialog({
  threadId,
  onClose,
}: {
  threadId: Id<"chatThreads"> | null;
  onClose: () => void;
}) {
  const { current } = useWorkspace();
  const moveThread = useMutation(api.projects.moveThread);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);

  const open = threadId !== null;

  // The thread's CURRENT project, so the dialog can mark it and offer removal.
  const thread = useQuery(
    api.chat.threads.get,
    threadId ? { threadId } : "skip",
  );

  const { results, status, loadMore } = usePaginatedQuery(
    api.projects.list,
    current && open ? { workspaceId: current, status: "active" as const } : "skip",
    { initialNumItems: PAGE },
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const dialogRef = useModalFocus<HTMLDivElement>(open);

  if (!open) return null;

  const currentProjectId = thread?.project?._id ?? null;

  const move = async (projectId: Id<"projects"> | null) => {
    if (!threadId || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    try {
      await moveThread({ threadId, projectId });
      toast.success(projectId ? "Chat moved" : "Removed from project");
      onClose();
    } catch (e) {
      // Never console.error: the Convex client already logs rejections and
      // every e2e script asserts zero console errors.
      toast.error(
        e instanceof Error && e.message
          ? cleanError(e.message)
          : "Couldn't move that chat",
      );
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  // Rendered client-side only; there is no document during SSR.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="workspace">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled above */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Move chat to a project"
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[70vh] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-card p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-primary">
              Move to project
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Chats in a project leave the conversation list.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent hover:text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="scrollbar-quiet mt-4 min-h-0 flex-1 overflow-y-auto">
          {status === "LoadingFirstPage" && (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-11 animate-pulse rounded-lg bg-primary/5"
                />
              ))}
            </div>
          )}

          {status !== "LoadingFirstPage" && results.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No projects yet. Create one from Projects.
            </p>
          )}

          <ul className="space-y-1">
            {results.map((p) => {
              const isCurrent = p._id === currentProjectId;
              return (
                <li key={p._id}>
                  <button
                    type="button"
                    disabled={submitting || isCurrent}
                    onClick={() => void move(p._id)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors disabled:opacity-50 ${
                      isCurrent
                        ? "bg-brand/10 font-medium text-brand-ink"
                        : "text-muted-foreground hover:bg-accent hover:text-primary"
                    }`}
                  >
                    <FolderKanban className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{p.name}</span>
                    {isCurrent && (
                      <span className="ml-auto shrink-0 text-[11px]">
                        Current
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {status === "CanLoadMore" && (
            <button
              type="button"
              onClick={() => loadMore(PAGE)}
              className="mt-2 w-full rounded-md px-2 py-1.5 text-xs text-primary/65 transition hover:bg-primary/5"
            >
              Load more
            </button>
          )}
        </div>

        {currentProjectId && (
          <div className="mt-3 border-t border-border pt-3">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void move(null)}
              className="w-full rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-primary disabled:opacity-50"
            >
              Remove from project
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Convex wraps thrown ConvexErrors with framing noise; show just the message. */
function cleanError(raw: string): string {
  const m = /Uncaught ConvexError:\s*(.+?)(\n|$)/.exec(raw);
  if (m?.[1]) return m[1];
  return raw.split("\n")[0]?.slice(0, 160) ?? "Couldn't move that chat";
}
