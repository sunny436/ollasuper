"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useModalFocus } from "../_hooks/use-modal-focus";

/**
 * Per-chat instruction OVERRIDE.
 *
 * `chatThreads.systemPrompt` has been read by the dispatch path all along
 * (`stream.ts` resolves `thread.systemPrompt ?? settings.systemPrompt`) and a
 * mutation to set it already existed — there was simply no way to reach either
 * from the UI, so the override was unusable.
 *
 * SCOPE IS THE POINT. This writes the THREAD row and nothing else, so a change
 * here can never mutate the user's global personalization; and clearing it
 * restores the global setting rather than blanking the assistant. Global
 * Personalization still applies underneath — this replaces the persona, not the
 * style preferences, and neither can displace the platform rules above them.
 *
 * Portalled for the same reason move-to-project is: the rail is
 * `backdrop-blur-xl` + `overflow-hidden`, which makes it the containing block
 * for `position: fixed` descendants and would clip this off-screen.
 */

const MAX = 8000;

export function ChatInstructionsDialog({
  threadId,
  onClose,
}: {
  threadId: Id<"chatThreads"> | null;
  onClose: () => void;
}) {
  const open = threadId !== null;
  const thread = useQuery(
    api.chat.threads.get,
    threadId ? { threadId } : "skip",
  );
  const setSystemPrompt = useMutation(api.chat.threads.setSystemPrompt);

  const [text, setText] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setHydrated(false);
      setText("");
      return;
    }
    if (thread === undefined || hydrated) return;
    setText(thread?.systemPrompt ?? "");
    setHydrated(true);
  }, [open, thread, hydrated]);

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
  if (typeof document === "undefined") return null;

  const save = async () => {
    if (!threadId || saving) return;
    setSaving(true);
    try {
      // null CLEARS the override, so the chat follows the global setting again.
      await setSystemPrompt({ threadId, systemPrompt: text.trim() || null });
      toast.success(
        text.trim() ? "Instructions saved for this chat" : "Using your global settings",
      );
      onClose();
    } catch {
      toast.error("Couldn't save the instructions");
    } finally {
      setSaving(false);
    }
  };

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
        aria-label="Instructions for this chat"
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[70vh] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-card p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-primary">
              Instructions for this chat
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Applies to this conversation only. Your global Personalization
              settings still apply; leave this empty to use them alone.
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

        <textarea
          value={text}
          maxLength={MAX}
          aria-label="Instructions for this chat"
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. You are reviewing a legal contract. Be precise and flag anything ambiguous."
          className="mt-4 min-h-40 flex-1 resize-y rounded-lg border border-border bg-transparent p-3 text-sm text-primary outline-none transition placeholder:text-primary/35 focus:border-brand/40"
        />
        <p className="mt-1 text-right text-[11px] text-primary/35">
          {[...text].length}/{MAX}
        </p>

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-border px-4 py-1.5 text-sm text-primary/80 transition hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !hydrated}
            className="rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
