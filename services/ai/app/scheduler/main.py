"""The scheduler process: DBOS Transact, self-hosted, no cloud.

Runs as its OWN systemd unit rather than inside myos-ai.service. That unit is
pinned to `--workers 1` because its in-process cancel registry is chat-critical,
and a DBOS recovery storm or a Postgres stall must not share an event loop with
live chat streams.

WHY DBOS DRIVES ONLY A TICK, NOT ONE CRON PER TASK
--------------------------------------------------
DBOS can hold a cron schedule per task, with an IANA `cron_timezone`. It is
still the wrong shape here, because cron cannot express the locked product
rules: `0 9 31 * *` SILENTLY SKIPS FEBRUARY, and cron has no way to say "roll
forward off a nonexistent local time" or "fire once on an ambiguous one". So
DBOS runs exactly ONE schedule — a heartbeat — and app/scheduler/recurrence.py
computes the instants.

`automatic_backfill` is left OFF for the same reason. If it were on, a
three-day outage would replay ~8,600 tick workflows. Instead each task carries
its own `cursorAt`, so a SINGLE tick after recovery reconstructs every missed
occurrence — and each one is a separate durable row, never a coalesced
"catch-up".
"""

from __future__ import annotations

import asyncio
import os
import signal
from datetime import datetime
from importlib.metadata import version as metadata_version
from pathlib import Path
from typing import Any

from dbos import DBOS, DBOSConfig, SetEnqueueOptions, SetWorkflowID

from app.clients.convex import ConvexClient
from app.config import Settings, get_settings
from app.logging import configure, get_logger
from app.observability import init_sentry
from app.scheduler import health
from app.scheduler.executor import OccurrenceExecutor, build_executor
from app.scheduler.models import Claim
from app.scheduler.run import run_occurrence
from app.scheduler.tick import run_tick

log = get_logger(__name__)

APP_NAME = "myos-scheduler"
TICK_SCHEDULE_NAME = "myos-scheduler-tick"
TICK_QUEUE = "scheduler_tick"

# The version whose schema this deployment has been rehearsed against.
#
# DBOS runs run_migrations() against its system database on every launch, so the
# INSTALLED version decides the schema of a live production database — which is
# why pyproject.toml pins it exactly rather than by range. `uv sync --frozen`
# already guarantees the lock; this assertion catches the case the lock cannot,
# a hand-patched or partially synced venv, where an unattended restart would
# migrate production silently and irreversibly.
PINNED_DBOS = "2.31.0"


def _assert_dbos_version() -> None:
    installed = metadata_version("dbos")
    if installed == PINNED_DBOS:
        return
    if os.environ.get("SCHEDULER_ALLOW_DBOS_VERSION_DRIFT") == "1":
        log.warning(
            "sched.dbos_version_drift",
            extra={"installed": installed, "pinned": PINNED_DBOS},
        )
        return
    raise RuntimeError(
        f"dbos {installed} is installed but {PINNED_DBOS} is pinned. DBOS migrates "
        "its system database at launch, so refusing to start. Rehearse the "
        "migration against a restored copy of production, then move the pin in "
        "pyproject.toml and PINNED_DBOS together. "
        "SCHEDULER_ALLOW_DBOS_VERSION_DRIFT=1 overrides."
    )


# Set once, before DBOS.launch(). DBOS registers workflows by name at import
# time, so the collaborators they need cannot be constructor arguments.
_SETTINGS: Settings | None = None
_CLIENT: ConvexClient | None = None
_EXECUTOR: OccurrenceExecutor | None = None
# Lazily built on the first catalogue sync. The scheduler is a SEPARATE
# process from the API (myos-scheduler.service), so it owns its own pooled
# engine — it cannot borrow app.state.db, which lives in the API process.
_CATALOGUE_DB: Any = None


def _mcp_sync_cron() -> str:
    """Cron for the catalogue sync. Read at IMPORT time because DBOS
    registers a schedule at decoration; the workflow itself still re-checks
    `mcp_sync_enabled` at run time, so the feature can be turned off without
    a redeploy."""
    try:
        return get_settings().mcp_sync_cron
    except Exception:  # noqa: BLE001 — a bad env must not stop the scheduler
        return "0 * * * *"


def _settings() -> Settings:
    if _SETTINGS is None:
        raise RuntimeError("scheduler not initialised")
    return _SETTINGS


def _client() -> ConvexClient:
    if _CLIENT is None:
        raise RuntimeError("scheduler not initialised")
    return _CLIENT


