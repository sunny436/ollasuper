"""Deterministic recurrence maths for Scheduled Tasks.

This module is the SINGLE implementation of "when does this task run". Convex
validates the shape of a schedule and stores it; it never does calendar
arithmetic, because two implementations of timezone/DST rules drift and the
drift is silent.

Everything here is pure: instants in, instants out, no clock, no I/O. That is
what makes DST and month-end behaviour testable against fixed timestamps.

Three rules are load-bearing and each exists because cron cannot express it:

  * MONTH-END CLAMP. "the 31st" resolves to the last day of shorter months, so
    a monthly task fires in February. A cron `0 9 31 * *` silently skips it.
  * NONEXISTENT LOCAL TIME (spring forward). 02:30 does not exist on the DST
    transition day; the occurrence rolls forward to the first valid instant,
    which is the moment the gap ends.
  * AMBIGUOUS LOCAL TIME (fall back). 01:30 happens twice; `fold=0` picks the
    FIRST, so the task fires exactly once.

Weekday convention is Python's own: 0 = Monday … 6 = Sunday. It matches
datetime.weekday() and the `weekdays` array validated in
packages/backend/convex/scheduled/schedule.ts.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Bounds the DATE scan, not the output. A task whose cursor is years behind
# must not spin: the scan stops, emits what it found and reports a partial
# cursor so the next tick continues from there. Nothing is dropped.
_MAX_DAYS_SCANNED = 4000
_MAX_MONTHS_SCANNED = 480


class InvalidSpec(ValueError):
    """The schedule cannot be resolved (bad shape, or an unknown IANA zone)."""


@dataclass(frozen=True)
class Spec:
    kind: Literal["once", "daily", "weekly", "monthly"]
    timezone: str
    run_at: int | None = None
    hour: int = 0
    minute: int = 0
    weekdays: tuple[int, ...] = ()
    day_of_month: int = 1
    # "End repeat" (Phase 3). INCLUSIVE: an instant landing exactly on it still
    # runs. None = repeats forever, which is the pre-Phase-3 behaviour.
    ends_at: int | None = None


@dataclass(frozen=True)
class Enumeration:
    """Instants in (after, until], plus the cursor the caller should store."""

    instants: list[int]
    next_cursor_ms: int
    truncated: bool


def parse_spec(raw: dict[str, Any]) -> Spec:
    """Validate a Convex-stored spec. Raises InvalidSpec, never returns junk."""
    kind = raw.get("kind")
    tz = raw.get("timezone")
    if not isinstance(tz, str) or not tz:
        raise InvalidSpec("missing timezone")
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError, KeyError) as e:
        # tzdata is a DECLARED dependency precisely so this cannot depend on
        # whether the host OS ships a zone database (Windows ships none).
        raise InvalidSpec(f"unknown timezone: {tz}") from e

    if kind == "once":
        run_at = raw.get("runAt")
        if not isinstance(run_at, (int, float)):
            raise InvalidSpec("missing runAt")
        return Spec(kind="once", timezone=tz, run_at=int(run_at))

    hour, minute = raw.get("hour"), raw.get("minute")
    if not isinstance(hour, int) or not 0 <= hour <= 23:
        raise InvalidSpec("invalid hour")
    if not isinstance(minute, int) or not 0 <= minute <= 59:
        raise InvalidSpec("invalid minute")

    ends_at_raw = raw.get("endsAt")
    if ends_at_raw is not None and not isinstance(ends_at_raw, (int, float)):
        raise InvalidSpec("invalid endsAt")
    ends_at = int(ends_at_raw) if ends_at_raw is not None else None

    if kind == "daily":
        return Spec(
            kind="daily",
            timezone=tz,
            hour=hour,
            minute=minute,
            ends_at=ends_at,
        )

    if kind == "weekly":
        raw_days = raw.get("weekdays")
        if not isinstance(raw_days, list) or not raw_days:
            raise InvalidSpec("invalid weekdays")
        days = sorted({int(d) for d in raw_days})
        if any(not isinstance(d, int) or not 0 <= d <= 6 for d in days):
            raise InvalidSpec("invalid weekdays")
        return Spec(
            kind="weekly",
            timezone=tz,
            hour=hour,
            minute=minute,
            weekdays=tuple(days),
            ends_at=ends_at,
        )

    if kind == "monthly":
        dom = raw.get("dayOfMonth")
        if not isinstance(dom, int) or not 1 <= dom <= 31:
            raise InvalidSpec("invalid dayOfMonth")
        return Spec(
            kind="monthly",
            timezone=tz,
            hour=hour,
            minute=minute,
            day_of_month=dom,
            ends_at=ends_at,
        )

    raise InvalidSpec(f"unknown kind: {kind!r}")


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        return 31
    return (date(year, month + 1, 1) - timedelta(days=1)).day


def _is_nonexistent(naive: datetime, tz: ZoneInfo) -> bool:
    """True when this wall-clock time is skipped by a spring-forward gap.

    Round-tripping through UTC is the canonical test: a local time inside a gap
    comes back as a DIFFERENT local time, because it never happened.
    """
    attached = naive.replace(tzinfo=tz)
    return attached.astimezone(UTC).astimezone(tz).replace(tzinfo=None) != naive


def _gap_end_utc(naive: datetime, tz: ZoneInfo) -> datetime:
    """The first valid instant at or after a nonexistent local time.

    Bisects for the transition rather than assuming a one-hour shift: real
    zones have used 30- and 45-minute jumps, and Lord Howe still uses 30.
    """
    lo = naive.replace(tzinfo=tz, fold=1).astimezone(UTC)  # before the jump
    hi = naive.replace(tzinfo=tz, fold=0).astimezone(UTC)  # after the jump
    before = lo.astimezone(tz).utcoffset()
    while (hi - lo) > timedelta(seconds=1):
        mid = lo + (hi - lo) / 2
        if mid.astimezone(tz).utcoffset() == before:
            lo = mid
        else:
            hi = mid
    return hi


def _resolve(naive: datetime, tz: ZoneInfo) -> datetime:
    """Local wall-clock -> a single, deterministic UTC instant."""
    if _is_nonexistent(naive, tz):
        return _gap_end_utc(naive, tz).astimezone(UTC)
    # fold=0 is the FIRST of an ambiguous pair, so a fall-back hour fires once.
    return naive.replace(tzinfo=tz, fold=0).astimezone(UTC)


def _to_ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def _from_ms(ms: int, tz: ZoneInfo) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=UTC).astimezone(tz)


def _instant_for_date(d: date, spec: Spec, tz: ZoneInfo) -> int:
    naive = datetime(d.year, d.month, d.day, spec.hour, spec.minute)
    return _to_ms(_resolve(naive, tz))


def occurrences_between(
    spec: Spec,
    after_ms: int,
    until_ms: int,
    limit: int = 200,
) -> Enumeration:
    """Every instant in (after_ms, until_ms], oldest first.

    The half-open lower bound is what makes re-running a tick harmless, and it
    is why a three-day outage yields three separate instants rather than one
    "catch-up": the caller's stored cursor preserves the timeline, so this is
    never computed from `now`.
    """
    if limit <= 0 or until_ms <= after_ms:
        return Enumeration([], max(after_ms, until_ms), False)

    # "End repeat": clamp the ENUMERATION window, never the cursor. The cursor
    # still advances to the caller's `until_ms`, so a task whose schedule has
    # ended stops emitting instants without the tick re-scanning the same window
    # forever. Inclusive, so an instant exactly on `ends_at` still runs.
    scan_until = until_ms
    if spec.ends_at is not None:
        if spec.ends_at < after_ms:
            return Enumeration([], until_ms, False)
        scan_until = min(scan_until, spec.ends_at)

    tz = ZoneInfo(spec.timezone)

    if spec.kind == "once":
        run_at = spec.run_at or 0
        if after_ms < run_at <= scan_until:
            return Enumeration([run_at], until_ms, False)
        return Enumeration([], until_ms, False)

    out: list[int] = []
    truncated = False

    if spec.kind == "monthly":
        cur = _from_ms(after_ms, tz)
        year, month = cur.year, cur.month
        scanned = 0
        while scanned < _MAX_MONTHS_SCANNED:
            day = min(spec.day_of_month, _days_in_month(year, month))
            ms = _instant_for_date(date(year, month, day), spec, tz)
            if ms > scan_until:
                break
            if ms > after_ms:
                if len(out) >= limit:
                    truncated = True
                    break
                out.append(ms)
            month += 1
            if month == 13:
                year, month = year + 1, 1
            scanned += 1
        else:
            truncated = True
    else:
        start = _from_ms(after_ms, tz).date()
        end = _from_ms(scan_until, tz).date()
        d = start
        scanned = 0
        while d <= end and scanned < _MAX_DAYS_SCANNED:
            if spec.kind == "daily" or d.weekday() in spec.weekdays:
                ms = _instant_for_date(d, spec, tz)
                if ms > scan_until:
                    break
                if ms > after_ms:
                    if len(out) >= limit:
                        truncated = True
                        break
                    out.append(ms)
            d += timedelta(days=1)
            scanned += 1
        if scanned >= _MAX_DAYS_SCANNED and d <= end:
            truncated = True

    # A truncated pass must NOT claim the whole window, or the instants it did
    # not reach would be skipped forever. Park the cursor on the last instant
    # actually materialised and let the next tick continue.
    if truncated:
        next_cursor = out[-1] if out else after_ms
        return Enumeration(out, next_cursor, True)
    return Enumeration(out, until_ms, False)


def next_occurrence_after(spec: Spec, after_ms: int) -> int | None:
    """The next instant strictly after `after_ms`, or None if there is none.

    Advisory only — it feeds the display field `nextRunAt`. Never an authority.
    """
    if spec.kind == "once":
        run_at = spec.run_at or 0
        return run_at if run_at > after_ms else None
    horizon = 400 * 86_400_000
    found = occurrences_between(spec, after_ms, after_ms + horizon, limit=1)
    return found.instants[0] if found.instants else None


def schedule_exhausted(spec: Spec, at_ms: int) -> bool:
    """True when this schedule can never produce another occurrence.

    Drives the task's transition to `completed` with
    terminalReason "schedule_ended" — reusing the EXISTING one-time completion
    path rather than adding a lifecycle state.
    """
    if spec.kind == "once":
        return (spec.run_at or 0) <= at_ms
    return spec.ends_at is not None and spec.ends_at <= at_ms
