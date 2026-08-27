"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { Button } from "@v1/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@v1/ui/select";
import { useMutation, useQuery } from "convex/react";
import { CheckCircle2, PauseCircle, PlayCircle, Radar, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/confirm-button";
import { useWorkspace } from "@/lib/useWorkspace";

const CARD = "rounded-2xl border border-border bg-card/60 p-5 backdrop-blur-xl";
const BROWSER_TZ =
  typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    : "UTC";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hhmmToMinutes(v: string): number {
  const [h, m] = v.split(":").map((x) => Number.parseInt(x, 10));
  return Math.max(0, Math.min((h || 0) * 60 + (m || 0), 1439));
}
function minutesToHhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function fmtWhen(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function MonitoringPage() {
  const { current } = useWorkspace();
  const projects = useQuery(api.seoProjects.listProjects, {});
  const createProject = useMutation(api.seoProjects.createProject);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  const onCreate = async () => {
    const t = target.trim();
    if (!t || !current || busy) return;
    setBusy(true);
    try {
      await createProject({ target: t, workspaceId: current });
      setTarget("");
      toast.success("Now monitoring this site.");
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Could not start monitoring.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-primary">
          <Radar className="h-5 w-5 text-brand-ink" aria-hidden /> Monitoring
        </h1>
        <p className="mt-1 text-sm text-primary/55">
          Continuously audit a site and get notified only when important SEO issues
          appear or change. Change detection is deterministic — no guesswork.
        </p>
      </header>

      <section className={CARD}>
        <div className="text-sm font-semibold text-primary/90">Monitor a new site</div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onCreate()}
            placeholder="https://example.com"
            className="min-w-0 flex-1 rounded-lg border border-border bg-card/60 px-3 py-2 text-sm text-primary/80 outline-none placeholder:text-primary/35 focus:border-brand/40"
          />
          <Button size="sm" onClick={onCreate} disabled={busy || !current || !target.trim()}>
            <Radar className="mr-1.5 h-4 w-4" aria-hidden /> Monitor
          </Button>
        </div>
      </section>

      {projects === undefined ? null : projects.length === 0 ? (
        <p className="px-1 text-sm text-primary/45">
          No monitored sites yet. Add one above, then set a daily or weekly schedule.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {projects.map((p) => (
            <ProjectCard key={p.projectId} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}

type ProjectRow = FunctionReturnType<typeof api.seoProjects.listProjects>[number];

function ProjectCard({ project }: { project: ProjectRow }) {
  const pause = useMutation(api.seoProjects.pauseProject);
  const resume = useMutation(api.seoProjects.resumeProject);
  const del = useMutation(api.seoProjects.deleteProject);
  const rerun = useMutation(api.seoProjects.rerunNow);
  const [editing, setEditing] = useState(false);
  const active = project.status === "active";

  const onRerun = async () => {
    try {
      const r = await rerun({ projectId: project.projectId });
      toast[r.ok ? "success" : "error"](
        r.ok ? "Audit started." : "Could not start an audit right now.",
      );
    } catch {
      toast.error("Could not start an audit.");
    }
  };

  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-primary/90">
              {project.target}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
                active
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "border-border bg-card/60 text-primary/50"
              }`}
            >
              {active ? "Active" : "Paused"}
            </span>
          </div>
          <div className="mt-1 text-xs text-primary/50">
            {project.schedule
              ? `${cadenceLabel(project.schedule)} · next ${fmtWhen(project.schedule.nextRunAt)} (${project.schedule.timezone})`
              : "No schedule yet"}
            {" · last run "}
            {fmtWhen(project.lastRunAt)}
            {!project.hasBaseline && " · baseline pending"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onRerun}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-primary/70 hover:bg-primary/5"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Run now
          </button>
          <button
            type="button"
            onClick={() => {
              void (active ? pause : resume)({
                projectId: project.projectId,
              }).catch(() => {});
            }}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-primary/70 hover:bg-primary/5"
          >
            {active ? (
              <>
                <PauseCircle className="h-3.5 w-3.5" aria-hidden /> Pause
              </>
            ) : (
              <>
                <PlayCircle className="h-3.5 w-3.5" aria-hidden /> Resume
              </>
            )}
          </button>
          <ConfirmButton
            label="Delete"
            title="Stop monitoring this site?"
            description="This removes the project, its schedule and all its run history. This cannot be undone."
            confirmLabel="Delete"
            onConfirm={async () => {
              try {
                await del({ projectId: project.projectId });
                toast.success("Monitoring removed.");
              } catch {
                toast.error("Could not delete.");
              }
            }}
            className="rounded-md border border-border px-2 py-1 text-xs text-primary/60 hover:bg-primary/5"
          />
        </div>
      </div>

      <div className="mt-3 border-t border-border pt-3">
        {editing || !project.schedule ? (
          <ScheduleForm
            project={project}
            onDone={() => setEditing(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs font-medium text-brand-ink hover:underline"
          >
            Edit schedule
          </button>
        )}
      </div>
    </section>
  );
}

function cadenceLabel(s: NonNullable<ProjectRow["schedule"]>): string {
  if (s.cadence === "daily") return "Daily";
  if (s.cadence === "weekly") return "Weekly";
  return "Custom";
}

function ScheduleForm({
  project,
  onDone,
}: {
  project: ProjectRow;
  onDone: () => void;
}) {
  const create = useMutation(api.seoSchedules.createSchedule);
  const update = useMutation(api.seoSchedules.updateSchedule);
  const existing = project.schedule;
  const [cadence, setCadence] = useState<"daily" | "weekly" | "custom">(
    existing?.cadence ?? "weekly",
  );
  const [time, setTime] = useState("09:00");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [intervalDays, setIntervalDays] = useState(3);
  const [busy, setBusy] = useState(false);

  const onSave = async () => {
    if (busy) return;
    setBusy(true);
    const common = {
      cadence,
      timezone: BROWSER_TZ,
      minuteOfDay: hhmmToMinutes(time),
      ...(cadence === "weekly" ? { dayOfWeek } : {}),
      ...(cadence === "custom" ? { intervalDays } : {}),
    };
    try {
      if (existing) {
        await update({ scheduleId: existing.scheduleId, ...common });
      } else {
        await create({ projectId: project.projectId, ...common });
      }
      toast.success("Schedule saved.");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the schedule.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-[11px] text-primary/55">
        Frequency
        <Select value={cadence} onValueChange={(v) => setCadence(v as typeof cadence)}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="workspace">
            <SelectItem value="daily">Daily</SelectItem>
            <SelectItem value="weekly">Weekly</SelectItem>
            <SelectItem value="custom">Every N days</SelectItem>
          </SelectContent>
        </Select>
      </label>

      {cadence === "weekly" && (
        <label className="flex flex-col gap-1 text-[11px] text-primary/55">
          Day
          <Select value={String(dayOfWeek)} onValueChange={(v) => setDayOfWeek(Number(v))}>
            <SelectTrigger className="h-8 w-24 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="workspace">
              {DAYS.map((d, i) => (
                <SelectItem key={d} value={String(i)}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      )}

      {cadence === "custom" && (
        <label className="flex flex-col gap-1 text-[11px] text-primary/55">
          Every (days)
          <input
            type="number"
            min={1}
            value={intervalDays}
            onChange={(e) => setIntervalDays(Math.max(1, Number(e.target.value) || 1))}
            className="h-8 w-20 rounded-md border border-border bg-card/60 px-2 text-xs text-primary/80 outline-none focus:border-brand/40"
          />
        </label>
      )}

      <label className="flex flex-col gap-1 text-[11px] text-primary/55">
        Time
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="h-8 w-28 rounded-md border border-border bg-card/60 px-2 text-xs text-primary/80 outline-none focus:border-brand/40"
        />
      </label>

      <Button size="sm" onClick={onSave} disabled={busy} className="h-8">
        <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Save
      </Button>
      <span className="text-[11px] text-primary/40">({BROWSER_TZ})</span>
    </div>
  );
}
