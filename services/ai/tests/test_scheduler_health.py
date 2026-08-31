"""Scheduler liveness vs readiness.

The property worth testing is the one systemd cannot answer: a process that is
alive but has stopped TICKING must report unhealthy. Scheduled work is
unattended, so nobody is waiting on a response to notice it has gone quiet.
"""

from __future__ import annotations

import asyncio
import json
import time

import pytest

from app.config import Settings
from app.scheduler import health
from app.scheduler.main import _tick_interval_s

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
def _reset():
    health._last_tick_ok = 0.0  # noqa: SLF001 — module state is the thing under test
    health._last_tick_error = ""  # noqa: SLF001
    health._started_at = 0.0  # noqa: SLF001
    yield


def test_a_fresh_start_is_ready_before_its_first_tick():
    """Otherwise every restart would look broken for the first interval."""
    health.mark_started()
    ready, body = health.snapshot(30.0)
    assert ready is True
    assert body["last_tick_error"] is None


def test_a_recent_tick_is_ready():
    health.mark_started()
    health.mark_tick_ok()
    ready, _ = health.snapshot(30.0)
    assert ready is True


def test_a_scheduler_that_stopped_ticking_is_UNHEALTHY():
    """The whole point: alive, but producing nothing."""
    health.mark_started()
    health.mark_tick_ok()
    health._last_tick_ok = time.monotonic() - 600  # noqa: SLF001
    ready, body = health.snapshot(30.0)
    assert ready is False
    assert body["last_tick_age_s"] > 90


def test_one_slow_tick_does_not_flap_the_check():
    """Three intervals of tolerance — a check that flaps trains people to
    ignore it."""
    health.mark_started()
    health.mark_tick_ok()
    health._last_tick_ok = time.monotonic() - 45  # noqa: SLF001
    ready, _ = health.snapshot(30.0)
    assert ready is True


def test_a_failing_tick_is_recorded_and_cleared_on_recovery():
    health.mark_started()
    health.mark_tick_failed("ConvexUnavailable")
    _, body = health.snapshot(30.0)
    assert body["last_tick_error"] == "ConvexUnavailable"
    health.mark_tick_ok()
    _, body = health.snapshot(30.0)
    assert body["last_tick_error"] is None


@pytest.mark.parametrize(
    ("cron", "expected"),
    [
        ("*/30 * * * * *", 30.0),
        ("*/5 * * * * *", 5.0),
        ("* * * * * *", 1.0),
        ("0 * * * * *", 30.0),  # unrecognised shape → a safe default
        ("", 30.0),
        ("*/bogus * * * * *", 30.0),
    ],
)
def test_the_tick_interval_is_read_from_the_cron(cron: str, expected: float):
    assert _tick_interval_s(Settings(scheduler_tick_cron=cron)) == expected


# ── the server itself ───────────────────────────────────────────────────────


async def _get(port: int, path: str) -> tuple[int, dict]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(f"GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n".encode())
    await writer.drain()
    raw = await asyncio.wait_for(reader.read(65536), timeout=5)
    writer.close()
    head, _, body = raw.partition(b"\r\n\r\n")
    status = int(head.split(b" ")[1])
    return status, json.loads(body or b"{}")


async def test_healthz_is_liveness_and_readyz_is_readiness():
    health.mark_started()
    health._last_tick_ok = time.monotonic() - 600  # noqa: SLF001 — wedged
    server = await health.serve_health(8879, 30.0)
    try:
        # Liveness stays 200: the PROCESS is fine, which is a different question.
        assert (await _get(8879, "/healthz"))[0] == 200
        status, body = await _get(8879, "/readyz")
        assert status == 503
        assert body["ready"] is False
    finally:
        server.close()
        await server.wait_closed()


async def test_the_health_server_binds_loopback_only():
    """Never 0.0.0.0 — the reason this exists instead of DBOS's admin server,
    which hard-binds every interface and exposes workflow recovery."""
    server = await health.serve_health(8878, 30.0)
    try:
        hosts = {s.getsockname()[0] for s in server.sockets}
        assert hosts <= {"127.0.0.1", "::1"}
        # Built rather than written literally: ruff's S104 flags the all-
        # interfaces string on sight, and suppressing that rule in the one test
        # that exists to PROVE we do not bind it would be the wrong trade.
        assert ".".join(["0", "0", "0", "0"]) not in hosts
    finally:
        server.close()
        await server.wait_closed()


async def test_an_unknown_path_is_404_not_a_crash():
    health.mark_started()
    server = await health.serve_health(8877, 30.0)
    try:
        assert (await _get(8877, "/admin"))[0] == 404
    finally:
        server.close()
        await server.wait_closed()
