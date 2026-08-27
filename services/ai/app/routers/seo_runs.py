"""Phase 5 — the durable SEO-run worker endpoint (service-key auth via the router).

POST /v1/seo-run-step returns 202 immediately and runs ONE bounded dispatch window as a
background task on the DEDICATED seo_registry pool, so a large audit's crawling cannot
starve chat or uploads. `acquire(runId)` is the in-process duplicate-worker guard: a
false reap that re-dispatches a still-alive run gets a 409 (Convex treats it as benign),
so the same run never crawls twice on this pinned single worker. Dormant (503) when
`ai_seo_runs_enabled` is off — no run is ever dispatched, so it is byte-identical.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.logging import get_logger
from app.runtime.registry import Conflict, TooMany
from app.runtime.seo_run import (
    BatchResult,
    Crawler,
    Discoverer,
    SeoRunStep,
    run_seo_step,
)
from app.security import require_service_key

log = get_logger(__name__)

router = APIRouter(prefix="/v1", dependencies=[Depends(require_service_key)])


class SeoRunStepBody(BaseModel):
    """Mirrors the Convex `claimForDispatch` payload."""

    runId: str
    leaseToken: str
    userId: str
    target: str
    scope: str
    maxUrls: int
    costBudget: float
    costSpent: float
    deadlineAt: int
    workflowVersion: int
    createdAt: int
    checkpoint: str | None = None
    summary: str | None = None


async def _unwired_discoverer(target: str, scope: str, max_urls: int) -> list[str]:
    """The live-crawl seam. Post-phase-7 (deployed stack, Ollagraph reachable) this is
    replaced by the real crawl frontier discovery. Until then a dispatch discovers no
    URLs → the run finalizes with an empty report, exercising the full durability
    protocol without a live crawl (mirrors how Phase 4 shipped connectors before the
    real OAuth acceptance)."""
    return []


async def _unwired_crawler(urls: list[str], step: SeoRunStep) -> BatchResult:
    return BatchResult()


def build_crawl_backend(app_state: object) -> tuple[Discoverer, Crawler]:
    """Build the (discoverer, crawler) for a dispatch. A wired Ollagraph backend
    replaces these post-phase-7; the default is the honest unwired seam above."""
    return _unwired_discoverer, _unwired_crawler


@router.post("/seo-run-step", status_code=202)
async def seo_run_step(body: SeoRunStepBody, request: Request) -> dict:
    app = request.app.state
    reg = getattr(app, "seo_registry", None)
    if reg is None:
        raise HTTPException(status_code=503, detail="seo runs not enabled")
    try:
        # runId is the dedupe key (a false reap's re-dispatch 409s); userId is the
        # pool's per-user key. Convex already caps runs per user — this bounds the
        # in-process crawl concurrency so it can't starve chat.
        reg.acquire(body.runId, body.userId)
    except Conflict as e:
        raise HTTPException(status_code=409, detail="run already dispatched") from e
    except TooMany as e:
        raise HTTPException(
            status_code=429,
            detail="too many concurrent seo runs",
            headers={"Retry-After": str(e.retry_after)},
        ) from e

    step = SeoRunStep(**body.model_dump())
    discoverer, crawler = build_crawl_backend(app)

    async def _run() -> None:
        try:
            await run_seo_step(
                step,
                convex=app.convex,
                settings=app.settings,
                discoverer=discoverer,
                crawler=crawler,
            )
        finally:
            # Outer finally — release runs on every path (success, exception, deadline
            # cancel, crash) so a re-dispatch never 409s forever. NOT inside a shield.
            reg.release(body.runId)

    task = asyncio.create_task(_run(), name=f"seo-run:{body.runId}")
    reg.attach(body.runId, task)
    log.info("seo_run_accepted", extra={"run": body.runId})
    return {"runId": body.runId, "accepted": True}
