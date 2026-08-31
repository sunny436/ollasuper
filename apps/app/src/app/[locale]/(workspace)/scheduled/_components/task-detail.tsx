"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  CalendarClock,
  History,
  Loader2,
  MessageSquare,
  Pencil,
  X,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
  formatInstant,
  recurrenceLabel,
  relative,
  runErrorCopy,
  runStatusLabel,
  scheduleSummary,
} from "../_lib/schedule-format";
import { EditTaskDialog } from "./edit-task-dialog";
import { RunResult } from "./run-result";
import { ScheduledTranscript } from "./scheduled-transcript";

/**
 * The right-hand task panel from the product reference.
 *
 * Header (title, "Paused · Daily", edit, close), a list of runs, and an
 * "Open chat" footer. Opening a run or the transcript stays INSIDE this panel:
 * the scheduled execution thread is hidden from /chat by design, and this
 * surface renders no composer, so there is no send path to expose.
 *
 * The selected run rides in a query param rather than component state, so a run
 * is deep-linkable and survives a refresh.
 */
export function TaskDetail({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const runId = search.get("run");
  const showThread = search.get("view") === "thread";
  const [editing, setEditing] = useState(false);

  // `taskId` comes from the URL. It is only narrowed at the call site, and a
  // bad id surfaces as the not-found panel rather than an ArgumentValidationError.
  const task = useQuery(api.scheduled.tasks.get, {
    taskId: taskId as Id<"scheduledTasks">,
  });
  const active = useQuery(api.scheduled.tasks.activeRun, {
    taskId: taskId as Id<"scheduledTasks">,
  });
  const history = useQuery(api.scheduled.tasks.history, {
    taskId: taskId as Id<"scheduledTasks">,
    limit: 25,
  });
  const cancelOccurrence = useMutation(api.scheduled.tasks.cancelOccurrence);

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(search.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  // `undefined` is loading; a thrown query renders as null via the boundary.
  const notFound = task === null;

  return (
    <aside className="hidden w-[420px] shrink-0 flex-col border-l border-border bg-card/60 backdrop-blur-xl lg:flex">
      <Header
        title={task?.title ?? (notFound ? "Unavailable" : "Loading…")}
        subtitle={
          task
            ? `${task.status === "paused" ? "Paused" : task.status === "completed" ? "Completed" : "Active"} · ${recurrenceLabel(task.spec)}`
            : ""
        }
        canEdit={Boolean(task && task.status !== "completed")}
        onEdit={() => setEditing(true)}
        onClose={onClose}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {notFound && (
          <EmptyPanel
            icon={CalendarClock}
            title="This scheduled task was deleted"
            body="Its past runs are kept, but they are no longer viewable."
          />
        )}

        {task && showThread && (
          <div>
            <BackButton
              label="Back to runs"
              onClick={() => setParam("view", null)}
            />
            <ScheduledTranscript taskId={taskId} />
          </div>
        )}

        {task && !showThread && runId && (
          <div>
            <BackButton
              label="Back to runs"
              onClick={() => setParam("run", null)}
            />
            <RunResult taskId={taskId} occurrenceId={runId} />
          </div>
        )}

        {task && !showThread && !runId && (
          <>
            <p className="text-xs text-muted-foreground">
              {scheduleSummary(task.spec)}
            </p>
            {task.status === "active" && task.nextRunAt && (
              <p className="mt-1 text-xs text-primary/60">
                Next run {relative(task.nextRunAt)} ·{" "}
                {formatInstant(task.nextRunAt, task.spec.timezone)}
              </p>
            )}
            {task.status === "paused" && (
              <p className="mt-1 text-xs text-primary/60">
                Paused — runs during a pause are skipped, not made up
                afterwards.
              </p>
            )}
            {task.terminalReason === "schedule_ended" && (
              <p className="mt-1 text-xs text-primary/60">
                This schedule reached its end date.
              </p>
            )}
            {task.invalidReason && (
              <p className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-primary/75">
                This task is not running: {runErrorCopy(task.invalidReason)}
              </p>
            )}

            <div className="mt-5 space-y-1.5">
              {active && (
                <RunRow
                  run={active}
                  timezone={task.spec.timezone}
                  onOpen={() => setParam("run", active._id)}
                  onCancel={async () => {
                    try {
                      await cancelOccurrence({ occurrenceId: active._id });
                      toast.success("Cancellation requested");
                    } catch (e) {
                      toast.error(
                        e instanceof Error ? e.message : "Couldn't cancel",
                      );
                    }
                  }}
                />
              )}
              {history?.page.map((run) => (
                <RunRow
                  key={run._id}
                  run={run}
                  timezone={task.spec.timezone}
                  onOpen={() => setParam("run", run._id)}
                />
              ))}
              {history && history.page.length === 0 && !active && (
                <EmptyPanel
                  icon={History}
                  title="No updates available"
                  body="Runs will appear here once this task has executed."
                />
              )}
              {history === undefined && (
                <div className="space-y-1.5" aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="h-12 animate-pulse rounded-lg bg-primary/5"
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {task && !showThread && !runId && (
        <div className="shrink-0 border-t border-border p-3">
          <button
            type="button"
            onClick={() => setParam("view", "thread")}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-primary/5 py-2.5 text-sm font-medium text-primary transition hover:bg-primary/10"
          >
            <MessageSquare className="h-4 w-4" />
            Open chat
          </button>
        </div>
      )}

      {task && editing && (
        <EditTaskDialog
          task={task}
          open={editing}
          onOpenChange={setEditing}
        />
      )}
    </aside>
  );
}

function Header({
  title,
  subtitle,
  canEdit,
  onEdit,
  onClose,
}: {
  title: string;
  subtitle: string;
  canEdit: boolean;
  onEdit: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3.5">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-primary">{title}</h2>
        {subtitle && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {subtitle}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {canEdit && (
          <button
            type="button"
            aria-label="Edit task"
            onClick={onEdit}
            className="rounded-md p-1.5 text-primary/50 hover:bg-primary/5 hover:text-primary"
          >
            <Pencil className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          aria-label="Close panel"
          onClick={onClose}
          className="rounded-md p-1.5 text-primary/50 hover:bg-primary/5 hover:text-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-3 flex items-center gap-1.5 text-xs text-primary/60 transition hover:text-primary"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function RunRow({
  run,
  timezone,
  onOpen,
  onCancel,
}: {
  run: {
    _id: Id<"scheduledTaskOccurrences">;
    scheduledFor: number;
    status: string;
    kind: string;
    attempts: number;
    errorCode: string | null;
  };
  timezone: string;
  onOpen: () => void;
  onCancel?: () => void;
}) {
  const live = run.status === "running" || run.status === "retrying";
  return (
    <div className="group flex items-center gap-2 rounded-lg px-2.5 py-2 transition hover:bg-primary/5">
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left outline-none"
      >
        <span className="flex items-center gap-1.5 text-sm text-primary/85">
          {live && <Loader2 className="h-3 w-3 animate-spin text-brand-ink" />}
          {runStatusLabel(run.status, run.scheduledFor)}
          {run.kind === "manual" && (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              manual
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {formatInstant(run.scheduledFor, timezone)}
          {run.status === "retrying" && ` · attempt ${run.attempts + 1} of 3`}
          {run.status === "failed" && run.errorCode
            ? ` · ${runErrorCopy(run.errorCode)}`
            : ""}
        </span>
      </button>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-md px-2 py-1 text-xs text-primary/50 opacity-0 transition hover:bg-primary/5 hover:text-primary group-hover:opacity-100"
        >
          Cancel
        </button>
      )}
    </div>
  );
}

function EmptyPanel({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof History;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <Icon className="h-5 w-5 text-primary/30" />
      <p className="mt-3 text-sm text-primary/70">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
    </div>
  );
}
