"use client";

import { Dialog, DialogContent, DialogTitle } from "@v1/ui/dialog";
import { RunResult } from "./run-result";

/**
 * One completed run, in a dedicated modal.
 *
 * WHY IT IS DRIVEN BY THE `?run=` PARAM AND NOT LOCAL STATE. The notifications
 * bell deep-links straight at a run — `/scheduled/${taskId}?run=${occurrenceId}`
 * (notifications-bell.tsx) — so a modal opened from component state would leave
 * every scheduled-run notification pointing at a page that no longer opens
 * anything. Reading the param keeps the deep link working and keeps a run
 * refresh-survivable, which is what the panel already relied on.
 *
 * Closing clears the param through the caller's `setParam`, which is a
 * `router.replace(..., { scroll: false })` on the SAME route — so opening and
 * closing never navigates away from Scheduled Tasks.
 *
 * `className="workspace"` is load-bearing: Radix portals to document.body,
 * outside the token scope that re-points --card/--border/--background for this
 * subtree, so without it the dialog renders against the base palette
 * (share-dialog.tsx and edit-task-dialog.tsx carry it for the same reason).
 */
export function RunResultDialog({
  taskId,
  occurrenceId,
  title,
  onClose,
}: {
  taskId: string;
  occurrenceId: string;
  title: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/*
        max-w-3xl rather than the default max-w-lg: a scheduled report is
        long-form and routinely contains tables and code blocks, which a narrow
        column wrecks.

        The scroll lives on the INNER region, not on DialogContent, so the
        report scrolls inside the modal while the title and the close button
        stay put. DialogContent's own X is absolutely positioned, so it is
        unaffected by the scroll either way — and Radix supplies Esc, the focus
        trap and the overlay click.
      */}
      <DialogContent className="workspace flex max-h-[85vh] flex-col gap-0 sm:max-w-3xl">
        <DialogTitle className="shrink-0 pr-8 text-base font-semibold text-primary">
          {title}
        </DialogTitle>
        <div className="scrollbar-quiet mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
          <RunResult taskId={taskId} occurrenceId={occurrenceId} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
