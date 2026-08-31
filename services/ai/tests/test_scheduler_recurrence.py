"""Recurrence maths against FIXED timestamps.

Every assertion here is an absolute UTC instant, so a change in DST handling,
month-end clamping or the half-open cursor window fails loudly rather than
drifting. Nothing in this file reads the clock.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.scheduler.recurrence import (
    Enumeration,
    InvalidSpec,
    Spec,
    next_occurrence_after,
    occurrences_between,
    parse_spec,
    schedule_exhausted,
)

DAY_MS = 86_400_000


def ms(iso: str) -> int:
    """Absolute UTC instant from an ISO string (must carry an offset)."""
    return int(datetime.fromisoformat(iso).timestamp() * 1000)


def utc_iso(value: int) -> str:
    return datetime.fromtimestamp(value / 1000, tz=UTC).isoformat()


def enum_iso(e: Enumeration) -> list[str]:
    return [utc_iso(i) for i in e.instants]


# ── one-time ────────────────────────────────────────────────────────────────


def test_once_produces_exactly_one_instant_inside_the_window():
    at = ms("2026-09-01T09:00:00+00:00")
    spec = Spec(kind="once", timezone="UTC", run_at=at)
    got = occurrences_between(spec, at - DAY_MS, at + DAY_MS)
    assert got.instants == [at]


def test_once_is_not_re_emitted_once_the_cursor_has_passed_it():
    at = ms("2026-09-01T09:00:00+00:00")
    spec = Spec(kind="once", timezone="UTC", run_at=at)
    # Cursor already past the instant: the lower bound is EXCLUSIVE, which is
    # what makes re-running a tick harmless.
    assert occurrences_between(spec, at, at + DAY_MS).instants == []


# ── daily ───────────────────────────────────────────────────────────────────


def test_daily_fires_at_the_same_local_wall_clock_time():
    spec = Spec(kind="daily", timezone="Asia/Kolkata", hour=9, minute=0)
    got = occurrences_between(
        spec,
        ms("2026-08-30T00:00:00+00:00"),
        ms("2026-09-02T00:00:00+00:00"),
    )
    # 09:00 IST is 03:30 UTC, every day, because India has no DST.
    assert enum_iso(got) == [
        "2026-08-30T03:30:00+00:00",
        "2026-08-31T03:30:00+00:00",
        "2026-09-01T03:30:00+00:00",
    ]


def test_daily_window_bounds_are_exclusive_lower_inclusive_upper():
    spec = Spec(kind="daily", timezone="UTC", hour=9, minute=0)
    a = ms("2026-08-30T09:00:00+00:00")
    b = ms("2026-08-31T09:00:00+00:00")
    got = occurrences_between(spec, a, b)
    # `a` itself is excluded (already materialised) and `b` is included.
    assert enum_iso(got) == ["2026-08-31T09:00:00+00:00"]


# ── weekly (multiple weekdays) ──────────────────────────────────────────────


def test_weekly_supports_multiple_weekdays_in_one_task():
    # 0=Mon … 6=Sun. Mon + Wed + Fri.
    spec = Spec(
        kind="weekly",
        timezone="UTC",
        hour=8,
        minute=30,
        weekdays=(0, 2, 4),
    )
    got = occurrences_between(
        spec,
        ms("2026-08-30T00:00:00+00:00"),  # Sunday
        ms("2026-09-05T23:59:00+00:00"),
    )
    assert enum_iso(got) == [
        "2026-08-31T08:30:00+00:00",  # Mon
        "2026-09-02T08:30:00+00:00",  # Wed
        "2026-09-04T08:30:00+00:00",  # Fri
    ]


def test_weekly_with_a_single_weekday_still_works():
    spec = Spec(kind="weekly", timezone="UTC", hour=8, minute=30, weekdays=(2,))
    got = occurrences_between(
        spec,
        ms("2026-08-30T00:00:00+00:00"),
        ms("2026-09-12T00:00:00+00:00"),
    )
    assert enum_iso(got) == [
        "2026-09-02T08:30:00+00:00",
        "2026-09-09T08:30:00+00:00",
    ]


# ── monthly: the month-end clamp cron cannot express ────────────────────────


def test_monthly_31st_clamps_to_month_end_and_never_skips_february():
    spec = Spec(kind="monthly", timezone="UTC", hour=9, minute=0, day_of_month=31)
    got = occurrences_between(
        spec,
        ms("2026-01-01T00:00:00+00:00"),
        ms("2026-04-01T00:00:00+00:00"),
    )
    # A cron `0 9 31 * *` would emit Jan and Mar and SILENTLY DROP February.
    assert enum_iso(got) == [
        "2026-01-31T09:00:00+00:00",
        "2026-02-28T09:00:00+00:00",
        "2026-03-31T09:00:00+00:00",
    ]


def test_monthly_31st_uses_february_29_in_a_leap_year():
    spec = Spec(kind="monthly", timezone="UTC", hour=9, minute=0, day_of_month=31)
    got = occurrences_between(
        spec,
        ms("2028-02-01T00:00:00+00:00"),
        ms("2028-03-01T00:00:00+00:00"),
    )
    assert enum_iso(got) == ["2028-02-29T09:00:00+00:00"]


def test_monthly_30th_clamps_only_in_february():
    spec = Spec(kind="monthly", timezone="UTC", hour=9, minute=0, day_of_month=30)
    got = occurrences_between(
        spec,
        ms("2026-01-01T00:00:00+00:00"),
        ms("2026-04-01T00:00:00+00:00"),
    )
    assert enum_iso(got) == [
        "2026-01-30T09:00:00+00:00",
        "2026-02-28T09:00:00+00:00",
        "2026-03-30T09:00:00+00:00",
    ]


# ── DST ─────────────────────────────────────────────────────────────────────


def test_dst_spring_forward_rolls_a_nonexistent_time_to_the_gap_end():
    # US DST 2026 starts Sunday 8 March: 02:00 EST jumps straight to 03:00 EDT,
    # so 02:30 local NEVER HAPPENS that day.
    spec = Spec(kind="daily", timezone="America/New_York", hour=2, minute=30)
    got = occurrences_between(
        spec,
        ms("2026-03-07T00:00:00+00:00"),
        ms("2026-03-10T00:00:00+00:00"),
    )
    assert enum_iso(got) == [
        "2026-03-07T07:30:00+00:00",  # 02:30 EST
        "2026-03-08T07:00:00+00:00",  # rolled forward to 03:00 EDT
        "2026-03-09T06:30:00+00:00",  # 02:30 EDT
    ]
    # The skipped day still produced exactly ONE occurrence — not zero.
    assert len(got.instants) == 3


def test_dst_fall_back_fires_exactly_once_for_an_ambiguous_time():
    # US DST 2026 ends Sunday 1 November: 02:00 EDT falls back to 01:00 EST, so
    # 01:30 local happens TWICE. It must produce one occurrence, not two.
    spec = Spec(kind="daily", timezone="America/New_York", hour=1, minute=30)
    got = occurrences_between(
        spec,
        ms("2026-10-31T00:00:00+00:00"),
        ms("2026-11-03T00:00:00+00:00"),
    )
    assert enum_iso(got) == [
        "2026-10-31T05:30:00+00:00",  # 01:30 EDT
        "2026-11-01T05:30:00+00:00",  # the FIRST 01:30 (EDT), fold=0
        "2026-11-02T06:30:00+00:00",  # 01:30 EST
    ]
    assert len(got.instants) == 3


def test_a_dst_day_never_yields_a_duplicate_instant():
    spec = Spec(kind="daily", timezone="America/New_York", hour=1, minute=30)
    got = occurrences_between(
        spec,
        ms("2026-10-30T00:00:00+00:00"),
        ms("2026-11-05T00:00:00+00:00"),
    )
    assert len(got.instants) == len(set(got.instants))


def test_a_half_hour_dst_zone_is_handled_by_bisection_not_assumption():
    # Lord Howe Island shifts by THIRTY minutes. A hard-coded one-hour gap
    # assumption would land on the wrong instant here.
    # Lord Howe's spring shift is 02:00 -> 02:30 on 4 Oct 2026, so 02:15 local
    # is inside a THIRTY-minute gap.
    spec = Spec(kind="daily", timezone="Australia/Lord_Howe", hour=2, minute=15)
    got = occurrences_between(
        spec,
        ms("2026-10-03T00:00:00+00:00"),
        ms("2026-10-05T23:00:00+00:00"),
    )
    assert enum_iso(got) == [
        # Rolled forward to 02:30 +11:00 — the gap END. A hard-coded one-hour
        # assumption would land on 03:15 here.
        "2026-10-03T15:30:00+00:00",
        "2026-10-04T15:15:00+00:00",  # 02:15 +11:00
        "2026-10-05T15:15:00+00:00",  # 02:15 +11:00
    ]
    assert len(set(got.instants)) == 3


# ── cursor / recovery semantics ─────────────────────────────────────────────


def test_a_three_day_outage_yields_three_separate_instants():
    spec = Spec(kind="daily", timezone="UTC", hour=9, minute=0)
    # The cursor is where it was three days ago — the timeline is preserved,
    # so recovery reconstructs every missed occurrence individually.
    got = occurrences_between(
        spec,
        ms("2026-08-27T12:00:00+00:00"),
        ms("2026-08-30T12:00:00+00:00"),
    )
    assert enum_iso(got) == [
        "2026-08-28T09:00:00+00:00",
        "2026-08-29T09:00:00+00:00",
        "2026-08-30T09:00:00+00:00",
    ]
    assert got.truncated is False
    assert got.next_cursor_ms == ms("2026-08-30T12:00:00+00:00")


def test_a_truncated_pass_parks_the_cursor_so_nothing_is_skipped():
    spec = Spec(kind="daily", timezone="UTC", hour=9, minute=0)
    got = occurrences_between(
        spec,
        ms("2026-01-01T00:00:00+00:00"),
        ms("2026-12-31T00:00:00+00:00"),
        limit=3,
    )
    assert got.truncated is True
    assert len(got.instants) == 3
    # Crucially the cursor stops at the LAST instant actually emitted, not at
    # the end of the window — otherwise the rest would be skipped forever.
    assert got.next_cursor_ms == got.instants[-1]
    assert got.next_cursor_ms == ms("2026-01-03T09:00:00+00:00")

    # Continuing from that cursor picks up exactly where it left off.
    nxt = occurrences_between(
        spec, got.next_cursor_ms, ms("2026-12-31T00:00:00+00:00"), limit=2
    )
    assert enum_iso(nxt) == [
        "2026-01-04T09:00:00+00:00",
        "2026-01-05T09:00:00+00:00",
    ]


def test_an_empty_window_advances_the_cursor_without_emitting():
    spec = Spec(kind="daily", timezone="UTC", hour=9, minute=0)
    a = ms("2026-08-30T10:00:00+00:00")
    b = ms("2026-08-30T10:00:30+00:00")
    got = occurrences_between(spec, a, b)
    assert got.instants == []
    # A normal 30s tick: nothing due, but the cursor still moves so the next
    # tick does not rescan the same window.
    assert got.next_cursor_ms == b
    assert got.truncated is False


def test_next_occurrence_after_is_advisory_and_looks_forward_only():
    spec = Spec(kind="daily", timezone="UTC", hour=9, minute=0)
    nxt = next_occurrence_after(spec, ms("2026-08-30T10:00:00+00:00"))
    assert utc_iso(nxt) == "2026-08-31T09:00:00+00:00"

    once = Spec(kind="once", timezone="UTC", run_at=ms("2026-08-30T09:00:00+00:00"))
    assert next_occurrence_after(once, ms("2026-08-30T10:00:00+00:00")) is None


# ── spec parsing ────────────────────────────────────────────────────────────


def test_parse_spec_normalises_weekdays_and_rejects_junk():
    spec = parse_spec(
        {
            "kind": "weekly",
            "timezone": "Europe/London",
            "weekdays": [4, 0, 2, 2],
            "hour": 7,
            "minute": 5,
        }
    )
    assert spec.weekdays == (0, 2, 4)

    for bad in [
        {"kind": "daily", "timezone": "Not/AZone", "hour": 1, "minute": 0},
        {"kind": "daily", "timezone": "UTC", "hour": 24, "minute": 0},
        {"kind": "daily", "timezone": "UTC", "hour": 1, "minute": 60},
        {"kind": "weekly", "timezone": "UTC", "weekdays": [], "hour": 1, "minute": 0},
        {"kind": "weekly", "timezone": "UTC", "weekdays": [7], "hour": 1, "minute": 0},
        {"kind": "monthly", "timezone": "UTC", "dayOfMonth": 0, "hour": 1},
        {"kind": "monthly", "timezone": "UTC", "dayOfMonth": 32, "hour": 1},
        {"kind": "hourly", "timezone": "UTC", "hour": 1, "minute": 0},
        {"kind": "once", "timezone": "UTC"},
    ]:
        with pytest.raises(InvalidSpec):
            parse_spec(bad)


def test_iana_zones_resolve_without_a_system_tz_database():
    # tzdata is a DECLARED dependency, not an accident of the host OS. Windows
    # ships no zone database at all, so without it every one of these raises
    # and the whole scheduler silently stops producing occurrences.
    for zone in [
        "Asia/Kolkata",
        "America/New_York",
        "Europe/London",
        "Australia/Lord_Howe",
        "Pacific/Chatham",
    ]:
        spec = parse_spec(
            {"kind": "daily", "timezone": zone, "hour": 9, "minute": 0}
        )
        got = occurrences_between(
            spec,
            ms("2026-08-30T00:00:00+00:00"),
            ms("2026-09-01T00:00:00+00:00"),
        )
        assert len(got.instants) >= 1


# ── "End repeat" / endsAt (Phase 3) ─────────────────────────────────────────


def test_ends_at_stops_the_schedule():
    spec = Spec(
        kind="daily",
        timezone="UTC",
        hour=9,
        minute=0,
        ends_at=ms("2026-08-30T09:00:00+00:00"),
    )
    got = occurrences_between(
        spec,
        ms("2026-08-27T00:00:00+00:00"),
        ms("2026-09-05T00:00:00+00:00"),
    )
    # INCLUSIVE: the instant landing exactly on endsAt still runs, and nothing
    # after it is ever emitted.
    assert enum_iso(got) == [
        "2026-08-27T09:00:00+00:00",
        "2026-08-28T09:00:00+00:00",
        "2026-08-29T09:00:00+00:00",
        "2026-08-30T09:00:00+00:00",
    ]


def test_ends_at_already_passed_emits_nothing_but_still_advances_the_cursor():
    spec = Spec(
        kind="daily",
        timezone="UTC",
        hour=9,
        minute=0,
        ends_at=ms("2026-08-01T09:00:00+00:00"),
    )
    a = ms("2026-08-27T00:00:00+00:00")
    b = ms("2026-08-30T00:00:00+00:00")
    got = occurrences_between(spec, a, b)
    assert got.instants == []
    # The cursor still moves, or the tick would rescan the same dead window on
    # every pass forever.
    assert got.next_cursor_ms == b
    assert got.truncated is False


def test_ends_at_bounds_the_advisory_next_run():
    spec = Spec(
        kind="daily",
        timezone="UTC",
        hour=9,
        minute=0,
        ends_at=ms("2026-08-30T09:00:00+00:00"),
    )
    nxt = next_occurrence_after(spec, ms("2026-08-29T12:00:00+00:00"))
    assert utc_iso(nxt) == "2026-08-30T09:00:00+00:00"
    assert next_occurrence_after(spec, ms("2026-08-30T09:00:00+00:00")) is None


def test_schedule_exhausted_drives_task_completion():
    daily = Spec(
        kind="daily",
        timezone="UTC",
        hour=9,
        minute=0,
        ends_at=ms("2026-08-30T09:00:00+00:00"),
    )
    assert schedule_exhausted(daily, ms("2026-08-30T08:00:00+00:00")) is False
    assert schedule_exhausted(daily, ms("2026-08-30T09:00:00+00:00")) is True

    forever = Spec(kind="daily", timezone="UTC", hour=9, minute=0)
    assert schedule_exhausted(forever, ms("2030-01-01T00:00:00+00:00")) is False

    once = Spec(
        kind="once", timezone="UTC", run_at=ms("2026-08-30T09:00:00+00:00")
    )
    assert schedule_exhausted(once, ms("2026-08-30T08:00:00+00:00")) is False
    assert schedule_exhausted(once, ms("2026-08-30T09:00:00+00:00")) is True


def test_a_spec_without_ends_at_is_unchanged():
    """The pre-Phase-3 behaviour must be byte-identical."""
    plain = Spec(kind="daily", timezone="UTC", hour=9, minute=0)
    a, b = ms("2026-08-27T00:00:00+00:00"), ms("2026-08-30T00:00:00+00:00")
    got = occurrences_between(plain, a, b)
    assert enum_iso(got) == [
        "2026-08-27T09:00:00+00:00",
        "2026-08-28T09:00:00+00:00",
        "2026-08-29T09:00:00+00:00",
    ]
    assert got.next_cursor_ms == b


def test_parse_spec_reads_and_validates_ends_at():
    spec = parse_spec(
        {
            "kind": "weekly",
            "timezone": "UTC",
            "weekdays": [0, 4],
            "hour": 9,
            "minute": 0,
            "endsAt": 1_800_000_000_000,
        }
    )
    assert spec.ends_at == 1_800_000_000_000
    # absent stays None (repeats forever)
    assert parse_spec(
        {"kind": "daily", "timezone": "UTC", "hour": 9, "minute": 0}
    ).ends_at is None
    with pytest.raises(InvalidSpec):
        parse_spec(
            {
                "kind": "daily",
                "timezone": "UTC",
                "hour": 9,
                "minute": 0,
                "endsAt": "soon",
            }
        )
