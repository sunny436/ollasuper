"use client";

import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { CalendarClock, Filter, PanelLeft } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useChatSidebar } from "../../chat/_components/chat-shell";
import { ScheduleComposer } from "./schedule-composer";
import { NotificationsBell } from "../../../(dashboard)/_components/notifications-bell";
import { TaskDetail } from "./task-detail";
import { TaskRow } from "./task-row";

/**
 * The Scheduled Tasks workspace.
 *
 * Layout mirrors the product reference: a centred column holding the heading,
 * the scheduling composer and the task list, with a right-hand detail panel
 * that opens when a task is selected. The panel is a ROUTE
 * (/scheduled/[taskId]) rather than local state, so it is deep-linkable and
 * survives a refresh.
 *
 * The taskId comes from the URL and stays a raw string — never cast to
 * Id<"scheduledTasks"> at the boundary. A typo'd URL reaching a v.id()
 * validator throws ArgumentValidationError, which the Convex client reports via
 * console.error, and every e2e script fails the run on one of those.
 */

type Filterish = "active" | "paused" | "all";

const FILTERS: { value: Filterish; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "all", label: "All" },
];

export function ScheduledPane() {
  const router = useRouter();
  const { current } = useWorkspace();
  const { openSidebar, collapsed, toggleCollapsed } = useChatSidebar();
  const params = useParams<{ taskId?: string }>();
  const selectedId = params?.taskId ?? null;
  const [filter, setFilter] = useState<Filterish>("active");
  const [filterOpen, setFilterOpen] = useState(false);

  const tasks = useQuery(
    api.scheduled.tasks.list,
    current ? { workspaceId: current } : "skip",
  );

  const visible = useMemo(() => {
    if (!tasks) return null;
    // Each filter means exactly what it says, and matches the PERSISTED status.
    //
    // "Active" used to include paused tasks, and a fallback returned everything
    // when the live set was empty. Both existed for a real reason — pausing
    // removed the row from view and the only route back was to discover the
    // filter menu — but the cure was worse: a paused task listed under Active
    // makes the filter lie about the one thing a status filter exists to tell
    // the truth about.
    //
    // The original concern is answered where it actually happens instead. Pause
    // is triggered from THIS list's row menu, so TaskRow reports it and the
    // filter moves to "All", keeping the row on screen and resumable.
    if (filter === "all") return tasks;
    if (filter === "paused") return tasks.filter((t) => t.status === "paused");
    return tasks.filter((t) => t.status === "active");
  }, [tasks, filter]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div className="scrollbar-quiet flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        {/* Rail controls, matching the chat pane's header affordances. */}
        <div className="flex shrink-0 items-center gap-1 px-3 py-3">
          <button
            type="button"
            onClick={openSidebar}
            aria-label="Open conversations"
            className="rounded-md p-1.5 text-primary/65 hover:bg-primary/5 hover:text-primary md:hidden [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
          {/* Only while collapsed: the open rail carries its own toggle. */}
          {collapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Show conversations"
              data-rail-opener=""
              className="hidden rounded-md p-1.5 text-primary/65 hover:bg-primary/5 hover:text-primary md:block"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
          )}
          {/* This route has no header of its own, and it is where scheduled-run
              notifications actually lead — so the bell must be reachable here
              too, not only from the chat header. Same component. */}
          <div className="ml-auto">
            <NotificationsBell />
          </div>
        </div>

        <div className="mx-auto w-full max-w-3xl px-5 pb-24">
          <header className="flex items-start justify-between gap-4 pt-6">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-primary">
                Scheduled
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Ask OllaSuper to schedule tasks, set reminders, or monitor for
                updates.
              </p>
            </div>

            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setFilterOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={filterOpen}
                className="flex items-center gap-2 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm text-primary/80 transition hover:bg-accent"
              >
                <Filter className="h-3.5 w-3.5" />
                {FILTERS.find((f) => f.value === filter)?.label}
              </button>
              {filterOpen && (
                <>
                  <button
                    type="button"
                    aria-label="Close filter"
                    className="fixed inset-0 z-40 cursor-default"
                    onClick={() => setFilterOpen(false)}
                  />
                  {/* A listbox would need managed option focus for three
                      static items; a menu of buttons is the lighter correct
                      shape. */}
                  <div
                    role="menu"
                    className="absolute right-0 z-50 mt-1 w-36 overflow-hidden rounded-lg border border-border bg-card p-1 shadow-md"
                  >
                    {FILTERS.map((f) => (
                      <button
                        key={f.value}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setFilter(f.value);
                          setFilterOpen(false);
                        }}
                        className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm transition ${
                          f.value === filter
                            ? "bg-brand/10 text-brand-ink"
                            : "text-primary/75 hover:bg-accent"
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </header>

          <div className="mt-6">
            <ScheduleComposer
              onCreated={(id) => router.push(`/scheduled/${id}`)}
            />
          </div>

          <div className="mt-6 space-y-2">
            {visible === null && <TaskListSkeleton />}
            {visible !== null && visible.length === 0 && (
              <EmptyState filter={filter} />
            )}
            {visible?.map((task) => (
              <TaskRow
                key={task._id}
                task={task}
                selected={task._id === selectedId}
                onOpen={() => router.push(`/scheduled/${task._id}`)}
                // Active now means active, so a task paused from this menu
                // would drop out of view. Move to "All" rather than leaving
                // the user hunting the filter menu for a task they just
                // paused — the row stays put and stays resumable.
                onPaused={() => setFilter("all")}
              />
            ))}
          </div>
        </div>
      </div>

      {selectedId && (
        <TaskDetail
          taskId={selectedId}
          onClose={() => router.push("/scheduled")}
        />
      )}
    </div>
  );
}

/** Module scope, never nested — a nested sub-component remounts every render. */
function TaskListSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-[68px] animate-pulse rounded-xl border border-border bg-card"
        />
      ))}
    </div>
  );
}

function EmptyState({ filter }: { filter: Filterish }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <CalendarClock className="mx-auto h-6 w-6 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium text-primary/80">
        {filter === "active"
          ? "No active tasks"
          : filter === "paused"
            ? "No paused tasks"
            : "No scheduled tasks yet"}
      </p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
        {filter === "active"
          ? "Paused and finished tasks are still here — switch the filter to All to see them."
          : filter === "paused"
            ? "Tasks you pause will appear here. They keep their history and stop running until you resume them."
            : "Describe what you want to happen and when — for example “every weekday at 8 AM, summarise my inbox”."}
      </p>
    </div>
  );
}

export type TaskSummary = {
  _id: Id<"scheduledTasks">;
  title: string;
  prompt: string;
  status: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  spec: unknown;
};
