import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation } from "./_generated/server";
import { enqueueScheduledRun } from "./seoRuns";

/**
 * Phase 6 — recurring cadence for a monitored project. `computeNextRunAt` is fully
 * DETERMINISTIC and timezone-aware (via Intl, no external dep). The cron `dueScanner`
 * advances `nextRunAt` to the NEXT FUTURE occurrence in the SAME mutation it enqueues —
 * so a missed window catches up exactly ONCE, a re-run never double-enqueues, and a
 * project that already has an in-flight run is skipped (no stacking).
 */

const DAY_MS = 24 * 60 * 60_000;

type Cadence = "daily" | "weekly" | "custom";

/** The tz offset (localWallClock - utc) in ms at a given instant, via Intl. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0; // some engines emit 24 for midnight
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return asUtc - utcMs;
}

/** The UTC ms whose local wall-clock in `tz` is (y, m0, d, minuteOfDay). DST-robust via
 *  a two-step offset correction. */
function zonedToUtc(
  y: number,
  m0: number,
  d: number,
  minuteOfDay: number,
  tz: string,
): number {
  const wall = Date.UTC(y, m0, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let utc = wall - tzOffsetMs(wall, tz);
  // One correction handles a DST boundary between the guess and the true instant.
  utc = wall - tzOffsetMs(utc, tz);
  return utc;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};
function localDateParts(
  utcMs: number,
  tz: string,
): { y: number; m0: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    y: Number(get("year")),
    m0: Number(get("month")) - 1,
    d: Number(get("day")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/** The next occurrence STRICTLY AFTER `from` (epoch ms). Exported for tests. */
export function computeNextRunAt(
  cadence: Cadence,
  tz: string,
  minuteOfDay: number,
  dayOfWeek: number | undefined,
  intervalDays: number | undefined,
  from: number,
): number {
  const min = Math.max(0, Math.min(minuteOfDay, 1439));
  // Walk forward local-day by local-day (cap the search) picking the target time.
  const startUtcMidnight = (() => {
    const p = localDateParts(from, tz);
    return Date.UTC(p.y, p.m0, p.d);
  })();
  const maxDays = cadence === "custom" ? Math.max(1, intervalDays ?? 1) + 8 : 8;
  for (let i = 0; i <= maxDays; i++) {
    const dayUtc = startUtcMidnight + i * DAY_MS;
    const p = localDateParts(dayUtc, tz);
    const candidate = zonedToUtc(p.y, p.m0, p.d, min, tz);
    if (candidate <= from) continue;
    if (cadence === "daily") return candidate;
    if (cadence === "weekly") {
      if (p.weekday === (dayOfWeek ?? 0)) return candidate;
      continue;
    }
    // custom: the first valid time at least `intervalDays` days out from `from`.
    if (candidate - from >= (Math.max(1, intervalDays ?? 1) - 1) * DAY_MS + 1)
      return candidate;
  }
  // Fallback (unreachable in practice): from + interval/day.
  return from + (cadence === "custom" ? Math.max(1, intervalDays ?? 1) : 1) * DAY_MS;
}

async function requireProjectOwned(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"seoProjects">,
): Promise<Doc<"seoProjects">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not authenticated");
  const project = await ctx.db.get(projectId);
  if (!project || project.userId !== userId) throw new ConvexError("Not found");
  return project;
}

function validateCadence(a: {
  cadence: Cadence;
  minuteOfDay: number;
  dayOfWeek?: number;
  intervalDays?: number;
  timezone: string;
}) {
  if (a.minuteOfDay < 0 || a.minuteOfDay > 1439)
    throw new ConvexError("Invalid time of day.");
  // Reject an unknown IANA tz early (Intl throws on a bad zone).
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: a.timezone });
  } catch {
    throw new ConvexError("Invalid timezone.");
  }
  if (a.cadence === "weekly" && (a.dayOfWeek == null || a.dayOfWeek < 0 || a.dayOfWeek > 6))
    throw new ConvexError("A weekly schedule needs a day of week (0–6).");
  if (a.cadence === "custom" && (a.intervalDays == null || a.intervalDays < 1))
    throw new ConvexError("A custom schedule needs an interval of at least 1 day.");
}

export const createSchedule = mutation({
  args: {
    projectId: v.id("seoProjects"),
    cadence: v.union(v.literal("daily"), v.literal("weekly"), v.literal("custom")),
    timezone: v.string(),
    minuteOfDay: v.number(),
    dayOfWeek: v.optional(v.number()),
    intervalDays: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const project = await requireProjectOwned(ctx, a.projectId);
    validateCadence(a);
    const now = Date.now();
    const nextRunAt = computeNextRunAt(
      a.cadence, a.timezone, a.minuteOfDay, a.dayOfWeek, a.intervalDays, now,
    );
    const scheduleId = await ctx.db.insert("seoSchedules", {
      userId: project.userId,
      projectId: a.projectId,
      cadence: a.cadence,
      timezone: a.timezone,
      minuteOfDay: a.minuteOfDay,
      dayOfWeek: a.dayOfWeek,
      intervalDays: a.intervalDays,
      status: project.status === "active" ? "active" : "paused",
      nextRunAt,
      createdAt: now,
      updatedAt: now,
    });
    return { scheduleId, nextRunAt };
  },
});

