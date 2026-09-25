"""One scheduler tick: materialise due occurrences, then claim what can run.

The tick is deliberately dumb and idempotent. It holds no state of its own —
every decision is derived from each task's stored `cursorAt`, which is what
makes a three-day outage reconstruct three separate occurrences instead of one
"catch-up" run. Running the same tick twice is a no-op, so DBOS is free to
recover and replay it.

`now_ms` is INJECTED, never read from the clock here: in production it is the
DBOS `scheduled_time`, which is stable across a workflow replay, and in tests it
is a fixed timestamp.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.config import Settings
from app.logging import get_logger
from app.scheduler.models import Claim, TaskRow
from app.scheduler.recurrence import (
    InvalidSpec,
    next_occurrence_after,
    occurrences_between,
    parse_spec,
    schedule_exhausted,
)

log = get_logger(__name__)


class SchedulerOps(Protocol):
    """The Convex ops the tick needs.

    A Protocol rather than a concrete client so production can wrap each call in
    a DBOS step (durable, retried) while tests pass a fake — without the tick
    logic knowing which it is talking to.
    """

    async def sched_list(self, *, limit: int) -> dict[str, Any]: ...

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
    ) -> dict[str, Any]: ...

    async def sched_claim(
        self, *, limit: int, max_per_user: int
    ) -> dict[str, Any]: ...


@dataclass
class TickReport:
    tasks_seen: int = 0
    occurrences_created: int = 0
    tasks_invalid: int = 0
    tasks_chunked: int = 0
    tasks_stale: int = 0
    claims: list[Claim] = field(default_factory=list)
    truncated: bool = False


def _materialise_upper_bound(task: TaskRow, now_ms: int) -> int:
    """How far forward this task may be enumerated on this tick.

    For a PAUSED task the bound is its `pausedAt`, not `now`. That single line
    is what makes pause exact in both directions: an occurrence that came due
    just BEFORE the pause is still materialised (durable, then held), while
    nothing at or after `pausedAt` is ever enumerated — so the pause window can
    never be backfilled on resume.
    """
    if task.status == "paused" and task.paused_at is not None:
        return min(now_ms, task.paused_at)
    return now_ms


async def run_tick(
    ops: SchedulerOps,
    settings: Settings,
    now_ms: int,
    dispatch: Callable[[Claim], Awaitable[None]],
) -> TickReport:
    report = TickReport()

    listed = await ops.sched_list(limit=settings.scheduler_task_page)
    raw_tasks = listed.get("tasks") or []
    report.truncated = bool(listed.get("truncated"))
    if report.truncated:
        # Never a silent cap: say so, so a growing backlog is visible instead of
        # looking like "everything is covered".
        log.warning("sched.task_page_truncated", extra={"page": len(raw_tasks)})

    for raw in raw_tasks:
        task = TaskRow.from_json(raw)
        report.tasks_seen += 1
        upper = _materialise_upper_bound(task, now_ms)
        if upper <= task.cursor_at:
            continue

        try:
            spec = parse_spec(task.spec)
        except InvalidSpec as e:
            # The task stops producing occurrences and says why, instead of
            # failing silently every tick forever.
            report.tasks_invalid += 1
            reason = str(e)[:200]
            if task.invalid_reason == reason:
                # Already on record, for the same reason: nothing new to say.
                # It used to be logged and re-materialised on EVERY tick —
                # 159,098 warnings in 30 days. The spec is still re-parsed each
                # tick, so a fix (an edit, or a deploy like the 09-25 one)
                # recovers the task on the next tick with no manual step. The
                # decision rests on sched-list's recorded output, so a DBOS
                # replay takes the same branch.
                continue
            log.warning(
                "sched.spec_invalid",
                extra={"task_id": task.task_id, "reason": str(e)},
            )
            await ops.sched_materialize(
                task_id=task.task_id,
                from_cursor=task.cursor_at,
                to_cursor=task.cursor_at,
                scheduled_for=[],
                invalid_reason=reason,
            )
            continue

        found = occurrences_between(
            spec,
            task.cursor_at,
            upper,
            limit=settings.scheduler_materialize_limit,
        )
        if found.truncated:
            report.tasks_chunked += 1
            log.info(
                "sched.materialise_chunked",
                extra={
                    "task_id": task.task_id,
                    "emitted": len(found.instants),
                    "cursor_parked_at": found.next_cursor_ms,
                },
            )

        # "End repeat": once the schedule can produce nothing further, tell
        # Convex so the task closes itself. Only reported when the window was
        # NOT truncated — a chunked pass has more to emit and is not exhausted.
        ended = not found.truncated and schedule_exhausted(
            spec, found.next_cursor_ms
        )
        result = await ops.sched_materialize(
            task_id=task.task_id,
            from_cursor=task.cursor_at,
            to_cursor=found.next_cursor_ms,
            scheduled_for=found.instants,
            next_run_at=next_occurrence_after(spec, found.next_cursor_ms),
            schedule_ended=ended,
        )
        if result.get("stale"):
            # Another tick moved the cursor first. Correct and expected under
            # overlap; the work is not lost, it is simply already done.
            report.tasks_stale += 1
            continue
        created = int(result.get("created") or 0)
        report.occurrences_created += created
        if created:
            log.info(
                "sched.materialised",
                # `occurrences`, NOT `created`: LogRecord already owns `created`
                # (the record's timestamp), and logging raises KeyError rather
                # than overwriting it. That made this line fatal at INFO — which
                # is production's level — while staying invisible in tests,
                # because Logger.info short-circuits before building a record
                # when the level is above INFO. See test_logging_extra_keys.
                extra={
                    "task_id": task.task_id,
                    "occurrences": created,
                    "from_cursor": task.cursor_at,
                    "to_cursor": found.next_cursor_ms,
                },
            )

    claimed = await ops.sched_claim(
        limit=settings.scheduler_claim_limit,
        max_per_user=settings.scheduler_max_per_user,
    )
    for raw_claim in claimed.get("claims") or []:
        claim = Claim.from_json(raw_claim)
        report.claims.append(claim)
        log.info(
            "sched.claimed",
            extra={
                "occurrence_key": claim.occurrence_key,
                "task_id": claim.task_id,
                "scheduled_for": claim.scheduled_for,
                "queue_delay_ms": max(0, now_ms - claim.scheduled_for),
                "attempt": claim.attempts + 1,
            },
        )
        await dispatch(claim)

    return report
