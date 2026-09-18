"use client";

import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { Dialog, DialogContent, DialogTitle } from "@v1/ui/dialog";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
  type ScheduleSpec,
  recurrenceLabel,
  scheduleSummary,
} from "../_lib/schedule-format";
import { ScheduleFields, specGaps } from "./schedule-fields";

/**
 * The edit modal from the product reference: PROMPT, then the FREQUENCY block,
 * then Cancel / Save.
 *
 * `expectedRevision` is what makes a concurrent edit safe. The dialog sends the
 * revision it was OPENED with; if the task moved on in another tab the save is
 * refused rather than silently overwriting, and the user is offered a reload.
 *
 * A COMPLETED task cannot be edited — Phase 1 refuses an update once terminal,
 * and an `endsAt` schedule reaching its end is a new way to get there. Rather
 * than a dead end, the same dialog runs in `duplicate` mode and creates a NEW
 * task from the old one's values.
 *
 * DialogContent carries `className="workspace"`: Radix portals to document.body,
 * outside the token scope (share-dialog.tsx precedent).
 */
export function EditTaskDialog({
  task,
  duplicate = false,
  open,
  onOpenChange,
}: {
  task: {
    _id: Id<"scheduledTasks">;
    title: string;
    prompt: string;
    spec: ScheduleSpec;
    revision: number;
    status: string;
  };
  duplicate?: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const { current } = useWorkspace();
  const update = useMutation(api.scheduled.tasks.update);
  const create = useMutation(api.scheduled.tasks.create);

  const [title, setTitle] = useState(
    duplicate ? `${task.title} (copy)` : task.title,
  );
  const [prompt, setPrompt] = useState(task.prompt);
  const [spec, setSpec] = useState<ScheduleSpec>(task.spec);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);

  // Switching Repeat to Weekly no longer pre-selects Monday, so the spec can
  // legitimately be half-built while the dialog is open. Phase 1 rejects an
  // empty weekly schedule, so refuse to submit one rather than surfacing that
  // as a server error the user cannot act on.
  const gaps = specGaps(spec);

  const dirty =
    duplicate ||
    title !== task.title ||
    prompt !== task.prompt ||
    JSON.stringify(spec) !== JSON.stringify(task.spec);

  async function save() {
    if (!prompt.trim()) {
      toast.error("A scheduled task needs an instruction");
      return;
    }
    setBusy(true);
    try {
      if (duplicate) {
        if (!current) return;
        const id = await create({
          workspaceId: current,
          title,
          prompt,
          // biome-ignore lint/suspicious/noExplicitAny: the validator owns the shape
          spec: spec as any,
        });
        toast.success("Scheduled task created");
        onOpenChange(false);
        router.push(`/scheduled/${id}`);
        return;
      }
      await update({
        taskId: task._id,
        title,
        prompt,
        // biome-ignore lint/suspicious/noExplicitAny: the validator owns the shape
        spec: spec as any,
        expectedRevision: task.revision,
      });
      toast.success("Schedule updated");
      onOpenChange(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't save";
      if (/changed elsewhere/i.test(msg)) {
        // Never clobber: show the conflict and let the user reload the newer
        // state rather than deciding for them.
        setConflict(true);
      } else if (/already complete/i.test(msg)) {
        toast.error("This task's schedule has ended — duplicate it instead");
        onOpenChange(false);
      } else if (/Not found/i.test(msg)) {
        toast.error("This task was deleted");
        onOpenChange(false);
        router.push("/scheduled");
      } else {
        toast.error(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="scrollbar-quiet workspace max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          {duplicate
            ? "Duplicate"
            : task.status === "paused"
              ? "Paused"
              : recurrenceLabel(task.spec)}
        </div>
        {/* DialogTitle, not a bare h2: Radix needs it to label the dialog for
            screen readers, and warns through console.error when it is missing —
            which also fails the e2e zero-console-error gate. It renders an h2
            anyway, so this is the same markup with the accessibility attached. */}
        <DialogTitle className="mt-1 text-lg font-semibold text-primary">
          {duplicate ? "Duplicate scheduled task" : task.title}
        </DialogTitle>

        {conflict && (
          <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <p className="text-primary/80">
              This task changed somewhere else while you were editing.
            </p>
            <button
              type="button"
              onClick={() => {
                setConflict(false);
                onOpenChange(false);
                router.refresh();
              }}
              className="mt-2 text-xs text-brand-ink hover:underline"
            >
              Reload the latest version
            </button>
          </div>
        )}

        <label className="mt-5 block">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            Name
          </span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            className="mt-2 w-full rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm text-primary outline-none focus:border-brand/40"
          />
        </label>

        <label className="mt-4 block">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            Prompt
          </span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            maxLength={8000}
            className="mt-2 w-full resize-y rounded-xl border border-border bg-card px-3.5 py-3 text-sm leading-relaxed text-primary outline-none focus:border-brand/40"
          />
        </label>

        <div className="mt-5">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            Frequency
          </span>
          <div className="mt-2">
            <ScheduleFields value={spec} onChange={setSpec} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {scheduleSummary(spec)}
          </p>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-full border border-border px-4 py-1.5 text-sm text-primary/80 transition hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !dirty || gaps.length > 0}
            title={gaps.length > 0 ? "Pick a day" : undefined}
            onClick={save}
            className="rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 disabled:opacity-40"
          >
            {busy ? "Saving…" : duplicate ? "Create" : "Save"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
