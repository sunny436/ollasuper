"""Tick logic: enumeration bounds, pause suppression, chunking, dispatch.

Hermetic — no DBOS, no network, no clock. `now_ms` is injected exactly as DBOS
injects `scheduled_time` in production, so every case is reproducible.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import pytest

from app.config import Settings
from app.scheduler.models import Claim
from app.scheduler.tick import run_tick

DAY_MS = 86_400_000


def ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso).timestamp() * 1000)


NOW = ms("2026-08-30T12:00:00+00:00")

DAILY_9_UTC = {"kind": "daily", "timezone": "UTC", "hour": 9, "minute": 0}


def settings(**over: Any) -> Settings:
    base = dict(
        ai_scheduled_tasks_enabled=True,
        scheduler_materialize_limit=200,
        scheduler_claim_limit=5,
        scheduler_max_per_user=1,
        scheduler_task_page=100,
    )
    base.update(over)
    return Settings(**base)


class FakeOps:
    """Records what the tick asked Convex to do, with the cursor CAS modelled."""

    def __init__(
        self,
        tasks: list[dict[str, Any]],
        claims: list[dict[str, Any]] | None = None,
        truncated: bool = False,
    ) -> None:
        self._tasks = tasks
        self._claims = claims or []
        self._truncated = truncated
        self.materialize_calls: list[dict[str, Any]] = []
        self.claim_calls: list[dict[str, Any]] = []
        self.stale_for: set[str] = set()

    async def sched_list(self, *, limit: int) -> dict[str, Any]:
        return {"tasks": self._tasks, "truncated": self._truncated}

    async def sched_materialize(
        self,
        *,
        task_id: str,
        from_cursor: int,
        to_cursor: int,
        scheduled_for: list[int],
        next_run_at: int | None = None,
        invalid_reason: str | None = None,
        schedule_ended: bool = False,
    ) -> dict[str, Any]:
        call = {
            "task_id": task_id,
            "from_cursor": from_cursor,
            "to_cursor": to_cursor,
            "scheduled_for": scheduled_for,
            "next_run_at": next_run_at,
            "invalid_reason": invalid_reason,
            "schedule_ended": schedule_ended,
        }
        self.materialize_calls.append(call)
        if task_id in self.stale_for:
            return {"ok": True, "stale": True, "created": 0}
        if invalid_reason:
            return {"ok": True, "invalid": True, "created": 0}
        return {"ok": True, "created": len(scheduled_for)}

    async def sched_claim(
        self, *, limit: int, max_per_user: int
    ) -> dict[str, Any]:
        self.claim_calls.append({"limit": limit, "max_per_user": max_per_user})
        return {"ok": True, "claims": self._claims}


def task(
    task_id: str = "t1",
    *,
    status: str = "active",
    cursor_at: int,
    paused_at: int | None = None,
    spec: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "taskId": task_id,
        "status": status,
        "spec": spec or DAILY_9_UTC,
        "cursorAt": cursor_at,
        "pausedAt": paused_at,
        "revision": 1,
    }


async def dispatched(ops: FakeOps, s: Settings, now: int = NOW):
    seen: list[Claim] = []

    async def sink(c: Claim) -> None:
        seen.append(c)

    report = await run_tick(ops, s, now, sink)
    return report, seen


# ── materialisation ─────────────────────────────────────────────────────────


async def test_a_normal_tick_advances_the_cursor_to_the_tick_time():
    ops = FakeOps([task(cursor_at=NOW - 60_000)])
    report, _ = await dispatched(ops, settings())
    call = ops.materialize_calls[0]
    assert call["from_cursor"] == NOW - 60_000
    # The cursor is the enumeration UPPER BOUND, not the last instant found —
    # otherwise a daily task would rescan from yesterday on every tick forever.
    assert call["to_cursor"] == NOW
    assert call["scheduled_for"] == []
    assert report.occurrences_created == 0


async def test_a_three_day_outage_materialises_three_instants_in_one_tick():
    start = ms("2026-08-27T12:00:00+00:00")
    ops = FakeOps([task(cursor_at=start)])
    report, _ = await dispatched(ops, settings())
    call = ops.materialize_calls[0]
    assert call["scheduled_for"] == [
        ms("2026-08-28T09:00:00+00:00"),
        ms("2026-08-29T09:00:00+00:00"),
        ms("2026-08-30T09:00:00+00:00"),
    ]
    # Three separate durable occurrences, never one coalesced catch-up.
    assert report.occurrences_created == 3


async def test_a_task_whose_cursor_is_current_is_skipped_entirely():
    ops = FakeOps([task(cursor_at=NOW)])
    report, _ = await dispatched(ops, settings())
    assert ops.materialize_calls == []
    assert report.tasks_seen == 1


async def test_chunking_parks_the_cursor_and_never_drops_instants():
    start = ms("2026-01-01T00:00:00+00:00")
    ops = FakeOps([task(cursor_at=start)])
    report, _ = await dispatched(ops, settings(scheduler_materialize_limit=3))
    call = ops.materialize_calls[0]
    assert len(call["scheduled_for"]) == 3
    # The cursor stops on the LAST instant written, so the next tick resumes
    # from there. Nothing between it and `now` is lost.
    assert call["to_cursor"] == call["scheduled_for"][-1]
    assert call["to_cursor"] < NOW
    assert report.tasks_chunked == 1


async def test_a_stale_cursor_response_is_counted_and_survived():
    ops = FakeOps([task(cursor_at=NOW - DAY_MS)])
    ops.stale_for.add("t1")
    report, _ = await dispatched(ops, settings())
    # Another tick won the race. Expected under overlap, not an error.
    assert report.tasks_stale == 1
    assert report.occurrences_created == 0


async def test_an_unresolvable_spec_parks_the_task_without_moving_the_cursor():
    ops = FakeOps(
        [
            task(
                cursor_at=NOW - DAY_MS,
                spec={
                    "kind": "daily",
                    "timezone": "Mars/Olympus",
                    "hour": 9,
                    "minute": 0,
                },
            )
        ]
    )
    report, _ = await dispatched(ops, settings())
    call = ops.materialize_calls[0]
    assert call["invalid_reason"] is not None
    assert "Mars/Olympus" in call["invalid_reason"]
    # Cursor unchanged: once the spec is fixed, nothing has been skipped.
    assert call["to_cursor"] == call["from_cursor"]
    assert call["scheduled_for"] == []
    assert report.tasks_invalid == 1


# ── pause: the exactness that makes suppression correct in BOTH directions ──


async def test_a_paused_task_is_materialised_only_up_to_its_pausedAt():
    paused_at = ms("2026-08-29T12:00:00+00:00")
    ops = FakeOps(
        [
            task(
                status="paused",
                cursor_at=ms("2026-08-27T12:00:00+00:00"),
                paused_at=paused_at,
            )
        ]
    )
    await dispatched(ops, settings())
    call = ops.materialize_calls[0]
    # Occurrences due BEFORE the pause are still created (they were owed).
    assert call["scheduled_for"] == [
        ms("2026-08-28T09:00:00+00:00"),
        ms("2026-08-29T09:00:00+00:00"),
    ]
    # And the window stops dead at pausedAt, so nothing inside the pause is
    # ever enumerated — which is what makes "no backfill on resume" exact.
    assert call["to_cursor"] == paused_at
    assert ms("2026-08-30T09:00:00+00:00") not in call["scheduled_for"]


async def test_a_paused_task_already_caught_up_does_nothing():
    paused_at = ms("2026-08-29T12:00:00+00:00")
    ops = FakeOps(
        [task(status="paused", cursor_at=paused_at, paused_at=paused_at)]
    )
    await dispatched(ops, settings())
    # No churn once the cursor has reached pausedAt.
    assert ops.materialize_calls == []


# ── dispatch ────────────────────────────────────────────────────────────────


async def test_claims_are_dispatched_and_carry_their_lease():
    ops = FakeOps(
        [task(cursor_at=NOW)],
        claims=[
            {
                "occurrenceKey": "t1:scheduled:100",
                "taskId": "t1",
                "revision": 2,
                "scheduledFor": 100,
                "kind": "scheduled",
                "attempts": 0,
                "leaseToken": "lease-a",
            }
        ],
    )
    report, seen = await dispatched(ops, settings())
    assert len(seen) == 1
    assert seen[0].occurrence_key == "t1:scheduled:100"
    assert seen[0].lease_token == "lease-a"
    # The occurrence executes under the revision it was CREATED with.
    assert seen[0].revision == 2
    assert report.claims == seen
    assert ops.claim_calls == [{"limit": 5, "max_per_user": 1}]


async def test_the_configured_capacity_limits_are_passed_through():
    ops = FakeOps([task(cursor_at=NOW)])
    await dispatched(
        ops, settings(scheduler_claim_limit=9, scheduler_max_per_user=4)
    )
    assert ops.claim_calls == [{"limit": 9, "max_per_user": 4}]


async def test_a_truncated_task_page_is_reported_not_hidden():
    ops = FakeOps([task(cursor_at=NOW)], truncated=True)
    report, _ = await dispatched(ops, settings())
    # A silent cap would read as "everything is covered" when it is not.
    assert report.truncated is True


@pytest.mark.parametrize("kind", ["daily", "weekly", "monthly"])
async def test_every_recurrence_kind_survives_a_tick(kind: str):
    spec = {
        "daily": DAILY_9_UTC,
        "weekly": {
            "kind": "weekly",
            "timezone": "UTC",
            "weekdays": [0, 2, 4],
            "hour": 9,
            "minute": 0,
        },
        "monthly": {
            "kind": "monthly",
            "timezone": "UTC",
            "dayOfMonth": 31,
            "hour": 9,
            "minute": 0,
        },
    }[kind]
    ops = FakeOps([task(cursor_at=NOW - 40 * DAY_MS, spec=spec)])
    report, _ = await dispatched(ops, settings())
    assert report.occurrences_created > 0
    assert ops.materialize_calls[0]["next_run_at"] is not None


# ── configuration guards ────────────────────────────────────────────────────


def test_the_default_tick_cron_actually_parses():
    """A typo'd cron would not raise — DBOS logs and the schedule never fires.

    That failure mode is silent and total: no tick, no occurrences, no error
    the product surfaces. Assert the shipped default here instead.
    """
    from datetime import UTC, datetime

    from dbos._croniter import croniter  # type: ignore[import-untyped]

    s = Settings()
    it = croniter(
        s.scheduler_tick_cron,
        datetime(2026, 8, 30, 12, 0, 0, tzinfo=UTC),
        second_at_beginning=True,
    )
    first = it.get_next(datetime)
    second = it.get_next(datetime)
    assert (second - first).total_seconds() == 30


def test_the_scheduler_is_off_by_default():
    # An unconfigured deployment must register no schedule and no queue. This
    # is the ONLY gate that matters: from Phase 2 the executor defaults to the
    # real "chat" one, so the flag is what keeps a fresh deployment inert.
    assert Settings().ai_scheduled_tasks_enabled is False
    assert Settings().scheduler_executor == "chat"


def test_the_dbos_url_is_redacted_from_logs():
    """It embeds a password; without this it reaches journalctl."""
    s = Settings(scheduler_database_url="postgresql://u:sup3rs3cret@h/db")
    assert "postgresql://u:sup3rs3cret@h/db" in s.secrets()


async def test_an_ended_schedule_is_reported_so_the_task_can_close():
    """`endsAt` in the past ⇒ the tick tells Convex the schedule is finished."""
    ops = FakeOps(
        [
            task(
                cursor_at=NOW - DAY_MS,
                spec={
                    **DAILY_9_UTC,
                    "endsAt": NOW - 2 * DAY_MS,
                },
            )
        ]
    )
    await dispatched(ops, settings())
    call = ops.materialize_calls[0]
    assert call["scheduled_for"] == []
    assert call["schedule_ended"] is True


async def test_a_live_schedule_is_never_reported_as_ended():
    ops = FakeOps([task(cursor_at=NOW - DAY_MS)])
    await dispatched(ops, settings())
    assert ops.materialize_calls[0]["schedule_ended"] is False


async def test_a_chunked_pass_is_never_reported_as_ended():
    """A truncated window still has instants to emit — not exhausted."""
    ops = FakeOps(
        [
            task(
                cursor_at=ms("2026-01-01T00:00:00+00:00"),
                spec={**DAILY_9_UTC, "endsAt": NOW},
            )
        ]
    )
    await dispatched(ops, settings(scheduler_materialize_limit=3))
    assert ops.materialize_calls[0]["schedule_ended"] is False
