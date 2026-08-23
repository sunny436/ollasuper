"use client";

import { ConfirmButton } from "@/components/confirm-button";
import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { Button } from "@v1/ui/button";
import { Switch } from "@v1/ui/switch";
import {
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import { toast } from "sonner";

const KIND_LABEL: Record<string, string> = {
  preference: "Preference",
  instruction: "Instruction",
  fact: "Fact",
  project_context: "Project",
};

export default function MemoriesSection() {
  const { current } = useWorkspace();
  const settings = useQuery(
    api.chat.settings.get,
    current ? { workspaceId: current } : "skip",
  );
  const upsert = useMutation(api.chat.settings.upsert);
  const {
    results: memories,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.memories.list,
    current ? { workspaceId: current } : "skip",
    { initialNumItems: 30 },
  );
  const remove = useMutation(api.memories.remove);
  const update = useMutation(api.memories.update);
  const setDisabled = useMutation(api.memories.setDisabled);
  const clearAll = useMutation(api.memories.clearAll);

  // Memory is on unless the user turned it off (matches dispatchPayload).
  const memoryEnabled = settings ? settings.memoryEnabled !== false : true;

  const onEdit = async (id: Id<"userMemories">, currentText: string) => {
    const next = window.prompt("Edit this memory", currentText);
    if (next == null || next.trim() === "" || next === currentText) return;
    try {
      await update({ memoryId: id, content: next.trim() });
      toast.success("Memory updated");
    } catch {
      toast.error("Could not update memory");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">
            Memories
          </h1>
          <p className="mt-1 text-sm text-primary/55">
            Facts and preferences the assistant remembers about you across
            conversations. Your documents live in Files; this is long-term
            personal memory.
          </p>
        </div>
        {memories.length > 0 && (
          <ConfirmButton
            label="Clear all"
            title="Forget everything?"
            description="This permanently deletes every memory. It cannot be undone."
            confirmLabel="Delete all"
            onConfirm={async () => {
              if (!current) return;
              await clearAll({ workspaceId: current });
              toast.success("All memories cleared");
            }}
          />
        )}
      </div>

      {/* Master switch */}
      <div className="flex items-center justify-between rounded-2xl border border-border bg-card/60 p-6 backdrop-blur-xl">
        <div>
          <h2 className="text-sm font-medium text-primary/80">
            Enable memory
          </h2>
          <p className="mt-1 text-xs text-primary/45">
            When off, the assistant neither saves new memories nor uses existing
            ones. Your saved memories are kept until you delete them.
          </p>
        </div>
        <Switch
          checked={memoryEnabled}
          disabled={!current}
          aria-label="Enable memory"
          onCheckedChange={async (v) => {
            if (!current) return;
            try {
              await upsert({ workspaceId: current, memoryEnabled: v });
            } catch {
              toast.error("Could not update setting");
            }
          }}
        />
      </div>

      {/* List */}
      {memories.length === 0 ? (
        <p className="text-sm text-primary/45">
          No memories yet. Ask the assistant to remember something — e.g.
          &ldquo;remember that I prefer concise answers&rdquo;.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {memories.map((m) => (
            <li
              key={m._id}
              className="rounded-2xl border border-border bg-card/60 p-4 backdrop-blur-xl"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p
                    className={
                      m.status === "disabled"
                        ? "text-sm text-primary/40 line-through"
                        : "text-sm text-primary/85"
                    }
                  >
                    {m.content}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-primary/45">
                    <span className="rounded bg-primary/5 px-1.5 py-0.5">
                      {KIND_LABEL[m.kind] ?? m.kind}
                    </span>
                    <span>
                      {m.source === "inferred" ? "inferred" : "you told me"}
                    </span>
                    {m.status === "disabled" && <span>· off</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Switch
                    checked={m.status !== "disabled"}
                    aria-label="Use this memory"
                    onCheckedChange={async (v) => {
                      try {
                        await setDisabled({ memoryId: m._id, disabled: !v });
                      } catch {
                        toast.error("Could not update memory");
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="text-xs text-primary/55 underline"
                    onClick={() => onEdit(m._id, m.content)}
                  >
                    Edit
                  </button>
                  <ConfirmButton
                    label="Delete"
                    title="Forget this memory?"
                    description={m.content}
                    confirmLabel="Delete"
                    onConfirm={async () => {
                      await remove({ memoryId: m._id });
                      toast.success("Memory deleted");
                    }}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {status === "CanLoadMore" && (
        <Button
          variant="outline"
          className="self-start"
          onClick={() => loadMore(30)}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