# ── DBOS steps ───────────────────────────────────────────────────────────────
# Each Convex call is a checkpointed step, so a workflow recovered mid-flight
# resumes after the last completed one instead of repeating side effects.
# `retries_allowed` here handles TRANSIENT faults inside one dispatch attempt;
# it is a different mechanism from the occurrence's `attempts` counter, which
# counts dispatch attempts and is owned by Convex.

_STEP = dict(retries_allowed=True, max_attempts=3, backoff_rate=2.0)


@DBOS.step(**_STEP)
async def step_list(limit: int) -> dict[str, Any]:
    return await _client().sched_list(limit=limit)


@DBOS.step(**_STEP)
async def step_materialize(
    task_id: str,
    from_cursor: int,
    to_cursor: int,
    scheduled_for: list[int],
    next_run_at: int | None,
    invalid_reason: str | None,
    schedule_ended: bool,
) -> dict[str, Any]:
    return await _client().sched_materialize(
        task_id=task_id,
        from_cursor=from_cursor,
        to_cursor=to_cursor,
        scheduled_for=scheduled_for,
        next_run_at=next_run_at,
        invalid_reason=invalid_reason,
        schedule_ended=schedule_ended,
    )


@DBOS.step(**_STEP)
async def step_claim(limit: int, max_per_user: int) -> dict[str, Any]:
    return await _client().sched_claim(limit=limit, max_per_user=max_per_user)


@DBOS.step(**_STEP)
async def step_verify(
    occurrence_key: str, lease_token: str, workflow_id: str
) -> dict[str, Any]:
    return await _client().sched_verify(
        occurrence_key=occurrence_key,
        lease_token=lease_token,
        workflow_id=workflow_id,
    )


@DBOS.step(**_STEP)
async def step_finalize(
    occurrence_key: str,
    lease_token: str,
    outcome: str,
    error_code: str | None,
    retryable: bool,
) -> dict[str, Any]:
    return await _client().sched_finalize(
        occurrence_key=occurrence_key,
        lease_token=lease_token,
        outcome=outcome,
        error_code=error_code,
        retryable=retryable,
    )


class DurableOps:
    """Adapts the checkpointed steps to the plain Ops protocols.

    Heartbeats are deliberately NOT a DBOS step: they are pure liveness, they
    happen many times per run, and checkpointing each one would bloat the
    workflow's step log for no recovery benefit.
    """

    async def sched_list(self, *, limit: int) -> dict[str, Any]:
        return await step_list(limit)

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
        return await step_materialize(
            task_id,
            from_cursor,
            to_cursor,
            scheduled_for,
            next_run_at,
            invalid_reason,
            schedule_ended,
        )

    async def sched_claim(self, *, limit: int, max_per_user: int) -> dict[str, Any]:
        return await step_claim(limit, max_per_user)

    async def sched_verify(
        self, *, occurrence_key: str, lease_token: str, workflow_id: str
    ) -> dict[str, Any]:
        return await step_verify(occurrence_key, lease_token, workflow_id)

    async def sched_heartbeat(
        self, *, occurrence_key: str, lease_token: str
    ) -> dict[str, Any]:
        return await _client().sched_heartbeat(
            occurrence_key=occurrence_key, lease_token=lease_token
        )

    async def sched_finalize(
        self,
        *,
        occurrence_key: str,
        lease_token: str,
        outcome: str,
        error_code: str | None = None,
        retryable: bool = False,
    ) -> dict[str, Any]:
        return await step_finalize(
            occurrence_key, lease_token, outcome, error_code, retryable
        )


_OPS = DurableOps()


def occurrence_workflow_id(claim: Claim) -> str:
    """Deterministic, idempotent — and ATTEMPT-SCOPED, which is load-bearing.

    A workflow id is an idempotency key: enqueue it twice and DBOS runs it once.
    That is exactly what we want for a duplicate dispatch of the same attempt.

    But a RETRY is a new dispatch attempt of the SAME occurrence, and if the id
    were just `occ:<key>` the retry would collide with the completed first
    attempt and be silently dropped — the occurrence would sit in `retrying`
    forever. Including `attempts` keeps duplicates deduped while letting a
    genuine retry run.
    """
    return f"occ:{claim.occurrence_key}:{claim.attempts}"


# ── workflows ────────────────────────────────────────────────────────────────


@DBOS.workflow()
async def occurrence_workflow(claim_json: dict[str, Any]) -> str:
    claim = Claim.from_json(claim_json)
    return await run_occurrence(
        _OPS,
        _settings(),
        _EXECUTOR or build_executor(_settings(), _client()),
        claim,
        DBOS.workflow_id or occurrence_workflow_id(claim),
    )


