"""Model health — read the registry, and let an operator drain a model.

Service-key gated like the rest of `/v1`. Nothing here reaches a provider: the
snapshot is memory, and a quarantine only changes what the router may choose.
Recovery is never manual — the background probe restores a quarantined model
after the window, and only on a real successful request.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.agent import health
from app.security import require_service_key

router = APIRouter(prefix="/v1", dependencies=[Depends(require_service_key)])


class QuarantineRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seconds: int = Field(ge=30, le=3600)


@router.get("/models/health")
async def models_health() -> dict:
    return {"models": health.snapshot(), "worker": health.worker_status()}


@router.post("/models/health/{model}/quarantine")
async def quarantine_model(model: str, body: QuarantineRequest) -> dict:
    # Known models only: an arbitrary id must not grow the registry.
    if not health.quarantine(model, body.seconds):
        raise HTTPException(status_code=404, detail="Unknown model")
    entry = next((m for m in health.snapshot() if m["model"] == model), None)
    return {"ok": True, "model": entry}
