"""Phase 2 — the ChatExecutor: start / poll / classify, and cancellation.

Hermetic: Convex is a programmable fake, so every branch of the failure
classification is exercised deterministically. The Convex mutations themselves
are covered by convex/scheduled.execution.test.ts, which runs the real function
code; a real model + real Ollagraph are covered by the opt-in live suite.
"""

from __future__ import annotations

import asyncio

import pytest

from app.config import Settings
from app.scheduler.executor import (
    ChatExecutor,
    NoopExecutor,
    OccurrenceContext,
    build_executor,
)

pytestmark = pytest.mark.anyio

CTX = OccurrenceContext(
    occurrence_key="task1:scheduled:1000",
    task_id="task1",
    revision=2,
    scheduled_for=1000,
    kind="scheduled",
    attempts=0,
    lease_token="lease-a",
)


def settings(**over) -> Settings:
    base = dict(
        ai_scheduled_tasks_enabled=True,
        scheduler_executor="chat",
        scheduler_poll_interval_s=0.01,
        scheduler_turn_deadline_ms=1_200_000,
    )
    base.update(over)
    return Settings(**base)


class FakeConvex:
    """Programmable stand-in for the three execution ops."""

    def __init__(self, start: dict, statuses: list[dict]) -> None:
        self._start = start
        self._statuses = list(statuses)
        self.start_calls: list[dict] = []
        self.status_calls = 0
        self.cancel_calls = 0

    async def sched_start_run(self, **kw) -> dict:
        self.start_calls.append(kw)
        return self._start

    async def sched_run_status(self, **kw) -> dict:
        self.status_calls += 1
        if self._statuses:
            return self._statuses.pop(0)
        # Park forever on the last shape (used by the cancellation tests).
        return {"ok": True, "terminal": False}

    async def sched_cancel_run(self, **kw) -> dict:
        self.cancel_calls += 1
        return {"ok": True, "requested": True}


def running(**over) -> dict:
    base = {"ok": True, "terminal": False, "cancelRequested": False}
    base.update(over)
    return base


def terminal(stream_status: str, code: str | None = None, **over) -> dict:
    base = {
        "ok": True,
        "terminal": True,
        "cancelRequested": False,
        "streamStatus": stream_status,
        "errorCode": code,
        "textLength": 42,
    }
    base.update(over)
    return base


# ── the happy path ──────────────────────────────────────────────────────────


async def test_a_completed_turn_succeeds_and_passes_the_scheduled_deadline():
    convex = FakeConvex(
        {"ok": True, "started": True, "streamId": "s1", "messageId": "m1"},
        [running(), terminal("done")],
    )
    res = await ChatExecutor(convex, settings()).execute(CTX)

    assert res.ok is True
    assert res.error_code is None
    # The 20-minute scheduled budget reached Convex, which writes it to
    # chatStreams.deadlineAt — the whole deadline chain in one argument.
    assert convex.start_calls[0]["deadline_ms"] == 1_200_000
    assert convex.start_calls[0]["lease_token"] == "lease-a"


async def test_a_resumed_turn_is_polled_rather_than_restarted():
    # What a DBOS-recovered workflow sees: Convex reports the turn already runs.
    convex = FakeConvex(
        {"ok": True, "resumed": True, "streamId": "s1", "messageId": "m1"},
        [terminal("done")],
    )
    res = await ChatExecutor(convex, settings()).execute(CTX)
    assert res.ok is True
    assert len(convex.start_calls) == 1
    assert convex.status_calls == 1


# ── failure classification, over the REAL error-code vocabulary ─────────────


@pytest.mark.parametrize(
    "code",
    [
        "dispatch_unreachable",
        "dispatch_failed",
        "ingress_unavailable",
        "provider_error",
        "provider_timeout",
        "timeout",
        "internal",
    ],
)
async def test_transient_failures_are_retryable(code: str):
    convex = FakeConvex(
        {"ok": True, "started": True}, [terminal("error", code)]
    )
    res = await ChatExecutor(convex, settings()).execute(CTX)
    assert res.ok is False
    assert res.error_code == code
    assert res.retryable is True


@pytest.mark.parametrize(
    "code",
    [
        # Retrying a 20-minute deadline burns three more 20-minute runs for an
        # almost certainly identical outcome.
        "deadline",
        "deadline_exceeded",
        "not_configured",
        "attachment_failed",
        "approval_expired",
        "approval_required_for_unattended_execution",
    ],
)
async def test_permanent_failures_are_not_retried(code: str):
    convex = FakeConvex(
        {"ok": True, "started": True}, [terminal("error", code)]
    )
    res = await ChatExecutor(convex, settings()).execute(CTX)
    assert res.ok is False
    assert res.error_code == code
    assert res.retryable is False


