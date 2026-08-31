"""The lifecycle of ONE occurrence: verify, execute, finalize.

Two properties matter more than anything else here.

  * NOTHING side-effecting happens before `sched_verify` succeeds. That is what
    makes a stale DBOS system database harmless: after restoring an old dump,
    DBOS will happily recover workflows for occurrences Convex already
    finished, and every one of them stops at the verify gate. Convex is the
    ledger; DBOS is only the engine.
  * The heartbeat is also the CANCELLATION channel. Convex cannot push to
    Python, so every heartbeat response carries `{cancel}` and the worker
    learns within one interval — exactly how the chat stop button works.
"""

from __future__ import annotations

import asyncio
from typing import Any, Protocol

from app.config import Settings
from app.logging import get_logger
from app.scheduler.executor import (
    ExecutionResult,
    OccurrenceContext,
    OccurrenceExecutor,
)
from app.scheduler.models import Claim

log = get_logger(__name__)


class OccurrenceOps(Protocol):
    async def sched_verify(
        self, *, occurrence_key: str, lease_token: str, workflow_id: str
    ) -> dict[str, Any]: ...

    async def sched_heartbeat(
        self, *, occurrence_key: str, lease_token: str
    ) -> dict[str, Any]: ...

    async def sched_finalize(
        self,
        *,
        occurrence_key: str,
        lease_token: str,
        outcome: str,
        error_code: str | None = None,
        retryable: bool = False,
    ) -> dict[str, Any]: ...


async def _heartbeat_loop(
    ops: OccurrenceOps,
    claim: Claim,
    interval_s: float,
    cancelled: asyncio.Event,
) -> None:
    """Prove liveness; surface a cancellation request as soon as it appears."""
    while not cancelled.is_set():
        try:
            await asyncio.sleep(interval_s)
        except asyncio.CancelledError:
            return
        try:
            res = await ops.sched_heartbeat(
                occurrence_key=claim.occurrence_key,
                lease_token=claim.lease_token,
            )
        except Exception as e:  # noqa: BLE001 — a blip must not kill the run
            log.warning(
                "sched.heartbeat_failed",
                extra={
                    "occurrence_key": claim.occurrence_key,
                    "error": type(e).__name__,
                },
            )
            continue
        # A rotated lease means the reaper already handed this occurrence to
        # someone else. Stop immediately rather than racing the new holder.
        if res.get("cancel") or res.get("stale"):
            cancelled.set()
            return


async def run_occurrence(
    ops: OccurrenceOps,
    settings: Settings,
    executor: OccurrenceExecutor,
    claim: Claim,
    workflow_id: str,
) -> str:
    """Execute one occurrence and return its terminal outcome as a string."""
    verify = await ops.sched_verify(
        occurrence_key=claim.occurrence_key,
        lease_token=claim.lease_token,
        workflow_id=workflow_id,
    )
    if not verify.get("ok"):
        # Already terminal, or the lease was rotated away. Exit WITHOUT
        # executing and without writing anything.
        log.info(
            "sched.run_abandoned",
            extra={
                "occurrence_key": claim.occurrence_key,
                "workflow_id": workflow_id,
                "reason": "stale" if verify.get("stale") else "unknown",
            },
        )
        return "stale"
    if verify.get("cancel"):
        await ops.sched_finalize(
            occurrence_key=claim.occurrence_key,
            lease_token=claim.lease_token,
            outcome="cancelled",
        )
        return "cancelled"

    ctx = OccurrenceContext(
        occurrence_key=claim.occurrence_key,
        task_id=claim.task_id,
        revision=claim.revision,
        scheduled_for=claim.scheduled_for,
        kind=claim.kind,
        attempts=claim.attempts,
        # Every Convex call the executor makes is lease-guarded too, so a stale
        # worker cannot drive a turn for an occurrence someone else now holds.
        lease_token=claim.lease_token,
    )
    log.info(
        "sched.run_start",
        extra={
            "occurrence_key": claim.occurrence_key,
            "task_id": claim.task_id,
            "workflow_id": workflow_id,
            "revision": claim.revision,
            "attempt": claim.attempts + 1,
        },
    )

    cancelled = asyncio.Event()
    heartbeat = asyncio.create_task(
        _heartbeat_loop(ops, claim, settings.scheduler_heartbeat_s, cancelled)
    )
    work = asyncio.create_task(executor.execute(ctx))
    waiter = asyncio.create_task(cancelled.wait())

    result: ExecutionResult
    try:
        done, _ = await asyncio.wait(
            {work, waiter}, return_when=asyncio.FIRST_COMPLETED
        )
        if work in done:
            try:
                result = work.result()
            except asyncio.CancelledError:
                result = ExecutionResult(
                    ok=False, error_code="cancelled", retryable=False
                )
            except Exception as e:  # noqa: BLE001 — report honestly, never fake
                log.exception(
                    "sched.execute_failed",
                    extra={"occurrence_key": claim.occurrence_key},
                )
                result = ExecutionResult(
                    ok=False, error_code=type(e).__name__, retryable=True
                )
        else:
            # Cancellation (or a stolen lease) won the race.
            work.cancel()
            result = ExecutionResult(
                ok=False, error_code="cancelled", retryable=False
            )
    finally:
        cancelled.set()
        for task in (heartbeat, waiter, work):
            if not task.done():
                task.cancel()
        await asyncio.gather(heartbeat, waiter, work, return_exceptions=True)

    if result.error_code == "cancelled":
        outcome = "cancelled"
    else:
        outcome = "succeeded" if result.ok else "failed"

    final = await ops.sched_finalize(
        occurrence_key=claim.occurrence_key,
        lease_token=claim.lease_token,
        outcome=outcome,
        error_code=result.error_code,
        retryable=result.retryable,
    )
    log.info(
        "sched.run_finish",
        extra={
            "occurrence_key": claim.occurrence_key,
            "task_id": claim.task_id,
            "workflow_id": workflow_id,
            "outcome": outcome,
            "recorded": final.get("status"),
            "attempt": claim.attempts + 1,
            "error_code": result.error_code,
            "stale": bool(final.get("stale")),
        },
    )
    return str(final.get("status") or outcome)
