"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
  Bell,
  CalendarClock,
  Copy,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Share2,
  Trash2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ShareDialog } from "../../chat/_components/share-dialog";
import {
  type ScheduleSpec,
  recurrenceLabel,
  relative,
} from "../_lib/schedule-format";
import { ConfirmDialog } from "./confirm-dialog";
import { EditTaskDialog } from "./edit-task-dialog";
import { NotifyPrefsPopover } from "./notify-prefs";

export interface TaskRowData {
  _id: Id<"scheduledTasks">;
  title: string;
  prompt: string;
  spec: ScheduleSpec;
  status: string;
  revision: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  // Phase 4 email preferences. Default OFF (the backend returns an explicit
  // boolean), unlike the in-app pair above which default ON.
  emailOnSuccess: boolean;
  emailOnFailure: boolean;
  attachPdf: boolean;
  terminalReason: string | null;
}

/**
 * One task in the list: icon, title, "Paused · Daily", and — on hover — the
 * pencil and the overflow menu from the product reference.
 *
 * Every destructive or state-changing action is a real mutation; the row shows
 * pending state locally but never fabricates the outcome.
 */
export function TaskRow({
  task,
  selected,
  onOpen,
  onPaused,
}: {
  task: TaskRowData;
  selected: boolean;
  onOpen: () => void;
  /**
   * Fired after a successful pause. The list filters strictly on status, so
   * without this the row a user just paused would vanish from the default
   * view with no obvious way back to resume it.
   */
  onPaused?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Near the bottom of a short (landscape phone) viewport the menu opens upward.
  const [menuUp, setMenuUp] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [shareMessageId, setShareMessageId] =
    useState<Id<"chatMessages"> | null>(null);
  const [busy, setBusy] = useState(false);

  const pause = useMutation(api.scheduled.tasks.pause);
  const resume = useMutation(api.scheduled.tasks.resume);
  const remove = useMutation(api.scheduled.tasks.remove);
  const runNow = useMutation(api.scheduled.tasks.runNow);

  // Only fetched when the menu is open — Share needs the newest successful run,
  // and a task list should not pay for that on every row.
  const history = useQuery(
    api.scheduled.tasks.history,
    menuOpen ? { taskId: task._id, limit: 10 } : "skip",
  );
  const shareable =
    history?.page.find((o) => o.status === "succeeded" && o.messageId)
      ?.messageId ?? null;

  /**
   * Correct the flip from the menu's REAL geometry, once it exists.
   *
   * The onClick guess uses the trigger's rect and a 240px estimate of the menu
   * height, both taken before the browser has finished reacting to the click.
   * qa-responsive caught the result at 1280x800: a menu spanning y 653-852 on an
   * 800px viewport — 52px of it unreachable. Measuring the element itself has no
   * estimate to be wrong about.
   *
   * useLayoutEffect, not useEffect: this runs before paint, so the menu is never
   * seen in the wrong position.
   */
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!menuUp && r.bottom > window.innerHeight - 8 && r.top - r.height > 8) {
      setMenuUp(true);
    } else if (menuUp && r.top < 8) {
      setMenuUp(false);
    }
  }, [menuOpen, menuUp]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const paused = task.status === "paused";
  const completed = task.status === "completed";

  async function guard(fn: () => Promise<unknown>, failure: string) {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : failure);
      return null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div
        className={`group flex items-center gap-3 rounded-xl border px-3 py-3 transition-colors ${
          selected
            ? "border-brand/40 bg-brand/5"
            : "border-transparent bg-card hover:border-border hover:bg-card"
        }`}
      >
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand-ink">
            <CalendarClock className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-primary">
              {task.title}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {completed
                ? "Completed"
                : paused
                  ? "Paused"
                  : task.nextRunAt
                    ? `Next ${relative(task.nextRunAt)}`
                    : "Active"}
              {" · "}
              {recurrenceLabel(task.spec)}
            </span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          {!completed && (
            <button
              type="button"
              aria-label="Edit task"
              onClick={() => setEditing(true)}
              className="rounded-md p-1.5 text-primary/65 hover:bg-primary/5 hover:text-primary [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          <div className="relative">
            <button
              type="button"
              aria-label="Task actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(e) => {
                // A first guess from the TRIGGER's position, so the menu opens
                // in roughly the right place on the very first frame. The
                // layout effect below then corrects it from the menu's real
                // measured height — 240 is an estimate, and this guess is taken
                // before the click's own scroll-into-view has settled, which is
                // how a menu ended up 52px under the fold at 1280x800
                // (caught by qa-responsive, not by eye).
                const r = e.currentTarget.getBoundingClientRect();
                setMenuUp(r.bottom + 240 > window.innerHeight && r.top > 240);
                setMenuOpen((v) => !v);
              }}
              className="rounded-md p-1.5 text-primary/65 hover:bg-primary/5 hover:text-primary [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>

            {menuOpen && (
              <>
                <button
                  type="button"
                  aria-label="Close menu"
                  className="fixed inset-0 z-40 cursor-default"
                  onClick={() => setMenuOpen(false)}
                />
                {/* role="menu" rather than <menu>: the native element has
                    no cross-browser styling story, and the buttons below carry
                    role="menuitem" so the a11y tree is still correct. */}
                <div
                  ref={menuRef}
                  role="menu"
                  className={`absolute right-0 z-50 w-56 overflow-hidden rounded-xl border border-border bg-card p-1 shadow-md ${menuUp ? "bottom-full mb-1" : "mt-1"}`}
                >
                  {/*
                    Run now is DISABLED while paused. Server-side it would create
                    a `held` occurrence — durable but never executed — so
                    offering it would look like it worked and silently do
                    nothing. The tooltip says what to do instead.
                  */}
                  <MenuItem
                    icon={RefreshCw}
                    label="Run now"
                    disabled={busy || paused || completed}
                    title={
                      paused ? "Resume this task to run it now" : undefined
                    }
                    onClick={async () => {
                      setMenuOpen(false);
                      const res = (await guard(
                        () => runNow({ taskId: task._id }),
                        "Couldn't start the run",
                      )) as { queued: boolean; reason: string | null } | null;
                      if (res?.queued) toast.success("Run queued");
                      else if (res?.reason === "already_queued") {
                        toast.info("A run is already queued for this task");
                      }
                    }}
                  />
                  <MenuItem
                    icon={Share2}
                    label="Share"
                    disabled={!shareable}
                    title={
                      shareable
                        ? undefined
                        : "Share becomes available after a successful run"
                    }
                    onClick={() => {
                      setMenuOpen(false);
                      if (shareable) setShareMessageId(shareable);
                    }}
                  />
                  {!completed && (
                    <MenuItem
                      icon={paused ? Play : Pause}
                      label={paused ? "Resume" : "Pause"}
                      disabled={busy}
                      onClick={async () => {
                        setMenuOpen(false);
                        if (paused) {
                          await guard(
                            () => resume({ taskId: task._id }),
                            "Couldn't resume",
                          );
                          toast.success("Task resumed");
                        } else {
                          // guard() resolves to null when the mutation threw.
                          const paused_ = await guard(
                            () => pause({ taskId: task._id }),
                            "Couldn't pause",
                          );
                          if (!paused_) return;
                          toast.success(
                            "Task paused — any run in progress will finish",
                          );
                          // Only on success: a refused pause must not move the
                          // filter out from under the user.
                          onPaused?.();
                        }
                      }}
                    />
                  )}
                  {completed && (
                    <MenuItem
                      icon={Copy}
                      label="Duplicate"
                      onClick={() => {
                        setMenuOpen(false);
                        // A completed task cannot be edited (Phase 1 refuses an
                        // update once terminal), so duplicating is the way back.
                        setEditing(true);
                      }}
                    />
                  )}
                  <MenuItem
                    icon={Bell}
                    label="Notification settings"
                    onClick={() => {
                      setMenuOpen(false);
                      setPrefsOpen(true);
                    }}
                  />
                  <div className="my-1 h-px bg-border" />
                  <MenuItem
                    icon={Trash2}
                    label="Delete"
                    destructive
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirmDelete(true);
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {editing && (
        <EditTaskDialog
          task={task}
          duplicate={completed}
          open={editing}
          onOpenChange={setEditing}
        />
      )}
      {prefsOpen && (
        <NotifyPrefsPopover
          task={task}
          open={prefsOpen}
          onOpenChange={setPrefsOpen}
        />
      )}
      <ShareDialog
        open={shareMessageId !== null}
        onOpenChange={(o) => !o && setShareMessageId(null)}
        params={
          shareMessageId
            ? { shareType: "single_turn", messageId: shareMessageId }
            : null
        }
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this scheduled task?"
        // Says exactly what the backend does: rows are preserved, but the
        // task's read paths close with it.
        body="This task will stop running. Its past runs are kept but will no longer be viewable."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await guard(() => remove({ taskId: task._id }), "Couldn't delete");
          toast.success("Scheduled task deleted");
        }}
      />
    </>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  disabled,
  destructive,
  title,
}: {
  icon: typeof Bell;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${
        destructive
          ? "text-destructive hover:bg-destructive/10"
          : "text-primary/80 hover:bg-accent"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </button>
  );
}
