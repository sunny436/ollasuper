"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useModalFocus } from "../../chat/_hooks/use-modal-focus";
import { ProjectInstructions } from "./project-instructions";

/**
 * Project settings.
 *
 * Everything that configures a project rather than describing it: its name, its
 * instructions, what it has remembered, and the way to delete it. Keeping these
 * off the project page is what lets that page be about the WORK — chats and
 * sources — instead of a settings sheet with a chat list at the bottom.
 *
 * What the reference has here and this does NOT, because the behaviour does not
 * exist:
 *   - a memory selector. Scope is fixed by the runtime (a project chat writes
 *     project-scoped memory and reads project -> workspace -> account), so a
 *     dropdown would change nothing.
 *   - Library access. No such concept.
 * A control that does nothing is worse than an absent one: it makes a promise
 * the product cannot keep.
 */
export function ProjectSettingsDialog({
  open,
  onOpenChange,
  projectId,
  name,
  instructions,
  readOnly,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: Id<"projects">;
  name: string;
  instructions: string | null;
  /** Archived or deleted: readable so it can be reviewed, not editable. */
  readOnly: boolean;
  onDelete: () => void;
}) {
  const renameProject = useMutation(api.projects.rename);
  const [draft, setDraft] = useState(name);
  const [savingName, setSavingName] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) setDraft(name);
  }, [open, name]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const dialogRef = useModalFocus<HTMLDivElement>(open);

  if (!open) return null;

  const trimmed = draft.trim();
  const nameDirty = trimmed.length > 0 && trimmed !== name;

  const saveName = async () => {
    if (!nameDirty || savingName) return;
    setSavingName(true);
    try {
      await renameProject({ projectId, name: trimmed });
      toast.success("Project renamed");
    } catch {
      // Never console.error — the Convex client already logs rejections and
      // every e2e script asserts zero console errors.
      toast.error("Couldn't rename that project");
      setDraft(name);
    } finally {
      setSavingName(false);
    }
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled above */}
      <div
        className="fixed inset-0 z-40 bg-black/50"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Project settings"
        // max-h + internal scroll: name, instructions, the memory list and the
        // delete action together are taller than a short viewport.
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-card shadow-md"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 px-5 pt-5">
          <h2 className="text-lg font-semibold text-primary">
            Project settings
          </h2>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent hover:text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          <label
            htmlFor="project-name"
            className="mt-4 block text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Project name
          </label>
          <div className="mt-2 flex items-center gap-2">
            <input
              id="project-name"
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && nameDirty) void saveName();
              }}
              disabled={readOnly}
              maxLength={200}
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none transition focus:border-brand disabled:opacity-50"
            />
            {nameDirty && !readOnly && (
              <button
                type="button"
                onClick={() => void saveName()}
                disabled={savingName}
                className="shrink-0 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-foreground transition hover:opacity-90 disabled:opacity-40"
              >
                {savingName ? "Saving…" : "Save"}
              </button>
            )}
          </div>

          {/* Instructions + project memory, reused verbatim. This dialog is
              where they live now; nothing about how they work changed. */}
          <ProjectInstructions
            projectId={projectId}
            initial={instructions}
            archived={readOnly}
          />

          {!readOnly && (
            <div className="mt-8 border-t border-border pt-4">
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  onDelete();
                }}
                className="rounded-lg border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/10"
              >
                Delete project
              </button>
              <p className="mt-2 text-xs text-muted-foreground">
                Its chats are kept and move back to your conversation list. You
                can restore the project for 30 days.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
