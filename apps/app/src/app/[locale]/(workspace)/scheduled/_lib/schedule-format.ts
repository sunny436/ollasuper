/**
 * Display helpers for scheduled tasks.
 *
 * THIS FILE NEVER COMPUTES A NEXT RUN. `nextRunAt` is written by the scheduler
 * from services/ai/app/scheduler/recurrence.py, which owns DST resolution and
 * the month-end clamp. A second implementation of calendar arithmetic here
 * would drift from it silently, so everything below is pure formatting of
 * values the backend already decided.
 *
 * Everything here is CLIENT-ONLY. `Intl.DateTimeFormat` is timezone- and
 * locale-dependent, which is a hydration hazard: the server would format in the
 * server's zone and the browser in the browser's, React reports the difference
 * through console.error, and every e2e script fails the run on one of those.
 * It is safe because the data arrives through useQuery, which resolves to
 * undefined during SSR — the same reasoning chat-message.tsx documents.
 */

export type ScheduleSpec =
  | { kind: "once"; timezone: string; runAt: number }
  | {
      kind: "daily";
      timezone: string;
      hour: number;
      minute: number;
      endsAt?: number;
    }
  | {
      kind: "weekly";
      timezone: string;
      weekdays: number[];
      hour: number;
      minute: number;
      endsAt?: number;
    }
  | {
      kind: "monthly";
      timezone: string;
      dayOfMonth: number;
      hour: number;
      minute: number;
      endsAt?: number;
    };

/** 0 = Monday … 6 = Sunday, matching Phase 1 and datetime.weekday(). */
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const WEEKDAY_OPTIONS = DAY_LABELS.map((label, value) => ({
  value,
  label,
}));

function clockLabel(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** "Asia/Kolkata" -> "Kolkata", so a row stays readable at 272px. */
export function shortZone(tz: string): string {
  const tail = tz.split("/").pop() ?? tz;
  return tail.replace(/_/g, " ");
}

/** The one-line cadence used on the row and in the detail header. */
export function recurrenceLabel(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case "once":
      return "One time";
    case "daily":
      return "Daily";
    case "weekly": {
      const days = [...spec.weekdays].sort((a, b) => a - b);
      // A draft can hold a weekly schedule with no day yet: the composer no
      // longer invents Monday. A saved task never can — Phase 1 rejects it.
      if (days.length === 0) return "Weekly";
      if (days.length === 7) return "Daily";
      // Mon–Fri is common enough to be worth naming.
      if (days.length === 5 && days.every((d, i) => d === i)) return "Weekdays";
      return days.map((d) => DAY_LABELS[d] ?? "?").join(" + ");
    }
    case "monthly":
      return `Monthly on day ${spec.dayOfMonth}`;
  }
}

/**
 * The full human summary shown before saving, e.g.
 * "Mon + Wed + Fri at 8:00 AM · Kolkata".
 */
export function scheduleSummary(spec: ScheduleSpec): string {
  const zone = shortZone(spec.timezone);
  if (spec.kind === "once") {
    return `Once on ${formatInstant(spec.runAt, spec.timezone)}`;
  }
  // Never assert a cadence that has not been chosen. The old code printed the
  // fabricated Monday here as "Mon at 8:00 AM", which is what made a wrong
  // schedule look like a decision the user had made.
  if (spec.kind === "weekly" && spec.weekdays.length === 0) {
    return `Pick a day · ${clockLabel(spec.hour, spec.minute)} · ${zone}`;
  }
  const base = `${recurrenceLabel(spec)} at ${clockLabel(spec.hour, spec.minute)} · ${zone}`;
  // A 31st that lands in February is clamped server-side; say so rather than
  // letting the user discover it in March.
  const clamp =
    spec.kind === "monthly" && spec.dayOfMonth > 28
      ? " (or the last day of shorter months)"
      : "";
  const ends = spec.endsAt
    ? ` · until ${formatInstant(spec.endsAt, spec.timezone)}`
    : "";
  return base + clamp + ends;
}

/** An absolute instant, rendered in the TASK's zone — never the browser's. */
export function formatInstant(ms: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(ms));
  } catch {
    // An unknown zone must not take the page down; fall back to the browser's.
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(ms));
  }
}

