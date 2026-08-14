"""Liveness and readiness. Public — no secrets in either response."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request, Response

router = APIRouter()

_READY_CACHE_S = 10.0
_last_check: tuple[float, bool] = (0.0, False)


@router.get("/healthz")
async def healthz() -> dict:
    """Liveness: no I/O, always 200 if the process is up."""
    return {"ok": True}


@router.get("/readyz")
async def readyz(request: Request, response: Response) -> dict:
    global _last_check
    state = request.app.state
    configured = bool(state.settings.openrouter_api_key) and bool(
        state.settings.ai_service_key
    )

    now = time.monotonic()
    if now - _last_check[0] < _READY_CACHE_S:
        convex_ok = _last_check[1]
    else:
        convex_ok = await state.convex.healthy()
        _last_check = (now, convex_ok)

    ready = configured and convex_ok
    if not ready:
        response.status_code = 503
    return {
        "ready": ready,
        "configured": configured,
        "convex": convex_ok,
        "active": state.registry.active,
    }
