"""Liveness and readiness for the scheduler process.

WHY THIS IS NOT JUST /dbos-healthz. DBOS's own admin server answers "the process
is alive", which is the question systemd already answers. The one that matters
here is different: IS IT STILL TICKING? A scheduler whose tick workflow has
wedged, or whose Convex client is failing every call, stays `active (running)`
and answers healthz happily while producing nothing — and because scheduled work
is unattended, nobody is waiting on a response to notice. So readiness is tied
to the last SUCCESSFUL tick.

WHY NOT ENABLE DBOS'S ADMIN SERVER INSTEAD. It hard-binds 0.0.0.0 (its port is
configurable, its bind address is not) and exposes /dbos-workflow-recovery,
/dbos-garbage-collect, /dbos-global-timeout and /deactivate with no
authentication. That is a workflow control plane on every interface. This server
binds loopback only and is read-only.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from app.logging import get_logger

log = get_logger(__name__)

_last_tick_ok: float = 0.0
_last_tick_error: str = ""
_started_at: float = 0.0


def mark_started() -> None:
    global _started_at, _last_tick_ok
    _started_at = time.monotonic()
    # Count startup as a tick so a freshly started process is not reported
    # unhealthy for the first interval before its first tick lands.
    _last_tick_ok = _started_at


def mark_tick_ok() -> None:
    global _last_tick_ok, _last_tick_error
    _last_tick_ok = time.monotonic()
    _last_tick_error = ""


def mark_tick_failed(error: str) -> None:
    global _last_tick_error
    _last_tick_error = error


def snapshot(tick_interval_s: float) -> tuple[bool, dict[str, Any]]:
    """(ready, body). Ready iff a tick succeeded within 3 intervals.

    Three rather than one: a single slow or contended tick is normal operation,
    and a health check that flaps on it trains people to ignore it.
    """
    now = time.monotonic()
    age = now - _last_tick_ok if _last_tick_ok else None
    ready = age is not None and age < max(tick_interval_s * 3, 30.0)
    return ready, {
        "ready": ready,
        "uptime_s": round(now - _started_at, 1) if _started_at else 0,
        "last_tick_age_s": round(age, 1) if age is not None else None,
        "last_tick_error": _last_tick_error or None,
    }


async def serve_health(port: int, tick_interval_s: float) -> asyncio.AbstractServer:
    """A loopback-only, read-only health endpoint.

    Deliberately a hand-rolled asyncio server rather than another uvicorn: this
    needs two GET routes and no dependency on the web stack, and binding
    127.0.0.1 explicitly is the security-relevant part.
    """

    async def handle(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=2.0)
            parts = line.decode("latin-1", "replace").split(" ")
            path = parts[1] if len(parts) > 1 else "/"
            if path.startswith("/healthz"):
                status, body = 200, {"ok": True}
            elif path.startswith("/readyz"):
                ready, body = snapshot(tick_interval_s)
                status = 200 if ready else 503
            else:
                status, body = 404, {"error": "not found"}
            payload = json.dumps(body).encode()
            writer.write(
                b"HTTP/1.1 %d %s\r\nContent-Type: application/json\r\n"
                b"Content-Length: %d\r\nConnection: close\r\n\r\n%s"
                % (
                    status,
                    b"OK" if status == 200 else b"ERR",
                    len(payload),
                    payload,
                )
            )
            await writer.drain()
        except Exception as e:  # noqa: BLE001 — must never kill the event loop
            # Debug, not warning: a probe that hangs up mid-response is normal
            # (curl ^C, a load balancer timing out) and must not create noise
            # that trains people to ignore this log.
            log.debug("sched.health_probe_failed", extra={"error": type(e).__name__})
        finally:
            writer.close()

    # 127.0.0.1, never 0.0.0.0. Nothing outside the box needs this.
    server = await asyncio.start_server(handle, "127.0.0.1", port)
    log.info("sched.health_listening", extra={"port": port})
    return server
