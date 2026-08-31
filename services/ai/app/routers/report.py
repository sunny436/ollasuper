"""Scheduled-report PDF rendering.

THIS ENDPOINT HAS NO WRITE PATH, and — as with the schedule parser — that is
structural rather than a rule someone has to remember. It imports no Convex
client, holds no ingress secret, reads nothing and stores nothing. Payload in,
PDF bytes out.

That is why there is no "occurrence-bound authentication" problem to solve here.
A holder of the service key can spend CPU and nothing else: it cannot reach
another user's result, cannot write an artifact into anyone's thread, and cannot
learn anything it did not already send. Every ownership decision — whose stream
the artifact belongs to, who may download it — stays in Convex, which is the
only place that knows.

There is deliberately NO model call. The PDF is a rendering of the answer the
run already produced, so what the user reads in the app and what lands in their
inbox are the same text.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from app.filegen.generate import FileGenError, render_and_validate
from app.filegen.spec import Section
from app.ingest.pool import run_in_pool
from app.logging import get_logger
from app.report.markdown_spec import MAX_MARKDOWN_CHARS, markdown_to_spec
from app.security import require_service_key

log = get_logger(__name__)

router = APIRouter(prefix="/v1/report", dependencies=[Depends(require_service_key)])

# One render at a time. myos-ai also carries every live chat stream, and a report
# render is the heaviest CPU thing in the process; letting several run at once
# would trade a background convenience against interactive latency.
_SEMAPHORE = asyncio.Semaphore(1)
RENDER_TIMEOUT_S = 60.0
POOL_WORKERS = 1


class ReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(default="", max_length=200)
    prompt: str = Field(default="", max_length=8_000)
    markdown: str = Field(default="", max_length=MAX_MARKDOWN_CHARS)
    truncated: bool = False
    timezone: str = Field(default="UTC", max_length=64)
    scheduledFor: int = 0
    startedAt: int | None = None
    finishedAt: int | None = None
    outcome: str = Field(default="succeeded", max_length=32)


def _fmt(ms: int | None, tz: str) -> str:
    """Render an instant in the TASK's zone, never the server's.

    A report that timestamps itself in UTC while the task runs at 9am Kolkata is
    quietly wrong in a way nobody notices until they act on it.
    """
    if not ms:
        return "—"
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
    return datetime.fromtimestamp(ms / 1000, tz=zone).strftime("%d %b %Y, %H:%M %Z")


def _cover(req: ReportRequest) -> Section:
    """Provenance, in the reader's terms.

    Carries what a reader needs to trust the document — what was asked, when it
    was meant to run, when it actually ran, and in which zone. Carries nothing
    internal: there is no field on ReportRequest for an occurrence key, a lease
    token, a workflow id or a storage id, so none can appear here.
    """
    rows = [
        ["Scheduled for", _fmt(req.scheduledFor, req.timezone)],
        ["Started", _fmt(req.startedAt, req.timezone)],
        ["Finished", _fmt(req.finishedAt, req.timezone)],
        ["Timezone", req.timezone],
        ["Status", req.outcome],
    ]
    if req.prompt.strip():
        rows.insert(0, ["Instruction", req.prompt.strip()[:500]])
    return Section(
        heading="Run details",
        level=2,
        table={"columns": ["", ""], "rows": rows},  # type: ignore[arg-type]
    )


@router.post("/pdf")
async def report_pdf(req: ReportRequest, request: Request) -> Response:
    """Render and return the bytes. Nothing is persisted on this side."""
    spec = markdown_to_spec(
        req.markdown,
        title=req.title or "Scheduled report",
        subtitle="OllaSuper scheduled report",
        truncated=req.truncated,
    )
    # Provenance first, then the answer.
    spec.sections = [_cover(req), *spec.sections]

    correlation_id = request.headers.get("x-correlation-id", "")
    async with _SEMAPHORE:
        try:
            result = await asyncio.wait_for(
                run_in_pool(
                    render_and_validate,
                    spec.model_dump(),
                    workers=POOL_WORKERS,
                    label="report:pdf",
                ),
                timeout=RENDER_TIMEOUT_S,
            )
        except TimeoutError:
            log.warning("report.pdf_timeout", extra={"cid": correlation_id})
            raise HTTPException(status_code=504, detail="render timed out") from None
        except FileGenError as e:
            log.warning(
                "report.pdf_invalid",
                extra={"cid": correlation_id, "error": type(e).__name__},
            )
            raise HTTPException(status_code=422, detail="render failed") from e

    # run_in_pool returns None when a pool worker crashed twice. Report it as a
    # failure rather than returning an empty body the caller would attach.
    if not result:
        log.warning("report.pdf_pool_failed", extra={"cid": correlation_id})
        raise HTTPException(status_code=500, detail="render unavailable")

    data, mime, _report = result
    log.info(
        "report.pdf_rendered",
        extra={
            "cid": correlation_id,
            "bytes": len(data),
            "sections": len(spec.sections),
        },
    )
    return Response(content=data, media_type=mime or "application/pdf")
