"""File Knowledge System ingestion endpoints (service-key auth via the router).

POST /v1/ingest returns 202 immediately and runs the pipeline as a background
task on a SEPARATE registry pool so a burst of uploads cannot starve chat
generations. DELETE /v1/ingest/{id} reclaims the Postgres rows (FK cascade).
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request

from app.ingest.pipeline import delete_ingest, run_ingest
from app.logging import get_logger
from app.models.chat import IngestAccepted, IngestRequest
from app.runtime.registry import Conflict, TooMany
from app.security import require_service_key

log = get_logger(__name__)

router = APIRouter(prefix="/v1", dependencies=[Depends(require_service_key)])


@router.post("/ingest", response_model=IngestAccepted, status_code=202)
async def ingest(req: IngestRequest, request: Request) -> IngestAccepted:
    app = request.app.state
    if getattr(app, "db", None) is None:
        raise HTTPException(status_code=503, detail="knowledge db not configured")
    try:
        app.ingest_registry.acquire(req.ingestId, req.userId)
    except Conflict as e:
        # A double dispatch. Convex treats 409 as a benign no-op.
        raise HTTPException(status_code=409, detail="already ingesting") from e
    except TooMany as e:
        raise HTTPException(
            status_code=429,
            detail="too many concurrent ingestions",
            headers={"Retry-After": str(e.retry_after)},
        ) from e

    async def _run() -> None:
        try:
            await run_ingest(
                ingest_id=req.ingestId,
                user_id=req.userId,
                workspace_id=req.workspaceId,
                name=req.name,
                content_type=req.contentType,
                engine=app.db,
                convex=app.convex,
                settings=app.settings,
            )
        finally:
            app.ingest_registry.release(req.ingestId)

    task = asyncio.create_task(_run(), name=f"ingest:{req.ingestId}")
    app.ingest_registry.attach(req.ingestId, task)
    log.info("ingest_accepted", extra={"file": req.ingestId})
    return IngestAccepted(ingestId=req.ingestId)


@router.delete("/ingest/{ingest_id}")
async def purge(ingest_id: str, request: Request) -> dict:
    app = request.app.state
    if getattr(app, "db", None) is None:
        return {"ok": True}
    deleted = await delete_ingest(ingest_id, app.db)
    return {"ok": True, "deleted": deleted}
