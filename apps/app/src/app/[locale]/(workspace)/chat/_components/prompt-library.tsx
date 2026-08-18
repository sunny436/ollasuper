"use client";

import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Plus, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useComposer } from "../_hooks/use-composer";

interface Prompt {
  _id: Id<"chatPrompts">;
  title: string;
  body: string;
  description: string | null;
  tags: string[];
  shared: boolean;
  usageCount: number;
  isOwn: boolean;
}

export function PromptLibrary({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { current } = useWorkspace();
  const { setDraft } = useComposer();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const prompts = useQuery(
    api.chat.prompts.list,
    current && open ? { workspaceId: current } : "skip",
  ) as Prompt[] | undefined;

  const create = useMutation(api.chat.prompts.create);
  const remove = useMutation(api.chat.prompts.remove);
  const recordUse = useMutation(api.chat.prompts.recordUse);

  // Prompt libraries are O(100) and fully resident here, so client-side
  // filtering is correct — unlike conversations, where the corpus is never on
  // the client and search must be a server index.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !prompts) return prompts ?? [];
    return prompts.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.body.toLowerCase().includes(q) ||
        p.tags.some((t) => t.includes(q)),
    );
  }, [prompts, query]);

  if (!open) return null;

  const onCreate = async () => {
    if (!current || !title.trim() || !body.trim()) return;
    try {
      await create({ workspaceId: current, title, body });
      setTitle("");
      setBody("");
      setCreating(false);
    } catch {
      toast.error("Couldn't save that prompt");
    }
  };

  const use = async (p: Prompt) => {
    setDraft(p.body);
    onClose();
    try {
      await recordUse({ promptId: p._id });
    } catch {
      // Usage counting is cosmetic; never block inserting the prompt for it.
    }
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape handled by the dialog */}
      <div
        className="fixed inset-0 z-40 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Prompt library"
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[min(36rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium text-primary">Prompt library</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-primary/50 transition hover:bg-primary/5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-primary/35" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search prompts"
            aria-label="Search prompts"
            className="w-full bg-transparent text-sm text-primary outline-none placeholder:text-primary/35"
          />
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="flex shrink-0 items-center gap-1 rounded-md bg-brand px-2 py-1 text-xs font-medium text-brand-foreground transition hover:brightness-110"
          >
            <Plus className="h-3 w-3" /> New
          </button>
        </div>

        {creating && (
          <div className="space-y-2 border-b border-border bg-primary/[0.02] px-4 py-3">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title"
              aria-label="Prompt title"
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-brand/40"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Prompt text…"
              aria-label="Prompt text"
              rows={4}
              className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-brand/40"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded-md px-2.5 py-1 text-xs text-primary/60 hover:bg-primary/5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void onCreate()}
                disabled={!title.trim() || !body.trim()}
                className="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-brand-foreground transition hover:brightness-110 disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {prompts === undefined && (
            <div className="space-y-1.5 p-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-md bg-primary/5" />
              ))}
            </div>
          )}
          {prompts && filtered.length === 0 && (
            <p className="p-6 text-center text-xs text-primary/50">
              {query ? "No prompts match" : "No saved prompts yet"}
            </p>
          )}
          {filtered.map((p) => (
            <div
              key={p._id}
              className="group flex items-start gap-2 rounded-lg p-2.5 transition hover:bg-primary/5"
            >
              <button
                type="button"
                onClick={() => void use(p)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block text-sm text-primary/90">{p.title}</span>
                <span className="mt-0.5 line-clamp-2 block text-xs text-primary/45">
                  {p.body}
                </span>
              </button>
              {p.isOwn && (
                <button
                  type="button"
                  aria-label={`Delete ${p.title}`}
                  onClick={async () => {
                    if (!window.confirm(`Delete “${p.title}”?`)) return;
                    try {
                      await remove({ promptId: p._id });
                    } catch {
                      toast.error("Couldn't delete that prompt");
                    }
                  }}
                  className="shrink-0 rounded p-1 text-primary/25 opacity-0 transition hover:bg-primary/10 hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
