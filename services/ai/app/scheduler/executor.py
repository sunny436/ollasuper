"""The seam Phase 2 plugs the real AI execution into.

`ChatExecutor` contains no AI logic at all. It asks Convex to create a chat
turn — which routes through `startAssistantTurn`, the same function `send`,
`regenerate`, `retry` and `editUserMessage` use — and then waits. The LangGraph
runner, the orchestrator, skills, tool policy, the Ollagraph adapter, artifacts,
the typed event log and crash-resume are all inherited from the existing
production path. There is deliberately no second runtime anywhere in this file.

Nothing here talks to a model, and nothing here owns the occurrence lifecycle:
lease, heartbeat, cancellation and finalize belong to run.py, so an executor
only answers "did the work succeed, and is a failure worth retrying?".
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Protocol

from app.config import Settings
from app.logging import get_logger

log = get_logger(__name__)


@dataclass(frozen=True)
class OccurrenceContext:
    """Everything an executor is told about the occurrence it is running.

    `revision` is the revision the occurrence was CREATED under, not the task's
    current one — editing a task must never rewrite what an already-created
    occurrence meant. Convex resolves the prompt from that pinned revision.
    """

    occurrence_key: str
    task_id: str
    revision: int
    scheduled_for: int
    kind: str
    attempts: int
    # The holder token. Every Convex call an executor makes is lease-guarded, so
    # a stale worker cannot advance an occurrence someone else now owns.
    lease_token: str = ""


@dataclass(frozen=True)
class ExecutionResult:
    ok: bool
    error_code: str | None = None
    # Only a TRANSIENT failure should be retried. A retry is another dispatch
    # attempt of the SAME occurrence — never a new occurrence.
    retryable: bool = False
    detail: str | None = None


class OccurrenceExecutor(Protocol):
    async def execute(self, ctx: OccurrenceContext) -> ExecutionResult: ...


class NoopExecutor:
    """Lifecycle-only executor. Retained from Phase 1 for hermetic tests.

    It exercises the entire durable path — materialise, claim, lease, verify,
    heartbeat, finalize, retry, reap, cancel — while invoking no AI and spending
    no tokens.
    """

    name = "noop"

    async def execute(self, ctx: OccurrenceContext) -> ExecutionResult:
        log.info(
            "sched.noop_execute",
            extra={
                "occurrence_key": ctx.occurrence_key,
                "task_id": ctx.task_id,
                "revision": ctx.revision,
                "attempt": ctx.attempts + 1,
                "kind": ctx.kind,
            },
        )
        return ExecutionResult(ok=True, detail="noop")


# Failure classification built from the ACTUAL error-code vocabulary in this
# codebase, not invented names:
#   Convex  chat/*.ts  approval_expired, cancelled, deadline, dispatch_failed,
#                      dispatch_unreachable, not_configured, timeout
#   Python  runner.py  attachment_failed, deadline_exceeded, ingress_unavailable,
#                      internal, provider_error, provider_timeout
#
# Anything NOT listed here is treated as PERMANENT. That direction is
# deliberate: an unknown code retried three times costs three real generations,
# whereas an unknown code failed once is merely reported.
#
# Notably absent, and permanent on purpose:
#   deadline / deadline_exceeded — retrying a 20-minute deadline burns three
#     more 20-minute runs for an almost certainly identical outcome.
#   not_configured, attachment_failed, approval_expired — no retry can fix them.
#   approval_required_for_unattended_execution — no retry produces a human.
_TRANSIENT_ERRORS = frozenset(
    {
        "dispatch_unreachable",
        "dispatch_failed",
        "ingress_unavailable",
        "provider_error",
        "provider_timeout",
        "timeout",
        "internal",
        "stream_missing",
        "thread_busy",
    }
)

ERR_APPROVAL_REQUIRED = "approval_required_for_unattended_execution"


class ChatExecutor:
    """Run one scheduled occurrence as a real OllaSuper AI turn.

    Waiting is a POLL rather than a callback, on purpose: a poll is restart-safe
    (a DBOS-recovered workflow simply resumes polling an already-running turn)
    and needs no inbound HTTP surface on the scheduler process.
    """

    name = "chat"

    def __init__(self, client: Any, settings: Settings) -> None:
        self._client = client
        self._s = settings

    async def execute(self, ctx: OccurrenceContext) -> ExecutionResult:
        started = await self._client.sched_start_run(
            occurrence_key=ctx.occurrence_key,
            lease_token=ctx.lease_token,
            deadline_ms=self._s.scheduler_turn_deadline_ms,
        )
        if not started.get("ok"):
            return self._classify_start_failure(started)
        if started.get("cancel"):
            return ExecutionResult(ok=False, error_code="cancelled")

        log.info(
            "sched.turn_started",
            extra={
                "occurrence_key": ctx.occurrence_key,
                "task_id": ctx.task_id,
                "revision": ctx.revision,
                "attempt": ctx.attempts + 1,
                "mode": self._mode(started),
                "stream_id": started.get("streamId"),
                "message_id": started.get("messageId"),
            },
        )

        try:
            return await self._await_turn(ctx)
        except asyncio.CancelledError:
            # Being torn down: the occurrence was cancelled, or the process is
            # stopping. Detached rather than awaited, because a cancelled
            # coroutine cannot await — so the running generation is still told
            # to stop instead of burning tokens to completion.
            asyncio.ensure_future(self._quiet_cancel(ctx))  # noqa: RUF006
            raise

    @staticmethod
    def _mode(started: dict) -> str:
        if started.get("resumed"):
            return "resumed"
        if started.get("retried"):
            return "retried"
        return "started"

    async def _await_turn(self, ctx: OccurrenceContext) -> ExecutionResult:
        while True:
            await asyncio.sleep(self._s.scheduler_poll_interval_s)
            status = await self._client.sched_run_status(
                occurrence_key=ctx.occurrence_key,
                lease_token=ctx.lease_token,
            )
            if not status.get("ok"):
                # Lease rotated, or the occurrence is already terminal: someone
                # else owns this now. Stop without writing anything.
                return ExecutionResult(ok=False, error_code="stale")
            if status.get("missing"):
                return ExecutionResult(
                    ok=False, error_code="stream_missing", retryable=True
                )
            if status.get("cancelRequested") and not status.get("terminal"):
                # Detected here as well as via run.py's heartbeat, so a cancel
                # still lands promptly even with a long heartbeat interval.
                await self._quiet_cancel(ctx)
                return ExecutionResult(ok=False, error_code="cancelled")
            if status.get("terminal"):
                return self._classify_terminal(ctx, status)

    def _classify_start_failure(self, started: dict) -> ExecutionResult:
        if started.get("entitlement"):
            # The owner lost access between claim and start. Never retried —
            # Phase 1's claim cancels the task's remaining work.
            return ExecutionResult(ok=False, error_code=str(started["entitlement"]))
        if started.get("invalidReason"):
            return ExecutionResult(ok=False, error_code=str(started["invalidReason"]))
        if started.get("busy"):
            return ExecutionResult(ok=False, error_code="thread_busy", retryable=True)
        return ExecutionResult(ok=False, error_code="stale")

    def _classify_terminal(
        self, ctx: OccurrenceContext, status: dict
    ) -> ExecutionResult:
        stream_status = str(status.get("streamStatus") or "")
        raw = status.get("errorCode")
        code = str(raw) if raw else None

        if stream_status == "done":
            chars = status.get("textLength", 0)
            return ExecutionResult(ok=True, detail=f"chars={chars}")
        if stream_status == "aborted" or code == "cancelled":
            return ExecutionResult(ok=False, error_code="cancelled")

        retryable = code in _TRANSIENT_ERRORS if code else True
        log.info(
            "sched.turn_failed",
            extra={
                "occurrence_key": ctx.occurrence_key,
                "stream_status": stream_status,
                "error_code": code,
                "retryable": retryable,
            },
        )
        detail = str(status.get("error") or "")[:300]
        return ExecutionResult(
            ok=False,
            error_code=code or "generation_failed",
            retryable=retryable,
            detail=detail or None,
        )

    async def _quiet_cancel(self, ctx: OccurrenceContext) -> None:
        """Best effort: a cancel failure must never mask the real outcome."""
        try:
            await self._client.sched_cancel_run(
                occurrence_key=ctx.occurrence_key,
                lease_token=ctx.lease_token,
            )
        except Exception as e:  # noqa: BLE001 — best effort by definition
            log.warning(
                "sched.cancel_request_failed",
                extra={
                    "occurrence_key": ctx.occurrence_key,
                    "error": type(e).__name__,
                },
            )


def build_executor(settings: Settings, client: Any = None) -> OccurrenceExecutor:
    """Select the executor.

    Fails loudly on an unknown name rather than silently running the wrong
    thing: an operator who mistypes this must find out at startup, not when a
    task fires at 3am.
    """
    name = (settings.scheduler_executor or "chat").strip().lower()
    if name == "noop":
        return NoopExecutor()
    if name == "chat":
        if client is None:
            raise ValueError("the chat executor requires a Convex client")
        return ChatExecutor(client, settings)
    raise ValueError(f"unknown scheduler executor: {name!r}")
