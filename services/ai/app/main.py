"""FastAPI application for the myos AI inference plane.

Binds loopback by default (see config.ai_bind_host) and exposes NO
browser-facing surface: Convex is the streaming substrate, so the browser never
talks to this service. That removes CORS, JWT verification and per-user
authorization from the chat path entirely — and a permissive
Access-Control-Allow-Origin on a service-key endpoint would be pure downside,
so no CORS middleware is mounted at all.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.requests import Request

from app.clients.convex import ConvexClient
from app.clients.ollagraph import OllagraphAdapter
from app.config import Settings, get_settings
from app.db.engine import create_knowledge_engine
from app.logging import configure, get_logger
from app.routers import files, generate, health, tools
from app.runtime.registry import Registry
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector

log = get_logger(__name__)


async def _discover_tools_best_effort(app: FastAPI, settings: Settings) -> None:
    """Populate the Tool Registry from Ollagraph's PUBLIC OpenAPI spec.

    Best-effort and fully isolated: any failure (unreachable spec, malformed
    JSON, parse error) is swallowed and leaves the registry empty. Chat, RAG,
    Ollima, uploads and streaming never depend on or await this. Nothing here
    is connected to the LLM. Runs its own httpx client and closes it.
    """
    reg = getattr(app.state, "tool_registry", None)
    if reg is None:
        return
    client = OllagraphAdapter.build_http_client()
    try:
        result = await OllagraphAdapter(settings, client).discover()
        reg.replace_all(result.definitions, result.components, result.report)
        log.info(
            "tool.discovery_complete",
            extra={
                "registered": result.report.get("registered"),
                "paths": result.report.get("paths"),
                "operations": result.report.get("operations_seen"),
            },
        )
    except Exception as e:  # noqa: BLE001 — never break startup/chat
        log.warning("tool.discovery_failed", extra={"error": type(e).__name__})
    finally:
        await client.aclose()


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure(settings.ai_log_level, settings.secrets())

    http = ConvexClient.build_http_client()
    app.state.settings = settings
    app.state.http = http
    app.state.convex = ConvexClient(settings, http)
    app.state.registry = Registry(
        max_per_user=settings.ai_max_concurrent_per_user,
        max_global=settings.ai_max_concurrent_global,
    )
    # File ingestion runs on its OWN registry pool so a burst of uploads can't
    # starve chat generations.
    app.state.ingest_registry = Registry(
        max_per_user=settings.ai_ingest_max_concurrent_per_user,
        max_global=settings.ai_ingest_max_concurrent_global,
    )
    # Knowledge DB (pgvector). None when unconfigured — RAG then degrades to off
    # and /v1/ingest returns 503, but chat is unaffected.
    app.state.db = (
        create_knowledge_engine(settings) if settings.rag_enabled else None
    )
    # Tool Registry (Ollagraph). None when unconfigured — the introspection
    # route then 503s, but chat is unaffected. It is a CATALOGUE only: never
    # wired to the LLM/graph, and discovery below is best-effort.
    app.state.tool_registry = (
        ToolRegistry() if settings.ollagraph_enabled else None
    )
    # Shared Ollagraph http client + a cached ToolSelector, used by the agent
    # (Phase 4) to EXECUTE discovered tools. None when unconfigured -> the
    # generation path binds no tools and is byte-identical to before. The
    # selector's search index self-caches by registry.version, so the same
    # instance is reused by the introspection route.
    app.state.ollagraph_http = (
        OllagraphAdapter.build_http_client() if settings.ollagraph_enabled else None
    )
    app.state.tool_selector = (
        ToolSelector(app.state.tool_registry)
        if app.state.tool_registry is not None
        else None
    )

    log.info(
        "startup",
        extra={
            "bind": f"{settings.ai_bind_host}:{settings.ai_port}",
            "model": settings.ai_default_model,
            "configured": bool(settings.ollima_api_key)
            and bool(settings.openrouter_api_key),
            "rag": settings.rag_enabled,
        },
    )
    # Warm the local OCR engine off the event loop so the first scanned-PDF
    # ingest does not pay the one-time model load. Best-effort, non-blocking.
    if settings.rag_enabled and settings.ai_ocr_engine == "rapidocr":
        from app.ingest.ocr import warm_ocr

        asyncio.create_task(warm_ocr(settings))
    # Best-effort tool discovery — fire-and-forget, gated, self-isolating.
    if settings.ollagraph_enabled:
        asyncio.create_task(_discover_tools_best_effort(app, settings))
    try:
        yield
    finally:
        # systemd sends SIGINT (see the unit), which triggers uvicorn's graceful
        # shutdown and runs this. Cancelling every task lets each generation's
        # `finally:` finalize as cancelled, instead of leaving messages spinning
        # until the Convex reaper fires 90s later.
        await app.state.registry.shutdown()
        await app.state.ingest_registry.shutdown()
        from app.ingest.pool import shutdown_pool

        shutdown_pool()
        if app.state.db is not None:
            await app.state.db.dispose()
        if app.state.ollagraph_http is not None:
            await app.state.ollagraph_http.aclose()
        await http.aclose()
        log.info("shutdown")


def create_app() -> FastAPI:
    app = FastAPI(
        title="myos AI inference plane",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.include_router(health.router)
    app.include_router(generate.router)
    app.include_router(files.router)
    app.include_router(tools.router)

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled", extra={"path": request.url.path})
        # Never echo exception text to the caller.
        return JSONResponse({"error": "internal"}, status_code=500)

    return app


app = create_app()