/** "in 4 hours" / "2 days ago" — coarse on purpose, no ticking clock. */
export function relative(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, size] of units) {
    if (abs >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return diff >= 0 ? "in a moment" : "just now";
}

/**
 * The IANA zone list for the picker.
 *
 * `Intl.supportedValuesOf` is ES2022 and not universally present, so it is
 * feature-detected: the fallback is a curated list plus whatever the browser
 * reports for itself, which guarantees the user's own zone is always
 * selectable and the picker is never empty.
 */
const FALLBACK_ZONES = [
  "UTC",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Madrid",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Africa/Johannesburg",
];

/**
 * Does this engine recognise the zone at all?
 *
 * Deliberately NOT a membership test against `supportedValuesOf`: that list
 * holds ICU-canonical ids only, so it rejects perfectly valid zones like
 * "Asia/Kolkata" and "UTC". Asking Intl to build a formatter is the same check
 * the backend makes (schedule.ts isPlausibleTimezone) and matches what
 * ZoneInfo will accept on the Python side.
 */
export function isValidZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * `current` is the zone the task ACTUALLY holds, and it must always be in the
 * returned list.
 *
 * THE BUG THIS FIXES. `Intl.supportedValuesOf("timeZone")` returns ICU-CANONICAL
 * ids, which are not the ids anything else in this stack produces:
 *
 *   Asia/Kolkata   in supportedValuesOf? NO      valid IANA? yes
 *   Asia/Calcutta  in supportedValuesOf? yes
 *   UTC            in supportedValuesOf? NO      valid IANA? yes
 *
 * An HTML <select> whose value matches no <option> falls back to selectedIndex
 * 0, and index 0 of that list is "Africa/Abidjan" — which is also UTC+0, so it
 * looks plausible enough to not be questioned. Production showed exactly that:
 * a dropdown reading Africa/Abidjan beside a summary line correctly reading
 * "Kolkata", because the summary formats spec.timezone directly instead of
 * going through the options.
 *
 * It bites whenever a STORED zone is absent from that list, however it got
 * there. Measured in Chromium 1234 (418 entries): `UTC` resolves to `UTC` and
 * is absent, so any browser reporting UTC creates a task the picker cannot
 * display — and production holds such rows. `Asia/Kolkata` is also absent, and
 * production holds one of those too, though this engine canonicalises Kolkata
 * to Calcutta in `resolvedOptions()`, so that row came from a different engine
 * or from the schedule parser rather than from `browserZone()` here. The fix
 * does not depend on knowing which: any stored zone is selectable.
 *
 * The fix is the union, NOT canonicalising on write: rewriting "Asia/Kolkata" to
 * the ICU-canonical "Asia/Calcutta" would start persisting a deprecated name for
 * every Indian user. A duplicate-looking pair in the list is harmless — both
 * resolve to the same offset — whereas a silently wrong stored zone is not.
 */
export function timezoneOptions(current?: string): string[] {
  const own = browserZone();
  let supported: string[] | undefined;
  try {
    supported = (
      Intl as unknown as {
        supportedValuesOf?: (k: string) => string[];
      }
    ).supportedValuesOf?.("timeZone");
  } catch {
    supported = undefined;
  }
  const base = supported?.length ? supported : FALLBACK_ZONES;
  // `current` first: whatever the task holds is always selectable, even when it
  // is an alias, a deprecated id, or a zone this engine has never heard of.
  return Array.from(
    new Set([...(current ? [current] : []), own, ...base]),
  ).sort();
}

/** Backend occurrence status -> the label the user reads. */
export function runStatusLabel(
  status: string,
  scheduledFor: number,
  now = Date.now(),
): string {
  switch (status) {
    case "queued":
      return scheduledFor > now ? "Scheduled" : "Queued";
    case "running":
      return "Running";
    case "retrying":
      return "Retrying";
    case "succeeded":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "held":
      return "Paused";
    default:
      return status;
  }
}

/** Friendly copy for a durable error code. Never a stack trace. */
export function runErrorCopy(code: string | null): string {
  switch (code) {
    case "deadline":
    case "deadline_exceeded":
      return "The run exceeded its time limit.";
    case "dispatch_unreachable":
    case "dispatch_failed":
    case "ingress_unavailable":
      return "The AI service could not be reached.";
    case "provider_error":
    case "provider_timeout":
      return "The model provider returned an error.";
    case "timeout":
    case "stalled":
      return "The run was interrupted and did not finish.";
    case "not_configured":
      return "Scheduled execution is not configured on this deployment.";
    case "approval_required_for_unattended_execution":
      return "This task needed human approval, which a scheduled run cannot give.";
    case "owner_not_member":
    case "owner_not_active":
    case "owner_missing":
      return "The task's owner no longer has access to this workspace.";
    case "schedule_ended":
      return "The schedule reached its end date.";
    default:
      // Name an unknown code rather than hide it: the generic line alone is
      // what kept the 2026-09-22 "invalid hour" outage invisible for 3 days.
      return code ? `The run did not complete (${code}).` : "The run did not complete.";
  }
}

/**
 * Why a TASK — not a run — is not running (`task.invalidReason`). Owner and
 * entitlement codes read as they do for a run; anything else comes from the
 * scheduler's own schedule validation ("invalid hour", "unknown timezone: X",
 * …) and says what the user can actually do about it.
 */
export function taskInvalidCopy(code: string): string {
  if (/^(invalid|missing|unknown) /.test(code)) {
    return `its schedule could not be read (${code}). Edit the schedule and save it to fix this.`;
  }
  return runErrorCopy(code);
}

/**
 * A wall-clock date+time IN A GIVEN ZONE -> the absolute instant.
 *
 * This is INPUT CONVERSION, not recurrence computation: the user types "31 Dec,
 * 5 PM" and something has to turn that into the epoch value the backend stores.
 * Recurrence itself — which day a monthly-31st lands on, what happens in a DST
 * gap — stays entirely in recurrence.py.
 *
 * The algorithm is the standard one: guess the instant as if the zone were UTC,
 * ask Intl what that instant looks like in the real zone, and subtract the
 * difference. One pass is exact everywhere except literally inside a DST gap,
 * where the result lands on the far side of the gap — which is the same
 * direction the backend rolls, so the two agree.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(guess));
    const get = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value ?? 0);
    // Intl renders midnight as hour 24 in some engines.
    const h = get("hour") % 24;
    const back = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      h,
      get("minute"),
      get("second"),
    );
    return guess - (back - guess);
  } catch {
    return guess;
  }
}

/** The inverse, for seeding a date/time input from a stored instant. */
export function utcToZonedFields(
  ms: number,
  timezone: string,
): { date: string; time: string } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(ms));
    const get = (type: string) =>
      parts.find((p) => p.type === type)?.value ?? "00";
    const hour = get("hour") === "24" ? "00" : get("hour");
    return {
      date: `${get("year")}-${get("month")}-${get("day")}`,
      time: `${hour}:${get("minute")}`,
    };
  } catch {
    const d = new Date(ms);
    return {
      date: d.toISOString().slice(0, 10),
      time: d.toISOString().slice(11, 16),
    };
  }
}