async function requireScheduleOwned(
  ctx: MutationCtx,
  scheduleId: Id<"seoSchedules">,
): Promise<Doc<"seoSchedules">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not authenticated");
  const s = await ctx.db.get(scheduleId);
  if (!s || s.userId !== userId) throw new ConvexError("Not found");
  return s;
}

export const updateSchedule = mutation({
  args: {
    scheduleId: v.id("seoSchedules"),
    cadence: v.union(v.literal("daily"), v.literal("weekly"), v.literal("custom")),
    timezone: v.string(),
    minuteOfDay: v.number(),
    dayOfWeek: v.optional(v.number()),
    intervalDays: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const s = await requireScheduleOwned(ctx, a.scheduleId);
    validateCadence(a);
    const now = Date.now();
    await ctx.db.patch(s._id, {
      cadence: a.cadence,
      timezone: a.timezone,
      minuteOfDay: a.minuteOfDay,
      dayOfWeek: a.dayOfWeek,
      intervalDays: a.intervalDays,
      nextRunAt: computeNextRunAt(
        a.cadence, a.timezone, a.minuteOfDay, a.dayOfWeek, a.intervalDays, now,
      ),
      updatedAt: now,
    });
    return { ok: true };
  },
});

export const pauseSchedule = mutation({
  args: { scheduleId: v.id("seoSchedules") },
  handler: async (ctx, { scheduleId }) => {
    const s = await requireScheduleOwned(ctx, scheduleId);
    await ctx.db.patch(s._id, { status: "paused", updatedAt: Date.now() });
    return { ok: true };
  },
});

export const resumeSchedule = mutation({
  args: { scheduleId: v.id("seoSchedules") },
  handler: async (ctx, { scheduleId }) => {
    const s = await requireScheduleOwned(ctx, scheduleId);
    // Re-anchor the next run to the future so a long-paused schedule doesn't fire immediately.
    await ctx.db.patch(s._id, {
      status: "active",
      nextRunAt: computeNextRunAt(
        s.cadence, s.timezone, s.minuteOfDay, s.dayOfWeek, s.intervalDays, Date.now(),
      ),
      updatedAt: Date.now(),
    });
    return { ok: true };
  },
});

export const deleteSchedule = mutation({
  args: { scheduleId: v.id("seoSchedules") },
  handler: async (ctx, { scheduleId }) => {
    const s = await requireScheduleOwned(ctx, scheduleId);
    await ctx.db.delete(s._id);
    return { ok: true };
  },
});

/** True iff the project already has a non-terminal run (duplicate/stacking guard). */
async function hasActiveRun(
  ctx: MutationCtx,
  projectId: Id<"seoProjects">,
): Promise<boolean> {
  const runs = await ctx.db
    .query("seoRuns")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  return runs.some((r) =>
    ["queued", "running", "retry_wait"].includes(r.status),
  );
}

/**
 * Cron (every 5 min): enqueue a monitoring run for every ACTIVE schedule whose window has
 * arrived. Advancing nextRunAt + lastRunAt happens in the SAME mutation as the scan
 * (idempotent — a re-run sees the future nextRunAt), so a missed window catches up ONCE
 * and no run is double-enqueued. A paused/deleted project or an in-flight run is skipped
 * but the schedule still advances (so it stays in sync, never re-scanned in a tight loop).
 */
export const dueScanner = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("seoSchedules")
      .withIndex("by_status_nextRun", (q) =>
        q.eq("status", "active").lte("nextRunAt", now),
      )
      .take(50);
    let enqueued = 0;
    for (const s of due) {
      const next = computeNextRunAt(
        s.cadence, s.timezone, s.minuteOfDay, s.dayOfWeek, s.intervalDays, now,
      );
      await ctx.db.patch(s._id, { nextRunAt: next, lastRunAt: now, updatedAt: now });

      const project = await ctx.db.get(s.projectId);
      if (!project || project.status !== "active") continue; // paused/deleted → skip
      if (await hasActiveRun(ctx, s.projectId)) continue; // no stacking
      const res = await enqueueScheduledRun(ctx, s.projectId, "schedule");
      if (res.ok && !res.deduped) enqueued++;
    }
    return { scanned: due.length, enqueued };
  },
});
