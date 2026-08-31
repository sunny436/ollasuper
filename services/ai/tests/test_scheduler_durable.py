"""Durability of the occurrence lifecycle under REAL DBOS Transact.

DBOS is run against a temporary SQLite system database (`use_listen_notify` off,
which SQLite requires). That makes crash-recovery, workflow-id idempotency,
partitioned serialisation and cancellation testable with no Docker and no
Postgres. It proves the LOGIC, not production behaviour: Postgres is the
production target, and the Postgres-only checks (LISTEN/NOTIFY, row-lock
contention, multi-process, SIGKILL) are listed in the plan as a later gate.

Convex is replaced by an in-memory ledger that mirrors the real mutations'
semantics — lease checks, one-running-per-task, idempotent finalize — so the
worker's contract is exercised honestly. The Convex mutations themselves are
covered by convex/scheduled.durable.test.ts.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import pytest
from dbos import DBOS

import app.scheduler.main as sched
from app.config import Settings
from app.scheduler.executor import ExecutionResult, OccurrenceContext
from app.scheduler.models import Claim

QUEUE = "scheduled_tasks_test"


# ── an in-memory stand-in for the Convex ledger ─────────────────────────────


class FakeConvex:
    def __init__(self) -> None:
        self.occ: dict[str, dict[str, Any]] = {}
        self.finalize_calls = 0

    def add(self, key: str, task_id: str, *, attempts: int = 0) -> None:
        self.occ[key] = {
            "key": key,
            "taskId": task_id,
            "status": "queued",
            "attempts": attempts,
            "lease": None,
            "cancelRequested": False,
            "revision": 1,
            "scheduledFor": 1_000,
        }

    def claim(self, key: str) -> Claim:
        """Mirror the Convex claim: queued -> running, mint a lease."""
        o = self.occ[key]
        assert o["status"] in ("queued", "retrying")
        o["status"] = "running"
        o["lease"] = str(uuid.uuid4())
        return Claim(
            occurrence_key=key,
            task_id=o["taskId"],
            revision=o["revision"],
            scheduled_for=o["scheduledFor"],
            kind="scheduled",
            attempts=o["attempts"],
            lease_token=o["lease"],
        )

    async def sched_list(self, *, limit: int) -> dict[str, Any]:
        return {"tasks": [], "truncated": False}

    async def sched_materialize(self, **kw: Any) -> dict[str, Any]:
        return {"ok": True, "created": 0}

    async def sched_claim(self, **kw: Any) -> dict[str, Any]:
        return {"ok": True, "claims": []}

    async def sched_verify(
        self, *, occurrence_key: str, lease_token: str, workflow_id: str
    ) -> dict[str, Any]:
        o = self.occ.get(occurrence_key)
        if o is None:
            return {"ok": False, "unknown": True, "cancel": True}
        if o["lease"] != lease_token:
            return {"ok": False, "stale": True, "cancel": True}
        if o["status"] in ("succeeded", "failed", "cancelled"):
            return {"ok": False, "stale": True, "cancel": True}
        if o["cancelRequested"]:
            return {"ok": True, "cancel": True}
        o["workflowId"] = workflow_id
        return {"ok": True, "cancel": False, "attempts": o["attempts"]}

    async def sched_heartbeat(
        self, *, occurrence_key: str, lease_token: str
    ) -> dict[str, Any]:
        o = self.occ.get(occurrence_key)
        if o is None or o["lease"] != lease_token:
            return {"ok": False, "stale": True, "cancel": True}
        return {"ok": True, "cancel": o["cancelRequested"]}

    async def sched_finalize(
        self,
        *,
        occurrence_key: str,
        lease_token: str,
        outcome: str,
        error_code: str | None = None,
        retryable: bool = False,
    ) -> dict[str, Any]:
        self.finalize_calls += 1
        o = self.occ.get(occurrence_key)
        if o is None:
            return {"ok": False, "unknown": True}
        if o["status"] in ("succeeded", "failed", "cancelled"):
            return {"ok": True, "alreadyTerminal": True, "status": o["status"]}
        if o["lease"] != lease_token:
            return {"ok": False, "stale": True}
        o["attempts"] += 1
        if outcome == "failed" and retryable and o["attempts"] < 3:
            o["status"] = "retrying"
            o["lease"] = None
            return {"ok": True, "status": "retrying", "attempts": o["attempts"]}
        o["status"] = outcome
        o["lease"] = None
        return {"ok": True, "status": outcome, "attempts": o["attempts"]}


class RecordingExecutor:
    """Counts executions and can be made to block, fail or be cancelled."""

    def __init__(self) -> None:
        self.calls: list[OccurrenceContext] = []
        self.gate: asyncio.Event | None = None
        self.fail_with: str | None = None
        self.retryable = False
        self.hold_s = 0.0

    async def execute(self, ctx: OccurrenceContext) -> ExecutionResult:
        self.calls.append(ctx)
        if self.gate is not None:
            await self.gate.wait()
        if self.hold_s:
            await asyncio.sleep(self.hold_s)
        if self.fail_with:
            return ExecutionResult(
                ok=False, error_code=self.fail_with, retryable=self.retryable
            )
        return ExecutionResult(ok=True)


@pytest.fixture
def env(tmp_path):
    """A fresh DBOS instance on its own SQLite file, wired to the fakes."""
    fake = FakeConvex()
    executor = RecordingExecutor()
    settings = Settings(
        ai_scheduled_tasks_enabled=True,
        scheduler_queue_name=QUEUE,
        scheduler_heartbeat_s=0.05,
        scheduler_database_url="",
    )
    db = (tmp_path / "sys.sqlite").as_posix()
    sched._SETTINGS = settings
    sched._CLIENT = fake  # type: ignore[assignment]
    sched._EXECUTOR = executor
    yield {
        "fake": fake,
        "executor": executor,
        "settings": settings,
        "url": f"sqlite:///{db}",
    }
    try:
        DBOS.destroy(destroy_registry=False)
    except Exception:  # noqa: BLE001, S110 — teardown must never mask a failure
        pass


async def _boot(url: str, settings: Settings) -> None:
    DBOS(
        config={
            "name": "myos-scheduler-test",
            "system_database_url": url,
            "use_listen_notify": False,  # SQLite requires polling
            "run_admin_server": False,
            "enable_otlp": False,
            "log_level": "WARNING",
        }
    )
    DBOS.launch()
    await DBOS.register_queue_async(
        settings.scheduler_queue_name,
        global_concurrency=8,
        partition_concurrency=1,  # one occurrence per task at a time
    )


# ── the lifecycle end to end ────────────────────────────────────────────────


async def test_a_dispatched_occurrence_runs_once_and_finalises(env):
    await _boot(env["url"], env["settings"])
    fake, ex = env["fake"], env["executor"]
    fake.add("k1", "taskA")
    claim = fake.claim("k1")

    await sched._dispatch(claim)
    handle = await DBOS.retrieve_workflow_async(
        sched.occurrence_workflow_id(claim)
    )
    assert await handle.get_result() == "succeeded"
    assert fake.occ["k1"]["status"] == "succeeded"
    assert len(ex.calls) == 1
    assert ex.calls[0].occurrence_key == "k1"


async def test_a_duplicate_dispatch_of_the_same_attempt_executes_once(env):
    await _boot(env["url"], env["settings"])
    fake, ex = env["fake"], env["executor"]
    fake.add("k1", "taskA")
    claim = fake.claim("k1")

    # A duplicate scheduler event / a recovered tick re-dispatching.
    await sched._dispatch(claim)
    await sched._dispatch(claim)
    handle = await DBOS.retrieve_workflow_async(
        sched.occurrence_workflow_id(claim)
    )
    await handle.get_result()

    # The workflow id IS the idempotency key: one occurrence, one execution.
    assert len(ex.calls) == 1
    assert fake.occ["k1"]["status"] == "succeeded"


async def test_a_retry_is_a_NEW_workflow_so_it_is_not_deduped_away(env):
    """The bug this guards against is silent and total.

    If the workflow id were just `occ:<key>`, a retry would collide with the
    completed first attempt, DBOS would return the old handle, and the
    occurrence would sit in `retrying` forever without ever running again.
    """
    await _boot(env["url"], env["settings"])
    fake, ex = env["fake"], env["executor"]
    fake.add("k1", "taskA")

    ex.fail_with = "upstream_5xx"
    ex.retryable = True
    c1 = fake.claim("k1")
    await sched._dispatch(c1)
    h1 = await DBOS.retrieve_workflow_async(sched.occurrence_workflow_id(c1))
    assert await h1.get_result() == "retrying"
    assert fake.occ["k1"]["status"] == "retrying"
    assert fake.occ["k1"]["attempts"] == 1

    # The reaper/tick re-claims it: same occurrence, next attempt.
    ex.fail_with = None
    c2 = fake.claim("k1")
    assert sched.occurrence_workflow_id(c2) != sched.occurrence_workflow_id(c1)
    await sched._dispatch(c2)
    h2 = await DBOS.retrieve_workflow_async(sched.occurrence_workflow_id(c2))
    assert await h2.get_result() == "succeeded"

    # Two attempts of ONE logical occurrence.
    assert len(ex.calls) == 2
    assert {c.occurrence_key for c in ex.calls} == {"k1"}
    assert fake.occ["k1"]["status"] == "succeeded"


# ── serialisation vs concurrency ────────────────────────────────────────────


async def test_same_task_serialises_while_different_tasks_overlap(env):
    await _boot(env["url"], env["settings"])
    fake, ex = env["fake"], env["executor"]
    ex.hold_s = 0.3

    # Real spans, so "overlapped" and "did not overlap" are measured, not
    # inferred from list ordering.
    spans: dict[str, list[float]] = {}
    original = ex.execute

    async def tracked(ctx: OccurrenceContext) -> ExecutionResult:
        spans[ctx.occurrence_key] = [asyncio.get_running_loop().time(), 0.0]
        try:
            return await original(ctx)
        finally:
            spans[ctx.occurrence_key][1] = asyncio.get_running_loop().time()

    ex.execute = tracked  # type: ignore[method-assign]

    handles = []
    for key, task_id in [("a1", "taskA"), ("a2", "taskA"), ("b1", "taskB")]:
        fake.add(key, task_id)
        claim = fake.claim(key)
        await sched._dispatch(claim)
        handles.append(
            await DBOS.retrieve_workflow_async(
                sched.occurrence_workflow_id(claim)
            )
        )
    for h in handles:
        await h.get_result()

    assert len(ex.calls) == 3
    a1, a2, b1 = spans["a1"], spans["a2"], spans["b1"]

    def overlaps(x: list[float], y: list[float]) -> bool:
        return x[0] < y[1] and y[0] < x[1]

    # Two occurrences of the SAME task must never run at the same time.
    assert not overlaps(a1, a2), f"taskA overlapped itself: {a1} {a2}"
    # A different task must be able to run at the same time as taskA, or the
    # scheduler has globally serialised everything.
    assert overlaps(b1, a1) or overlaps(b1, a2), (
        f"taskB never overlapped taskA: {b1} {a1} {a2}"
    )


# ── stale state: the guard that makes a restored DBOS dump harmless ─────────


async def test_a_rotated_lease_stops_the_run_before_any_side_effect(env):
    await _boot(env["url"], env["settings"])
    fake, ex = env["fake"], env["executor"]
    fake.add("k1", "taskA")
    claim = fake.claim("k1")
    # The reaper decided this holder was dead and handed the work on.
    fake.occ["k1"]["lease"] = "a-newer-lease"

    await sched._dispatch(claim)
    handle = await DBOS.retrieve_workflow_async(
        sched.occurrence_workflow_id(claim)
    )
    assert await handle.get_result() == "stale"
    # Nothing executed and nothing was written.
    assert ex.calls == []
    assert fake.finalize_calls == 0
    assert fake.occ["k1"]["status"] == "running"


async def test_an_already_terminal_occurrence_is_not_re_executed(env):
    """Exactly what a workflow recovered from a stale DBOS dump looks like."""
    await _boot(env["url"], env["settings"])
    fake, ex = env["fake"], env["executor"]
    fake.add("k1", "taskA")
    claim = fake.claim("k1")
    fake.occ["k1"]["status"] = "succeeded"  # Convex already finished it

    await sched._dispatch(claim)
    handle = await DBOS.retrieve_workflow_async(
        sched.occurrence_workflow_id(claim)
    )
    assert await handle.get_result() == "stale"
    assert ex.calls == []


async def test_a_duplicate_finalize_leaves_the_terminal_state_intact(env):
    await _boot(env["url"], env["settings"])
    fake = env["fake"]
    fake.add("k1", "taskA")
    claim = fake.claim("k1")
    await sched._dispatch(claim)
    h = await DBOS.retrieve_workflow_async(sched.occurrence_workflow_id(claim))
    await h.get_result()

    again = await fake.sched_finalize(
        occurrence_key="k1",
        lease_token=claim.lease_token,
        outcome="failed",
        error_code="ignored",
    )
    assert again["alreadyTerminal"] is True
    assert fake.occ["k1"]["status"] == "succeeded"


# ── cancellation ────────────────────────────────────────────────────────────


async def test_cancellation_reaches_a_running_worker_through_the_heartbeat(env):
    await _boot(env["url"], env["settings"])
    fake, ex = env["fake"], env["executor"]
    fake.add("k1", "taskA")
    claim = fake.claim("k1")
    gate = asyncio.Event()
    ex.gate = gate

    await sched._dispatch(claim)
    handle = await DBOS.retrieve_workflow_async(
        sched.occurrence_workflow_id(claim)
    )
    # Wait until the executor is genuinely in-flight and blocked.
    for _ in range(200):
        if ex.calls:
            break
        await asyncio.sleep(0.02)
    assert ex.calls, "executor never started"

    # Convex cannot push, so cancellation is a flag the heartbeat observes.
    fake.occ["k1"]["cancelRequested"] = True
    assert await handle.get_result() == "cancelled"
    assert fake.occ["k1"]["status"] == "cancelled"
    gate.set()


# ── restart recovery ────────────────────────────────────────────────────────


async def test_an_interrupted_workflow_is_recovered_after_a_restart(env):
    """Stop DBOS mid-run, restart it, and the occurrence still completes.

    This is the "DBOS restart / worker restart" requirement: the workflow was
    checkpointed, so recovery resumes it rather than losing the occurrence.
    """
    await _boot(env["url"], env["settings"])
    fake, ex = env["fake"], env["executor"]
    fake.add("k1", "taskA")
    claim = fake.claim("k1")

    gate = asyncio.Event()
    ex.gate = gate
    await sched._dispatch(claim)
    for _ in range(200):
        if ex.calls:
            break
        await asyncio.sleep(0.02)
    assert ex.calls, "executor never started"
    assert fake.occ["k1"]["status"] == "running"

    # Hard stop while the occurrence is mid-flight.
    DBOS.destroy(destroy_registry=False)

    # Restart against the SAME system database. Let it complete this time.
    ex.gate = None
    await _boot(env["url"], env["settings"])

    handle = await DBOS.retrieve_workflow_async(
        sched.occurrence_workflow_id(claim)
    )
    result = await asyncio.wait_for(handle.get_result(), timeout=30)
    assert result == "succeeded"
    assert fake.occ["k1"]["status"] == "succeeded"
    # It ran again after recovery — the occurrence was never lost.
    assert len(ex.calls) >= 1