async def _dispatch(claim: Claim) -> None:
    """Hand one claimed occurrence to the partitioned queue.

    `queue_partition_key=taskId` with `partition_concurrency=1` is DBOS's own
    per-key serialisation: one occurrence of a task at a time, while different
    tasks run concurrently. Convex's claim mutation is the authority for that
    invariant; this is defence in depth.

    NOTE: `deduplication_id` is NOT usable here — DBOS rejects deduplication on
    a partitioned queue. `SetWorkflowID` is the idempotency key instead, which
    is the stronger guarantee anyway.
    """
    with (
        SetWorkflowID(occurrence_workflow_id(claim)),
        SetEnqueueOptions(queue_partition_key=claim.task_id),
    ):
        await DBOS.enqueue_workflow_async(
            _settings().scheduler_queue_name,
            occurrence_workflow,
            {
                "occurrenceKey": claim.occurrence_key,
                "taskId": claim.task_id,
                "revision": claim.revision,
                "scheduledFor": claim.scheduled_for,
                "kind": claim.kind,
                "attempts": claim.attempts,
                "leaseToken": claim.lease_token,
            },
        )


@DBOS.workflow()
async def scheduler_tick(scheduled_time: datetime, _context: Any) -> dict[str, Any]:
    """One heartbeat of the scheduler.

    `scheduled_time` — not the wall clock — is the enumeration upper bound, so a
    replayed tick recomputes exactly the same window and materialises exactly
    the same instants.
    """
    now_ms = int(scheduled_time.timestamp() * 1000)
    try:
        report = await run_tick(_OPS, _settings(), now_ms, _dispatch)
    except Exception as e:
        # Readiness has to reflect a tick that FAILED, not merely one that ran.
        health.mark_tick_failed(type(e).__name__)
        raise
    health.mark_tick_ok()
    log.info(
        "sched.tick",
        # `occurrences`, NOT `created` — LogRecord owns that name and logging
        # raises rather than overwriting it. This line runs on EVERY tick, so
        # the collision would have thrown every 30 seconds in production while
        # staying invisible in any test run that never enabled INFO.
        extra={
            "at": now_ms,
            "tasks": report.tasks_seen,
            "occurrences": report.occurrences_created,
            "claimed": len(report.claims),
            "chunked": report.tasks_chunked,
            "invalid": report.tasks_invalid,
            "stale": report.tasks_stale,
        },
    )
    return {
        "tasks": report.tasks_seen,
        "created": report.occurrences_created,
        "claimed": len(report.claims),
    }


# ── process ──────────────────────────────────────────────────────────────────


def _tick_interval_s(settings: Settings) -> float:
    """Seconds between ticks, read from the 6-field cron (seconds come first).

    Only the common `*/N` and bare-`*` forms are recognised; anything else falls
    back to 30s. Readiness only needs the right ORDER of magnitude, and guessing
    wrong here must never make a healthy scheduler look sick.
    """
    field = (settings.scheduler_tick_cron or "").split(" ")[0]
    if field.startswith("*/"):
        try:
            return max(1.0, float(field[2:]))
        except ValueError:
            return 30.0
    if field == "*":
        return 1.0
    return 30.0


def build_dbos_config(settings: Settings) -> DBOSConfig:
    """Self-hosted only.

    `conductor_key` is deliberately never set: that is the one field that would
    connect this process to DBOS's cloud control plane, and the architecture
    forbids any cloud scheduling/execution service.
    """
    url = settings.scheduler_database_url.strip()
    if not url:
        # Development/test fallback. SQLite is supported by DBOS but is NOT the
        # production target: Postgres is, in a dedicated `myos_dbos` database.
        path = Path(os.getcwd()) / ".dbos-scheduler.sqlite"
        url = f"sqlite:///{path.as_posix()}"
    return {
        "name": APP_NAME,
        "system_database_url": url,
        # LISTEN/NOTIFY is a Postgres feature; SQLite must poll instead.
        "use_listen_notify": not url.startswith("sqlite"),
        "run_admin_server": False,
        "enable_otlp": False,
        "log_level": settings.ai_log_level,
    }


async def _serve() -> None:
    global _SETTINGS, _CLIENT, _EXECUTOR
    settings = get_settings()
    configure(settings.ai_log_level, settings.secrets())
    init_sentry(settings, component="myos-scheduler")

    if not settings.ai_scheduled_tasks_enabled:
        # Off by default: an unconfigured deployment registers no schedule and
        # no queue, and therefore cannot execute anything.
        log.info("sched.disabled")
        return

    _SETTINGS = settings
    _CLIENT = ConvexClient(settings, ConvexClient.build_http_client())
    # The chat executor drives Convex through the same shared client.
    _EXECUTOR = build_executor(settings, _CLIENT)


