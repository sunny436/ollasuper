"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, usePaginatedQuery } from "convex/react";
import { Brain, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * A Project's instructions and what it has learned.
 *
 * INSTRUCTIONS ARE DYNAMIC. They live on the Project and are read fresh on every
 * turn, so editing them changes the next reply in every chat inside the Project
 * — including conversations that already exist. The copy says so explicitly,
 * because the alternative reading ("this only affects new chats") is the one
 * users assume, and it would be wrong.
 *
 * Neither control is a security boundary: `setInstructions` re-authorizes the
 * Project server-side, and the memory list is a scoped query. The UI only
 * decides what is worth showing.
 */

const MAX_INSTRUCTIONS = 8000;
const PAGE = 20;

export function ProjectInstructions({
  projectId,
  initial,
  archived,
}: {
  projectId: Id<"projects">;
  initial: string | null;
  archived: boolean;
}) {
  const setInstructions = useMutation(api.projects.setInstructions);
  const [value, setValue] = useState(initial ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed when the server value arrives or the Project changes. Without the
  // guard a save would be clobbered by its own round-trip.
  useEffect(() => {
    setValue(initial ?? "");
  }, [initial]);

  const dirty = value.trim() !== (initial ?? "").trim();
  const tooLong = value.length > MAX_INSTRUCTIONS;

  const save = async () => {
    if (!dirty || tooLong || saving) return;
    setSaving(true);
    setError(null);
    try {
      await setInstructions({
        projectId,
        instructions: value.trim() ? value.trim() : null,
      });
      toast.success("Instructions saved");
    } catch (e) {
      // Never console.error — the Convex client already logs rejections and
      // every e2e script asserts zero console errors.
      setError(
        e instanceof Error && e.message
          ? cleanError(e.message)
          : "Couldn't save those instructions",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-6">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Instructions
      </h2>
      <p className="mt-2 text-xs text-muted-foreground">
        How this project should be worked in. Applies to{" "}
        <span className="font-medium text-primary/70">every chat</span> in it,
        including ones you already started.
      </p>

      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={archived}
        rows={5}
        placeholder="e.g. Always cite sources. Prefer tables over prose. This project is a UK entity — use British English."
        aria-label="Project instructions"
        className="mt-3 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm text-primary outline-none transition focus:border-brand disabled:opacity-50"
      />

      <div className="mt-2 flex items-center justify-between gap-3">
        <span
          className={`text-xs tabular-nums ${
            tooLong ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {value.length.toLocaleString()} / {MAX_INSTRUCTIONS.toLocaleString()}
        </span>
        {!archived && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || tooLong || saving}
            className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground shadow-sm transition hover:brightness-110 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {archived && (
        <p className="mt-2 text-xs text-muted-foreground">
          This project is archived. Restore it to change its instructions.
        </p>
      )}

      <ProjectMemories projectId={projectId} />
    </section>
  );
}

/**
 * What the project has remembered.
 *
 * Deletion reuses `memories.remove`, which authorizes on the memory's owner —
 * the same mutation Settings → Memories uses. There is no Project-specific
 * delete path, because a user pruning their own memory is the same operation
 * wherever they do it from.
 */
function ProjectMemories({ projectId }: { projectId: Id<"projects"> }) {
  const removeMemory = useMutation(api.memories.remove);
  const { results, status, loadMore } = usePaginatedQuery(
    api.projects.listMemories,
    { projectId },
    { initialNumItems: PAGE },
  );

  const forget = async (memoryId: Id<"userMemories">) => {
    try {
      await removeMemory({ memoryId });
      toast.success("Memory removed");
    } catch {
      toast.error("Couldn't remove that memory");
    }
  };

  return (
    <div className="mt-8">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Project memory
      </h2>
      <p className="mt-2 text-xs text-muted-foreground">
        Things learned while working in this project. They stay here — other
        chats never see them.
      </p>

      {status === "LoadingFirstPage" && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      )}

      {status !== "LoadingFirstPage" && results.length === 0 && (
        <p className="mt-3 rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
          Nothing remembered yet.
        </p>
      )}

      {results.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {results.map((m) => (
            <li
              key={m._id}
              className="group flex items-start gap-3 rounded-xl border border-border bg-card px-3 py-2.5"
            >
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/5 text-primary/50">
                <Brain className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-primary">{m.content}</span>
                <span className="block text-xs text-muted-foreground">
                  {m.kind}
                </span>
              </span>
              <button
                type="button"
                aria-label="Forget this memory"
                onClick={() => void forget(m._id)}
                className="shrink-0 rounded p-1 text-primary/30 opacity-0 transition hover:bg-primary/10 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {status === "CanLoadMore" && (
        <button
          type="button"
          onClick={() => loadMore(PAGE)}
          className="mt-2 w-full rounded-md px-2 py-1.5 text-xs text-primary/50 transition hover:bg-primary/5"
        >
          Load more
        </button>
      )}
    </div>
  );
}

/** Convex wraps thrown ConvexErrors with framing noise; show just the message. */
function cleanError(raw: string): string {
  const m = /Uncaught ConvexError:\s*(.+?)(\n|$)/.exec(raw);
  if (m?.[1]) return m[1];
  return raw.split("\n")[0]?.slice(0, 160) ?? "Couldn't save those instructions";
}