async def test_an_unknown_error_code_defaults_to_permanent():
    # Conservative on purpose: an unknown code retried three times costs three
    # real generations, while an unknown code failed once is merely reported.
    convex = FakeConvex(
        {"ok": True, "started": True}, [terminal("error", "some_new_code")]
    )
    res = await ChatExecutor(convex, settings()).execute(CTX)
    assert res.retryable is False


async def test_an_aborted_stream_is_cancelled_not_failed():
    convex = FakeConvex({"ok": True, "started": True}, [terminal("aborted")])
    res = await ChatExecutor(convex, settings()).execute(CTX)
    assert res.ok is False
    assert res.error_code == "cancelled"
    assert res.retryable is False


# ── start-time failures ─────────────────────────────────────────────────────


async def test_a_revoked_entitlement_never_polls_and_never_retries():
    convex = FakeConvex(
        {"ok": False, "entitlement": "owner_not_member", "cancel": True}, []
    )
    res = await ChatExecutor(convex, settings()).execute(CTX)
    assert res.ok is False
    assert res.error_code == "owner_not_member"
    assert res.retryable is False
    assert convex.status_calls == 0


async def test_a_stale_lease_stops_without_writing_anything():
    convex = FakeConvex({"ok": False, "stale": True, "cancel": True}, [])
    res = await ChatExecutor(convex, settings()).execute(CTX)
    assert res.error_code == "stale"
    assert res.retryable is False
    assert convex.status_calls == 0


async def test_a_busy_thread_is_transient():
    convex = FakeConvex({"ok": False, "busy": True}, [])
    res = await ChatExecutor(convex, settings()).execute(CTX)
    assert res.error_code == "thread_busy"
    assert res.retryable is True


async def test_a_missing_revision_is_permanent():
    convex = FakeConvex(
        {"ok": False, "invalidReason": "revision_missing", "cancel": True}, []
    )
    res = await ChatExecutor(convex, settings()).execute(CTX)
    assert res.error_code == "revision_missing"
    assert res.retryable is False


async def test_a_lease_lost_mid_poll_abandons_the_turn():
    convex = FakeConvex(
        {"ok": True, "started": True},
        [running(), {"ok": False, "stale": True}],
    )
    res = await ChatExecutor(convex, settings()).execute(CTX)
    assert res.error_code == "stale"
    assert res.retryable is False


async def test_a_vanished_stream_is_transient():
    convex = FakeConvex(
        {"ok": True, "started": True}, [{"ok": True, "missing": True}]
    )
    res = await ChatExecutor(convex, settings()).execute(CTX)
    assert res.error_code == "stream_missing"
    assert res.retryable is True


# ── cancellation ────────────────────────────────────────────────────────────


async def test_a_cancel_seen_while_polling_stops_the_running_turn():
    convex = FakeConvex(
        {"ok": True, "started": True},
        [running(), running(cancelRequested=True)],
    )
    res = await ChatExecutor(convex, settings()).execute(CTX)
    assert res.error_code == "cancelled"
    assert res.retryable is False
    # The generation was actually told to stop, not just abandoned.
    assert convex.cancel_calls == 1


async def test_being_cancelled_mid_poll_still_stops_the_generation():
    """run.py cancels the work task when the heartbeat reports a stop.

    The executor cannot await during its own cancellation, so the request is
    detached — but it must still land, or the model keeps burning tokens on a
    run nobody will read.
    """
    convex = FakeConvex({"ok": True, "started": True}, [])  # polls forever
    ex = ChatExecutor(convex, settings())
    task = asyncio.create_task(ex.execute(CTX))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    # Let the detached cancel request run.
    await asyncio.sleep(0.05)
    assert convex.cancel_calls == 1


async def test_a_cancel_request_failure_never_masks_the_outcome():
    class Broken(FakeConvex):
        async def sched_cancel_run(self, **kw):
            raise RuntimeError("convex down")

    convex = Broken(
        {"ok": True, "started": True},
        [running(cancelRequested=True)],
    )
    res = await ChatExecutor(convex, settings()).execute(CTX)
    assert res.error_code == "cancelled"


# ── executor selection ──────────────────────────────────────────────────────


def test_build_executor_selects_and_fails_loudly():
    convex = FakeConvex({}, [])
    assert isinstance(build_executor(settings(), convex), ChatExecutor)
    assert isinstance(
        build_executor(settings(scheduler_executor="noop")), NoopExecutor
    )
    with pytest.raises(ValueError, match="unknown scheduler executor"):
        build_executor(settings(scheduler_executor="teleport"), convex)
    # The chat executor cannot be built without a client — a misconfiguration
    # must surface at startup, not when a task fires at 3am.
    with pytest.raises(ValueError, match="requires a Convex client"):
        build_executor(settings())
