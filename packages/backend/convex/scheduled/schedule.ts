import { v } from "convex/values";

/**
 * Shared vocabulary for the Scheduled Tasks plane (Phase 1).
 *
 * This file holds ONLY validators, constants and pure helpers. It deliberately
 * imports nothing from the data model, so schema.ts can import the spec
 * validator without a cycle (the same reason chat/events.ts is structured this
 * way).
 *
 * IMPORTANT — there is NO time arithmetic here, and there must never be.
 * Recurrence, timezone and DST resolution live in exactly one place,
 * services/ai/app/scheduler/recurrence.py, because two implementations of
 * calendar maths drift and the drift is silent. Convex validates SHAPE; Python
 * is the authority on WHEN.
 */

/**
 * The user-facing recurrence set, locked for V1: one-time, daily, weekly,
 * monthly — each at a fixed local wall-clock time in an IANA timezone.
 * Raw cron expressions are deliberately NOT exposed: cron cannot express
 * "the 31st, clamped to month-end in February", which is a hard requirement.
 */
export const scheduleSpecValidator = v.union(
  v.object({
    kind: v.literal("once"),
    timezone: v.string(),
    /** Absolute UTC instant. One-time tasks have no wall-clock recurrence. */
    runAt: v.number(),
  }),
  v.object({
    kind: v.literal("daily"),
    timezone: v.string(),
    hour: v.number(),
    minute: v.number(),
     /**
     * "End repeat" (Phase 3). Absolute UTC instant, INCLUSIVE: an occurrence
     * falling exactly on it still runs. Absent = repeats forever, which is the
     * pre-Phase-3 behaviour byte-for-byte.
     *
     * Deliberately NOT on `once` — a one-time task already has exactly one
     * instant, so an end date there would be meaningless.
     */
    endsAt: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal("weekly"),
    timezone: v.string(),
    /** 0=Monday .. 6=Sunday. Non-empty; deduped + sorted on write. */
    weekdays: v.array(v.number()),
    hour: v.number(),
    minute: v.number(),
     /**
     * "End repeat" (Phase 3). Absolute UTC instant, INCLUSIVE: an occurrence
     * falling exactly on it still runs. Absent = repeats forever, which is the
     * pre-Phase-3 behaviour byte-for-byte.
     *
     * Deliberately NOT on `once` — a one-time task already has exactly one
     * instant, so an end date there would be meaningless.
     */
    endsAt: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal("monthly"),
    timezone: v.string(),
    /** 1..31. A 31 resolves to month-end in shorter months — never skipped. */
    dayOfMonth: v.number(),
    hour: v.number(),
    minute: v.number(),
     /**
     * "End repeat" (Phase 3). Absolute UTC instant, INCLUSIVE: an occurrence
     * falling exactly on it still runs. Absent = repeats forever, which is the
     * pre-Phase-3 behaviour byte-for-byte.
     *
     * Deliberately NOT on `once` — a one-time task already has exactly one
     * instant, so an end date there would be meaningless.
     */
    endsAt: v.optional(v.number()),
  }),
);

export type ScheduleSpec = typeof scheduleSpecValidator.type;

export const taskStatusValidator = v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("completed"),
  v.literal("deleted"),
);

/**
 * Execution state of ONE durable occurrence.
 *
 * `held` is what a pause does to already-created work: suppressed, never
 * discarded. `retrying` is a real occupied state between a failed dispatch
 * attempt and its requeue — not decoration.
 */
export const occurrenceStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("retrying"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("held"),
);

export type OccurrenceStatus = typeof occurrenceStatusValidator.type;

export const occurrenceKindValidator = v.union(
  v.literal("scheduled"),
  v.literal("manual"),
);

// MIRRORS services/ai/app/scheduler/models.py `LEGAL_TRANSITIONS` —
// keep BOTH in sync. Modelled on chat/executions.ts, which does the same
// across the same language boundary.
export const LEGAL_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  queued: new Set(["running", "held", "cancelled", "retrying", "failed"]),
  running: new Set(["succeeded", "failed", "retrying", "cancelled"]),
  retrying: new Set(["queued", "running", "failed", "cancelled", "held"]),
  held: new Set(["queued", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

const TERMINAL: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

export function canTransition(from: string, to: string): boolean {
  return LEGAL_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Deterministic, collision-safe occurrence identity.
 *
 * `kind` is part of the key on purpose: without it a "run now" fired in the
 * same millisecond as a scheduled occurrence would collide and the manual run
 * would be silently swallowed by the idempotent insert.
 */
export function occurrenceKey(
  taskId: string,
  kind: "scheduled" | "manual",
  scheduledFor: number,
): string {
  return `${taskId}:${kind}:${scheduledFor}`;
}

/**
 * Shape-level timezone validation.
 *
 * `Intl` has no precedent anywhere in this Convex codebase, so its tz database
 * coverage in the deployed runtime is unproven. The check therefore only ever
 * REJECTS on a thrown error and treats an absent/limited Intl as "unknown" —
 * Python (zoneinfo, backed by the declared tzdata dependency) is the authority
 * and records `invalidReason` on the task if it cannot resolve the zone.
 */
export function isPlausibleTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  // "Area/Location", "Area/Sub/Location", or the bare "UTC".
  if (!/^(UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2})$/.test(tz)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return false;
  }
  return true;
}

export const MAX_TITLE_LEN = 200;
export const MAX_PROMPT_LEN = 8000;

/**
 * Structural validation + normalisation. Throws a plain Error; callers wrap it
 * in a ConvexError so the message reaches the client.
 */
export function normalizeSpec(spec: ScheduleSpec): ScheduleSpec {
  if (!isPlausibleTimezone(spec.timezone)) {
    throw new Error("Invalid timezone");
  }
  if (spec.kind === "once") {
    if (!Number.isFinite(spec.runAt)) throw new Error("Invalid runAt");
    return spec;
  }
  const { hour, minute } = spec;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("Invalid hour");
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("Invalid minute");
  }
  if (spec.kind === "weekly") {
    const weekdays = [...new Set(spec.weekdays)].sort((a, b) => a - b);
    if (weekdays.length === 0) throw new Error("Invalid weekdays");
    for (const d of weekdays) {
      if (!Number.isInteger(d) || d < 0 || d > 6) {
        throw new Error("Invalid weekdays");
      }
    }
    if (spec.endsAt !== undefined && !Number.isFinite(spec.endsAt)) {
      throw new Error("Invalid endsAt");
    }
    return { ...spec, weekdays };
  }
  if (spec.kind === "monthly") {
    const d = spec.dayOfMonth;
    if (!Number.isInteger(d) || d < 1 || d > 31) {
      throw new Error("Invalid dayOfMonth");
    }
  }
  if (spec.endsAt !== undefined && !Number.isFinite(spec.endsAt)) {
    throw new Error("Invalid endsAt");
  }
  return spec;
}
