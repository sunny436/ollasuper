"""Generation endpoints. Service-key auth only — never browser-facing."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from langchain_core.messages import HumanMessage, SystemMessage

from app.agent.llm import build_llm
from app.logging import get_logger
from app.models.chat import (
    CancelResult,
    GenerateAccepted,
    GenerateRequest,
    TitleRequest,
    TitleResponse,
)
from app.runtime.capabilities import capability_catalog
from app.runtime.registry import Conflict, TooMany
from app.runtime.runner import run_generation
from app.security import require_service_key
from app.skills.capability_binding import user_capability_catalog

log = get_logger(__name__)

router = APIRouter(prefix="/v1", dependencies=[Depends(require_service_key)])


@router.post("/generate", response_model=GenerateAccepted, status_code=202)
async def generate(req: GenerateRequest, request: Request) -> GenerateAccepted:
    """Accept a turn and return immediately.

    Returns 202 before any model work starts. Convex's dispatch action treats
    any non-2xx as terminal, so blocking here would couple the whole
    generation's lifetime to one Convex action's timeout.
    """
    app = request.app.state
    try:
        app.registry.acquire(req.messageId, req.userId)
    except Conflict as e:
        raise HTTPException(status_code=409, detail="already generating") from e
    except TooMany as e:
        raise HTTPException(
            status_code=429,
            detail="too many concurrent generations",
            headers={"Retry-After": str(e.retry_after)},
        ) from e

    async def _run() -> None:
        try:
            await run_generation(
                req,
                app.settings,
                app.convex,
                engine=getattr(app, "db", None),
                tool_registry=getattr(app, "tool_registry", None),
                tool_selector=getattr(app, "tool_selector", None),
                ollagraph_http=getattr(app, "ollagraph_http", None),
                # Phase 5: the MCP session pool. None when connections are
                # off, which makes the turn byte-identical to Phase 4.
                mcp_pool=getattr(app, "mcp_pool", None),
            )
        finally:
            app.registry.release(req.messageId)

    task = asyncio.create_task(_run(), name=f"gen:{req.messageId}")
    app.registry.attach(req.messageId, task)

    log.info(
        "generation_accepted",
        extra={
            "stream_id": req.streamId,
            "message_id": req.messageId,
            "user_id": req.userId,
            "model": req.model,
            "history_len": len(req.history),
        },
    )
    return GenerateAccepted(messageId=req.messageId, model=req.model)


@router.post("/generate/{message_id}/cancel", response_model=CancelResult)
async def cancel(message_id: str, request: Request, response: Response) -> CancelResult:
    """Fast cancel path (sub-millisecond).

    A 404 here is not a failure: it means the generation already finished, or
    is running on a different worker. Either way the ingress cancel flag still
    stops it within one flush, so correctness never depends on this landing.
    """
    ok = request.app.state.registry.cancel(message_id)
    response.status_code = 202 if ok else 404
    return CancelResult(cancelled=ok, messageId=message_id)


@router.get("/generate/{message_id}")
async def status(message_id: str, request: Request) -> dict:
    return {
        "messageId": message_id,
        "running": request.app.state.registry.has(message_id),
        "active": request.app.state.registry.active,
    }


# Concise title from (first user message + first assistant output). Tiny, fast,
# a different (cheap) model than the chat model, and completely independent of
# /v1/generate: any failure returns an empty title and Convex keeps the existing
# one. Never streams; never touches the generation path.
TITLE_SYSTEM = (
    "Generate a concise 2-5 word title for this conversation from the first user "
    "message and first assistant response. Preserve product, technology, and entity "
    "names, and follow the conversation's language. No quotes, no markdown, no "
    "emojis, no explanation. Return ONLY the title."
)


@router.post("/title", response_model=TitleResponse)
async def title(req: TitleRequest, request: Request) -> TitleResponse:
    settings = request.app.state.settings
    try:
        llm = build_llm(
            settings,
            model=settings.ai_title_model,
            streaming=False,
            max_tokens=24,
        )
        msg = await llm.ainvoke(
            [
                SystemMessage(content=TITLE_SYSTEM),
                HumanMessage(
                    content=(
                        f"First user message:\n{req.firstUser}\n\n"
                        f"First assistant response:\n{req.firstAssistant}"
                    )
                ),
            ]
        )
        text = msg.content if isinstance(msg.content, str) else str(msg.content)
        return TitleResponse(title=text.strip())
    except Exception:
        log.exception("title generation failed")
        return TitleResponse(title="")


@router.get("/capabilities")
async def capabilities(request: Request) -> dict:
    """Which capabilities this deployment actually has.

    IDS ONLY. The Explore menu owns every label, description, icon and starter
    prompt — this says what exists here, not what to call it. Two sources of
    truth on the same user-facing string is how a menu drifts from its design.

    Read from the live settings, so turning a flag off removes the entry on the
    next request with nothing to invalidate. Cheap and pure: no model call, no
    I/O, and the caller (a Convex action) treats a failure as "show everything"
    rather than as an empty menu.
    """
    settings = request.app.state.settings
    return {"enabled": capability_catalog(settings)}


@router.get("/capabilities/skill")
async def skill_capabilities(request: Request) -> dict:
    """What a user may declare in a custom skill's `capabilities`.

    A DIFFERENT list from `/v1/capabilities` above, and the two must not be
    confused. That one is product surfaces ("seo", "blog") for the Explore menu.
    This one is capability INTENTS (`page.fetch`, `blog.serp_research`) — the
    stable naming layer over provider tool ids, and the only vocabulary a user
    skill is allowed to name.

    Without this the field was unreachable: the runtime consumed it from Phase 6
    but nothing told a user which values exist, so it could only be set by
    calling the API directly.

    Pure and cheap — no model call, no I/O, no registry mutation — and it
    reflects the live flags, so a capability this deployment does not have is
    never offered.
    """
    settings = request.app.state.settings
    return {"capabilities": user_capability_catalog(settings)}