@DBOS.scheduled(_mcp_sync_cron())
@DBOS.workflow()
async def mcp_registry_sync(scheduled: datetime, actual: datetime) -> None:
    """Refresh the MCP server CATALOGUE from the official registry.

    DISCOVERY ONLY. This records what servers exist; it connects to nothing,
    installs nothing and grants no trust.

    Cron is the right shape HERE even though this module deliberately avoids it
    for user tasks: that objection is that cron cannot express product
    recurrence ("0 9 31 * *" silently skips February), and a registry refresh has
    no such semantics. `scheduled` is DBOS's replay-stable time, which is exactly
    what an idempotent sync wants — a recovered workflow re-runs with the same
    watermark rather than a drifted one.
    """
    settings = _SETTINGS or get_settings()
    if not settings.mcp_sync_enabled:
        return
    global _CATALOGUE_DB
    if _CATALOGUE_DB is None:
        from app.db.engine import create_knowledge_engine

        _CATALOGUE_DB = create_knowledge_engine(settings)

    from app.mcp.registry.client import RegistryClient
    from app.mcp.registry.store import PostgresSyncPort
    from app.mcp.registry.sync import sync_registry

    http = RegistryClient.build_http_client(settings.mcp_sync_timeout_s)
    try:
        client = RegistryClient(
            http,
            base_url=settings.mcp_registry_base_url,
            page_size=settings.mcp_sync_page_size,
            max_retries=settings.mcp_sync_max_retries,
        )
        # Never raises for an upstream failure: a registry outage must leave the
        # catalogue stale and searchable, not take the scheduler down with it.
        await sync_registry(PostgresSyncPort(_CATALOGUE_DB), client, now=scheduled)
    finally:
        await http.aclose()

    _assert_dbos_version()
    DBOS(config=build_dbos_config(settings))
    # launch() from INSIDE this running loop, so DBOS adopts it as the main
    # loop and every async workflow runs here — which is what makes the single
    # shared httpx.AsyncClient safe to reuse across workflows.
    DBOS.launch()

    # Queues must be registered AFTER launch.
    await DBOS.register_queue_async(
        settings.scheduler_queue_name,
        global_concurrency=settings.scheduler_global_concurrency,
        # Per-task serialisation. Never configurable: overlapping runs of one
        # task are a correctness bug, not a tuning choice.
        partition_concurrency=1,
    )
    # A tick queue of 1 keeps overlapping ticks from piling up under load.
    await DBOS.register_queue_async(TICK_QUEUE, global_concurrency=1)
    # apply_schedules_async, NOT create_schedule_async.
    #
    # create_schedule raises  on
    # the SECOND launch, because the row it writes lives in the DBOS system
    # database and outlives the process. That made the scheduler a
    # start-once service: it came up fine the first time and then crash-looped
    # on every restart, so any deploy or reboot silently ended scheduled
    # execution. Production hit exactly that — 51 restarts in a row.
    #
    # apply_schedules atomically creates OR REPLACES, which is what a service
    # that declares its own schedule at boot actually needs, and it also makes a
    # changed cron take effect instead of being ignored.
    await DBOS.apply_schedules_async(
        [
            {
                "schedule_name": TICK_SCHEDULE_NAME,
                "workflow_fn": scheduler_tick,
                "schedule": settings.scheduler_tick_cron,
                "queue_name": TICK_QUEUE,
                # OFF on purpose — see the module docstring. Per-task cursors do
                # the timeline reconstruction; replaying thousands of ticks
                # would not.
                "automatic_backfill": False,
            }
        ]
    )

    health.mark_started()
    health_server = await health.serve_health(
        settings.scheduler_health_port, _tick_interval_s(settings)
    )

    log.info(
        "sched.started",
        extra={
            "cron": settings.scheduler_tick_cron,
            "queue": settings.scheduler_queue_name,
            "global_concurrency": settings.scheduler_global_concurrency,
            "max_per_user": settings.scheduler_max_per_user,
            "executor": settings.scheduler_executor,
            "backend": "postgres"
            if settings.scheduler_database_url.strip()
            else "sqlite",
        },
    )

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            # Windows has no add_signal_handler; KeyboardInterrupt covers it.
            pass
    try:
        await stop.wait()
    finally:
        log.info("sched.stopping")
        health_server.close()
        DBOS.destroy()
        await _CLIENT._c.aclose()  # noqa: SLF001 — the client owns this socket
        log.info("sched.stopped")


def main() -> None:
    try:
        asyncio.run(_serve())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
