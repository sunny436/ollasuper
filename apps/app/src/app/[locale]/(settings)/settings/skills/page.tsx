"use client";

import { ConfirmButton } from "@/components/confirm-button";
import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { Button } from "@v1/ui/button";
import { Switch } from "@v1/ui/switch";
import { useMutation, usePaginatedQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { type EditableSkill, SkillFormDialog } from "./_components/skill-form-dialog";

/**
 * My Skills — the user's own custom guidance.
 *
 * WHY SETTINGS AND NOT THE WORKSPACE RAIL. The rail holds Projects and
 * Scheduled: things you OPERATE inside one workspace. Skills are owner-scoped
 * and follow the person across workspaces (the same shape Memories has), and
 * they are configuration rather than work. Putting them in the rail would imply
 * a workspace boundary the data does not have.
 *
 * NOT THE SAME THING AS THE COMPOSER'S "Skills" MENU. That menu lists what this
 * DEPLOYMENT can do and types a starter prompt into the composer; it activates
 * nothing. These are guidance you wrote. Both surfaces are kept, and the copy
 * here is careful never to imply this grants the assistant new abilities.
 */

const PAGE = 30;

export default function SkillsSection() {
  const { current } = useWorkspace();
  const {
    results: skills,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.userSkills.list,
    current ? { workspaceId: current } : "skip",
    { initialNumItems: PAGE },
  );
  const setEnabled = useMutation(api.userSkills.setEnabled);
  const remove = useMutation(api.userSkills.remove);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EditableSkill | null>(null);
  // Which rows have a toggle in flight, so one slow row cannot disable the
  // whole list and two rows can be toggled independently.
  const [pending, setPending] = useState<Set<string>>(new Set());

  const markPending = (id: string, on: boolean) =>
    setPending((p) => {
      const next = new Set(p);
      on ? next.add(id) : next.delete(id);
      return next;
    });

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (s: EditableSkill) => {
    setEditing(s);
    setDialogOpen(true);
  };

  const toggle = async (id: Id<"userSkills">, enabled: boolean) => {
    markPending(id, true);
    try {
      await setEnabled({ skillId: id, enabled });
    } catch {
      // The list is a live query, so the switch simply snaps back to the stored
      // value — there is no optimistic state here to unwind.
      toast.error("Couldn't update the skill");
    } finally {
      markPending(id, false);
    }
  };

  const loading = status === "LoadingFirstPage";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">
            My Skills
          </h1>
          <p className="mt-1 max-w-xl text-sm text-primary/55">
            Guidance you write once and the assistant follows when a task fits.
            Private to you, and used across your workspaces. Skills shape how it
            answers — they do not change what it is allowed to do.
          </p>
        </div>
        <Button size="sm" disabled={!current} onClick={openCreate}>
          New skill
        </Button>
      </div>

      {loading && (
        <p
          className="rounded-2xl border border-border bg-card/60 p-8 text-center text-sm text-primary/50 backdrop-blur-xl"
          aria-live="polite"
        >
          Loading your skills…
        </p>
      )}

      {!loading && skills.length === 0 && (
        <div className="rounded-2xl border border-border bg-card/60 p-8 text-center backdrop-blur-xl">
          <p className="text-sm text-primary/60">You have no skills yet.</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-primary/45">
            A skill is a short set of instructions for a kind of task you do
            often — reviewing contracts, writing release notes, triaging bugs.
          </p>
          <Button
            size="sm"
            className="mt-4"
            disabled={!current}
            onClick={openCreate}
          >
            Create your first skill
          </Button>
        </div>
      )}

      {skills.length > 0 && (
        <ul className="flex flex-col gap-3">
          {skills.map((s) => {
            const busy = pending.has(s._id);
            return (
              <li
                key={s._id}
                className="rounded-2xl border border-border bg-card/60 p-4 backdrop-blur-xl"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p
                      className={`truncate text-sm font-medium ${
                        s.enabled ? "text-primary/85" : "text-primary/40"
                      }`}
                    >
                      {s.name}
                    </p>
                    {s.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-primary/55">
                        {s.description}
                      </p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-primary/45">
                      {!s.enabled && (
                        <span className="rounded bg-primary/5 px-1.5 py-0.5">
                          Off
                        </span>
                      )}
                      <span>
                        Updated {new Date(s.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    <Switch
                      checked={s.enabled}
                      disabled={busy}
                      aria-label={`Use ${s.name}`}
                      onCheckedChange={(v) => void toggle(s._id, v)}
                    />
                    <button
                      type="button"
                      className="text-xs text-primary/55 underline underline-offset-2 hover:text-primary/80"
                      onClick={() =>
                        openEdit({
                          _id: s._id,
                          name: s.name,
                          description: s.description,
                          instructions: s.instructions,
                          constraints: s.constraints,
                        })
                      }
                    >
                      Edit
                    </button>
                    <ConfirmButton
                      label="Delete"
                      title="Delete this skill?"
                      description={`"${s.name}" will stop being used from your next message. Chats it already influenced are unchanged. This cannot be undone.`}
                      confirmLabel="Delete"
                      onConfirm={async () => {
                        try {
                          await remove({ skillId: s._id });
                          toast.success("Skill deleted");
                        } catch {
                          toast.error("Couldn't delete the skill");
                        }
                      }}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {status === "CanLoadMore" && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => loadMore(PAGE)}
        >
          Load more
        </Button>
      )}

      <SkillFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workspaceId={current ?? null}
        skill={editing}
      />
    </div>
  );
}
