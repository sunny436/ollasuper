"use client";

import { useMemo } from "react";
import {
  type ScheduleSpec,
  WEEKDAY_OPTIONS,
  browserZone,
  timezoneOptions,
  utcToZonedFields,
  zonedToUtc,
} from "../_lib/schedule-format";

/**
 * The FREQUENCY block from the product reference: Repeat · Frequency · Time ·
 * Timezone · End repeat.
 *
 * Shared by the edit dialog and the composer's confirmation card, so a schedule
 * is built and edited through exactly one set of controls — and so neither can
 * produce a shape Phase 1 would reject.
 *
 * Timezone is a first-class row even though the reference hides it: a task
 * carries an IANA zone and runs by it, so a user editing at 8 AM in a different
 * zone from the one the task was created in must be able to see that.
 */

type Kind = ScheduleSpec["kind"];

const KINDS: { value: Kind; label: string }[] = [
  { value: "once", label: "Does not repeat" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

/** Parse "YYYY-MM-DD" / "HH:MM" defensively — an input can hand back "". */
function parts(value: string, count: number): number[] | null {
  const out = value.split(/[-:]/).map(Number);
  if (out.length < count || out.some((n) => !Number.isFinite(n))) return null;
  return out;
}

function timeString(spec: ScheduleSpec): string {
  if (spec.kind === "once") return utcToZonedFields(spec.runAt, spec.timezone).time;
  return `${String(spec.hour).padStart(2, "0")}:${String(spec.minute).padStart(2, "0")}`;
}

/** Re-shape the spec when the user changes Repeat, keeping what still applies. */
function switchKind(spec: ScheduleSpec, kind: Kind): ScheduleSpec {
  const tz = spec.timezone;
  const hour = spec.kind === "once" ? 9 : spec.hour;
  const minute = spec.kind === "once" ? 0 : spec.minute;
  const endsAt = spec.kind === "once" ? undefined : spec.endsAt;
  switch (kind) {
    case "once":
      return {
        kind: "once",
        timezone: tz,
        runAt: spec.kind === "once" ? spec.runAt : Date.now() + 3_600_000,
      };
    case "daily":
      return { kind: "daily", timezone: tz, hour, minute, endsAt };
    case "weekly":
      return {
        kind: "weekly",
        timezone: tz,
        // NO DEFAULT DAY. This used to be [0] — Monday — so a user who had
        // said "every Sunday", landed on the manual form and picked Weekly got
        // Monday pre-selected and no sign of it. An unanswered day stays
        // unanswered; `specGaps` makes the caller block saving until it is set.
        weekdays: spec.kind === "weekly" ? spec.weekdays : [],
        hour,
        minute,
        endsAt,
      };
    case "monthly":
      return {
        kind: "monthly",
        timezone: tz,
        dayOfMonth: spec.kind === "monthly" ? spec.dayOfMonth : 1,
        hour,
        minute,
        endsAt,
      };
  }
}

export function emptySpec(): ScheduleSpec {
  return {
    kind: "daily",
    timezone: browserZone(),
    hour: 9,
    minute: 0,
  };
}

/**
 * Fields the spec itself cannot answer yet, so a caller can refuse to save.
 *
 * A weekly schedule with no day is the one shape this UI can hold but Phase 1
 * rejects (`normalizeSpec` throws "Invalid weekdays"). It exists on purpose:
 * the alternative was pre-selecting Monday, which quietly overrode what the
 * user had actually asked for. Surfacing it as a question is the whole point.
 */
export function specGaps(spec: ScheduleSpec): string[] {
  return spec.kind === "weekly" && spec.weekdays.length === 0 ? ["weekdays"] : [];
}

export function ScheduleFields({
  value,
  onChange,
  highlight = [],
}: {
  value: ScheduleSpec;
  onChange: (next: ScheduleSpec) => void;
  /** Field names the parser could not determine, so they can be called out. */
  highlight?: string[];
}) {
  // deps on the value: a task whose zone is not in supportedValuesOf (Asia/Kolkata,
  // UTC) must still be selectable, and the dialog is reused across tasks.
  const zones = useMemo(
    () => timezoneOptions(value.timezone),
    [value.timezone],
  );
  const onceFields =
    value.kind === "once"
      ? utcToZonedFields(value.runAt, value.timezone)
      : null;
  const endFields =
    value.kind !== "once" && value.endsAt
      ? utcToZonedFields(value.endsAt, value.timezone)
      : null;

  function setTime(next: string) {
    const t = parts(next, 2);
    if (!t) return;
    const [h, m] = t as [number, number];
    if (value.kind === "once") {
      const f = utcToZonedFields(value.runAt, value.timezone);
      const d = parts(f.date, 3);
      if (!d) return;
      const [y, mo, day] = d as [number, number, number];
      onChange({
        ...value,
        runAt: zonedToUtc(y, mo, day, h, m, value.timezone),
      });
      return;
    }
    onChange({ ...value, hour: h, minute: m });
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <Row label="Repeat" highlighted={highlight.includes("kind")}>
        <select
          value={value.kind}
          onChange={(e) => onChange(switchKind(value, e.target.value as Kind))}
          className="cursor-pointer bg-transparent text-right text-sm text-primary outline-none"
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </Row>

      {value.kind === "weekly" && (
        <Row
          label="Days"
          highlighted={
            highlight.includes("weekdays") || value.weekdays.length === 0
          }
        >
          <div className="flex flex-wrap items-center justify-end gap-1">
            {value.weekdays.length === 0 && (
              <span className="mr-1 text-xs text-primary/65">Pick a day</span>
            )}
            {WEEKDAY_OPTIONS.map((d) => {
              const on = value.weekdays.includes(d.value);
              return (
                <button
                  key={d.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    const next = on
                      ? value.weekdays.filter((x) => x !== d.value)
                      : [...value.weekdays, d.value];
                    // Never let the user save an empty weekly schedule — Phase 1
                    // rejects it, so the control refuses it first.
                    if (next.length === 0) return;
                    onChange({ ...value, weekdays: next.sort((a, b) => a - b) });
                  }}
                  className={`h-7 w-9 rounded-md text-[11px] font-medium transition ${
                    on
                      ? "bg-brand text-brand-foreground"
                      : "bg-primary/5 text-primary/60 hover:bg-primary/10"
                  }`}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </Row>
      )}

      {value.kind === "monthly" && (
        <Row label="Day of month" highlighted={highlight.includes("dayOfMonth")}>
          <select
            value={value.dayOfMonth}
            onChange={(e) =>
              onChange({ ...value, dayOfMonth: Number(e.target.value) })
            }
            className="cursor-pointer bg-transparent text-right text-sm text-primary outline-none"
          >
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
                {d > 28 ? " (or month end)" : ""}
              </option>
            ))}
          </select>
        </Row>
      )}

      {value.kind === "once" && onceFields && (
        <Row label="Date" highlighted={highlight.includes("runAt")}>
          <input
            type="date"
            value={onceFields.date}
            onChange={(e) => {
              const date = parts(e.target.value, 3);
              const time = parts(onceFields.time, 2);
              if (!date || !time) return;
              const [y, mo, d] = date as [number, number, number];
              const [h, m] = time as [number, number];
              onChange({
                ...value,
                runAt: zonedToUtc(y, mo, d, h, m, value.timezone),
              });
            }}
            className="bg-transparent text-right text-sm text-primary outline-none"
          />
        </Row>
      )}

      <Row label="Time" highlighted={highlight.includes("hour")}>
        <input
          type="time"
          value={timeString(value)}
          onChange={(e) => setTime(e.target.value)}
          className="bg-transparent text-right text-sm text-primary outline-none"
        />
      </Row>

      <Row label="Timezone">
        <select
          value={value.timezone}
          onChange={(e) => onChange({ ...value, timezone: e.target.value })}
          className="max-w-[14rem] cursor-pointer truncate bg-transparent text-right text-sm text-primary outline-none"
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </Row>

      {value.kind !== "once" && (
        <Row label="End repeat" separated>
          <div className="flex items-center gap-2">
            <select
              value={value.endsAt ? "on" : "never"}
              onChange={(e) => {
                if (e.target.value === "never") {
                  onChange({ ...value, endsAt: undefined });
                  return;
                }
                // Default a month out, at the end of that day in the task's
                // zone, so "until" reads as inclusive.
                const d = new Date(Date.now() + 30 * 86_400_000);
                onChange({
                  ...value,
                  endsAt: zonedToUtc(
                    d.getFullYear(),
                    d.getMonth() + 1,
                    d.getDate(),
                    23,
                    59,
                    value.timezone,
                  ),
                });
              }}
              className="cursor-pointer bg-transparent text-right text-sm text-primary outline-none"
            >
              <option value="never">Never</option>
              <option value="on">On date</option>
            </select>
            {endFields && (
              <input
                type="date"
                value={endFields.date}
                onChange={(e) => {
                  const date = parts(e.target.value, 3);
                  if (!date) return;
                  const [y, mo, d] = date as [number, number, number];
                  onChange({
                    ...value,
                    endsAt: zonedToUtc(y, mo, d, 23, 59, value.timezone),
                  });
                }}
                className="bg-transparent text-right text-sm text-primary outline-none"
              />
            )}
          </div>
        </Row>
      )}
    </div>
  );
}

function Row({
  label,
  children,
  separated,
  highlighted,
}: {
  label: string;
  children: React.ReactNode;
  separated?: boolean;
  highlighted?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 px-4 py-3.5 ${
        separated ? "border-t-4 border-background" : "border-t border-border first:border-t-0"
      } ${highlighted ? "bg-brand/5" : ""}`}
    >
      <span className="shrink-0 text-sm text-primary/85">{label}</span>
      {children}
    </div>
  );
}
