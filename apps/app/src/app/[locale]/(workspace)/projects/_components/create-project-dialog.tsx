"use client";

import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { Lightbulb } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useModalFocus } from "../../chat/_hooks/use-modal-focus";

/**
 * Create a project.
 *
 * Deliberately minimal: a name and nothing else. Instructions are edited in
 * Project settings once the project exists, which is where someone actually has
 * the context to write them.
 *
 * There is NO memory selector, though the reference product has one. Memory
 * scope here is fixed by the runtime — a chat in a project writes project-scoped
 * memory and reads project, then workspace, then account — so a dropdown would
 * be a control that changes nothing.
 *
 * `className="workspace"` on the portal-less overlay is unnecessary (this
 * renders inside the workspace subtree), but the surface tokens it uses are the
 * re-pointed ones from globals.css, which is why it matches the rail.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { current } = useWorkspace();
  const createProject = useMutation(api.projects.create);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Checked synchronously: React state loses to two Enter keydowns batched into
  // one render, so state alone cannot prevent a double submit.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setError(null);
    inputRef.current?.focus();
  }, [open]);

  // Escape closes, matching the drawer, the command palette and the rail.
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

  const trimmed = name.trim();
  const canSubmit = Boolean(current) && trimmed.length > 0 && !submitting;

  const submit = async () => {
    if (!current || !trimmed || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const projectId = await createProject({
        workspaceId: current,
        name: trimmed,
      });
      onOpenChange(false);
      router.push(`/projects/${projectId}`);
    } catch (e) {
      // Never console.error: the Convex client already logs rejections and
      // every e2e script asserts zero console errors. Show it in the dialog.
      setError(
        e instanceof Error && e.message
          ? cleanError(e.message)
          : "Could not create that project",
      );
    } finally {
      inFlight.current = false;
      setSubmitting(false);
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
        aria-label="New project"
        className="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card p-5 shadow-md"
      >
        <h2 className="text-lg font-semibold text-primary">New project</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Give it a name. You can rename it later.
        </p>

        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit) void submit();
          }}
          maxLength={200}
          placeholder="Project name"
          aria-label="Project name"
          className="mt-4 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none transition focus:border-brand"
        />

        {/* The one element that makes this read as the reference dialog: it
            answers "what IS a project?" at the moment someone is deciding
            whether to make one. */}
        <div className="mt-3 flex items-start gap-2.5 rounded-xl bg-accent/60 px-3 py-2.5 text-xs text-muted-foreground">
          <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-ink" />
          <span>
            Projects keep chats, files and instructions in one place. Use them
            for ongoing work, or just to keep things tidy.
          </span>
        </div>

        {error && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition hover:opacity-90 active:scale-95 disabled:opacity-40"
          >
            {submitting ? "Creating…" : "Create project"}
          </button>
        </div>
      </div>
    </>
  );
}

/** Convex wraps thrown ConvexErrors with framing noise; show just the message. */
function cleanError(raw: string): string {
  const m = /Uncaught ConvexError:\s*(.+?)(\n|$)/.exec(raw);
  if (m?.[1]) return m[1];
  return raw.split("\n")[0]?.slice(0, 160) ?? "Could not create that project";
}
