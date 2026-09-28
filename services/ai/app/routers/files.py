"""File Knowledge System ingestion endpoints (service-key auth via the router).

POST /v1/ingest returns 202 immediately and runs the pipeline as a background
task on a SEPARATE registry pool so a burst of uploads cannot starve chat
generations. DELETE /v1/ingest/{id} reclaims the Postgres rows (FK cascade).
"""

from __future__ import annotations

import asyncio
import hashlib
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from app.db import store
from app.ingest.pipeline import PROCESSING_VERSIONS, delete_ingest, run_ingest
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
    if getattr(app, "index_dim_ok", True) is False:
        # The configured embedding dimension is not the column's: every vector
        # would fail to write. Refuse loudly (Convex retries with backoff) rather
        # than fail files one by one.
        raise HTTPException(
            status_code=503, detail="knowledge index dimension mismatch"
        )
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
                expected_sha256=req.sha256,
                generation=req.generation,
                reindex=bool(req.reindex),
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


@router.get("/files/ingest/{ingest_id}/original")
async def original(ingest_id: str, request: Request) -> Response:
    """The knowledge DB's copy of a file's bytes — the source for restoring a
    missing Convex original (libraryMigrations.restoreOriginals), and nothing
    else. Service-key only (router dependency). The sha256 header is computed
    from the bytes being returned, so the caller verifies what it received,
    not what a row claims."""
    app = request.app.state
    if getattr(app, "db", None) is None:
        raise HTTPException(status_code=503, detail="knowledge db not configured")
    raw = await store.get_original(app.db, file_id=ingest_id)
    if raw is None:
        raise HTTPException(status_code=404, detail="no copy")
    return Response(
        content=raw,
        media_type="application/octet-stream",
        headers={"x-content-sha256": hashlib.sha256(raw).hexdigest()},
    )


# Bounded wait for a cancelled in-process ingestion to unwind. Correctness does
# not depend on it — the durable tombstone already fences persistence.
_CANCEL_WAIT_S = 5.0


@router.delete("/ingest/{ingest_id}")
async def purge(
    ingest_id: str,
    request: Request,
    storage: Annotated[str | None, Query(max_length=200)] = None,
) -> dict:
    app = request.app.state
    # In-memory copies of the file go first and unconditionally: they are
    # this process's own, whatever the database's state.
    if storage:
        from app.data.loader import evict_storage

        evict_storage(storage)
    if getattr(app, "db", None) is None:
        # NOT a success: nothing was deleted. It used to answer ok here, which
        # told Convex the purge was done while the rows stayed (the purge
        # retries for a week, then the daily reconcile takes over).
        raise HTTPException(status_code=503, detail="knowledge db not configured")
    # Tombstone + delete FIRST, in one transaction under the per-file lock
    # (store.delete_by_id): from here on no worker — this one, a retry, or one
    # started after a restart — can commit this file again (audit F-13).
    deleted = await delete_ingest(ingest_id, app.db)
    # Then stop the in-process run so it spends nothing more on a deleted file.
    task = app.ingest_registry.task(ingest_id)
    if task is not None and not task.done():
        task.cancel()
        await asyncio.wait({task}, timeout=_CANCEL_WAIT_S)
    return {"ok": True, "deleted": deleted}


# ---------------------------------------------------------------- index upkeep
# Service-key only (router dependency), called by Convex crons and migrations.


def _db(request: Request):
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="knowledge db not configured")
    return db


@router.get("/ingest/stale")
async def stale(request: Request, limit: int = Query(default=50, ge=1, le=500)) -> dict:
    """Ingests whose chunks another embedding model or an older pipeline made
    (libraryProcessing.reindexStale re-indexes them, keeping them ready)."""
    settings = request.app.state.settings
    ids = await store.stale_files(
        _db(request),
        embedding_model=settings.openrouter_embedding_model,
        versions=PROCESSING_VERSIONS,
        limit=limit,
    )
    return {
        "ids": ids,
        "current": {
            "embeddingModel": settings.openrouter_embedding_model,
            "versions": PROCESSING_VERSIONS,
        },
    }


@router.get("/ingest/known")
async def known(
    request: Request,
    after: str = Query(default="", max_length=200),
    limit: int = Query(default=500, ge=1, le=1000),
) -> dict:
    """Every file id held here, paged (libraryProcessing.reconcileKnowledge)."""
    ids = await store.known_ids(_db(request), after=after, limit=limit)
    return {"ids": ids, "next": ids[-1] if len(ids) == limit else None}


@router.get("/ingest/copies")
async def copies(
    request: Request,
    after: str = Query(default="", max_length=200),
    limit: int = Query(default=200, ge=1, le=1000),
) -> dict:
    """BYTEA copies still held (migration remnants), with their hashes, so
    Convex can verify its own original before asking for one to go."""
    rows = await store.original_copies(_db(request), after=after, limit=limit)
    return {
        "copies": [{"id": fid, "sha256": h} for fid, h in rows],
        "next": rows[-1][0] if len(rows) == limit else None,
    }


@router.delete("/ingest/{ingest_id}/copy")
async def delete_copy(ingest_id: str, request: Request) -> dict:
    """Drop ONE file's BYTEA copy (its chunks and embeddings stay)."""
    deleted = await store.delete_original_copy(_db(request), file_id=ingest_id)
    return {"ok": True, "deleted": deleted}
