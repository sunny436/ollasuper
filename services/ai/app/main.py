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
import json
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any

import anyio
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.requests import Request

from app.clients.convex import ConvexClient
from app.clients.ollagraph import OllagraphAdapter
from app.config import Settings, get_settings
from app.db.engine import create_knowledge_engine
from app.logging import configure, get_logger
from app.observability import init_sentry
from app.routers import (
    files,
    generate,
    health,
    mcp,
    mcp_oauth,
    report,
    schedule,
    tools,
)
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
    client = OllagraphAdapter.build_http_client(settings)
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


def _scope_allowlist(settings: Settings) -> dict[str, list[str]]:
    """Parse `mcp_oauth_scope_allowlist` into {slug: [scope, ...]}.

    EMPTY BY DEFAULT, which means "request what the server's own metadata asks
    for" — the specification's behaviour, and the only honest default given that
    the SDK overwrites `client_metadata.scope` from that metadata. A malformed
    value yields {} plus a warning rather than an exception: a misconfigured
    least-privilege hint must not stop the service booting.
    """
    raw = (settings.mcp_oauth_scope_allowlist or "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError:
        log.warning("mcp_oauth_scope_allowlist_unparseable")
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {
        str(slug): [str(scope) for scope in scopes]
        for slug, scopes in parsed.items()
        if isinstance(scopes, list)
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure(settings.ai_log_level, settings.secrets())
    # Holds the MCP pool's task group open across the yield. A plain assignment
    # cannot: the group must be ENTERED here and EXITED here, in this task.
    resources = AsyncExitStack()
    await resources.__aenter__()

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
        OllagraphAdapter.build_http_client(settings)
        if settings.ollagraph_enabled
        else None
    )
    app.state.tool_selector = (
        ToolSelector(app.state.tool_registry)
        if app.state.tool_registry is not None
        else None
    )
    # Phase 3: live MCP sessions. None when disabled — with the flag off the
    # lifespan is byte-identical to Phase 2 and no route can open a connection.
    #
    # The pool owns a task group that must outlive any single request, because
    # sessions do. It is entered on `resources` (this task) and closed in the
    # `finally` below (also this task): anyio refuses to exit a cancel scope
    # from a different task than entered it, which is the same constraint that
    # makes every session an actor with its own owner task.
    app.state.mcp_pool = None
    app.state.mcp_vault = None
    app.state.mcp_oauth_flow = None
    if settings.mcp_connections_enabled:
        from app.mcp.credentials import (
            EnvCredentialResolver,
            VaultCredentialResolver,
            parse_test_credentials,
        )
        from app.mcp.session import McpSessionPool, PoolLimits

        # Phase 4: the credential vault. FAIL CLOSED — if OAuth is enabled but
        # unkeyed, `KeyProvider` raises here, at boot, rather than letting the
        # service run and discover it on a user's first authorization. There is
        # deliberately no generated default: a boot-time key would encrypt
        # credentials no later process could read.
        resolver: Any = EnvCredentialResolver(
            parse_test_credentials(settings.mcp_test_credentials)
        )
        if settings.mcp_oauth_enabled:
            from app.mcp.oauth.attempts import AttemptRegistry
            from app.mcp.oauth.flow import OAuthFlow
            from app.mcp.vault.convex_store import ConvexCredentialStore
            from app.mcp.vault.keys import KeyProvider
            from app.mcp.vault.store import CredentialVault

            keys = KeyProvider(
                settings.mcp_credential_keys,
                settings.mcp_credential_active_key_version,
            )
            app.state.mcp_vault = CredentialVault(
                keys, ConvexCredentialStore(app.state.convex)
            )
            app.state.mcp_oauth_flow = OAuthFlow(
                app.state.mcp_vault,
                redirect_uri=settings.mcp_oauth_redirect_uri,
                registry=AttemptRegistry(ttl_s=settings.mcp_oauth_attempt_ttl_s),
                client_metadata_url=settings.mcp_oauth_client_metadata_url or None,
                scope_allowlist=_scope_allowlist(settings),
            )
            # Authorization flows outlive the request that started them, so they
            # need a lifespan-scoped group — the same anyio constraint that
            # makes every pooled session an actor.
            app.state.mcp_oauth_flow.bind(
                await resources.enter_async_context(anyio.create_task_group())
            )
            # The pool's resolver becomes the vault-backed one: a pooled session
            # can then refresh an expired token silently, while an INTERACTIVE
            # authorization is refused from a tool call (see
            # VaultCredentialResolver).
            resolver = VaultCredentialResolver(
                app.state.mcp_vault,
                redirect_uri=settings.mcp_oauth_redirect_uri,
                client_metadata_url=settings.mcp_oauth_client_metadata_url or None,
            )
            log.info(
                "mcp_oauth_ready",
                extra={"key_versions": list(keys.known_versions)},
            )

        app.state.mcp_pool = await McpSessionPool(
            PoolLimits(
                idle_ttl_s=settings.mcp_session_idle_ttl_s,
                max_sessions=settings.mcp_max_sessions,
                max_sessions_per_user=settings.mcp_max_sessions_per_user,
                sweep_interval_s=settings.mcp_session_sweep_interval_s,
                close_timeout_s=settings.mcp_pool_close_timeout_s,
                max_tools_per_server=settings.mcp_max_tools_per_server,
                max_tool_schema_bytes=settings.mcp_max_tool_schema_bytes,
                max_response_bytes=settings.mcp_max_response_bytes,
                max_stream_bytes_per_request=settings.mcp_max_stream_bytes_per_request,
                max_listen_stream_bytes=settings.mcp_max_listen_stream_bytes,
                max_concurrent_calls_per_user=settings.mcp_max_concurrent_calls_per_user,
            ),
            resolver=resolver,
        ).start(resources)

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
        # LOAD-BEARING, not hygiene. Every pooled MCP session is a task parked
        # on an event; a parked task never returns on its own, so leaving one
        # open makes the pool's task group wait forever and systemd shutdown
        # with it. `aclose()` closes each session first and cancels the group as
        # a backstop, both bounded, so a wedged remote server cannot hang us.
        if getattr(app.state, "mcp_pool", None) is not None:
            await app.state.mcp_pool.aclose()
        await resources.aclose()
        from app.ingest.pool import shutdown_pool

        shutdown_pool()
        if app.state.db is not None:
            await app.state.db.dispose()
        if app.state.ollagraph_http is not None:
            await app.state.ollagraph_http.aclose()
        await http.aclose()
        log.info("shutdown")


def create_app() -> FastAPI:
    init_sentry(get_settings(), component="myos-ai")
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
    # Scheduled Tasks composer. Parses text into a schedule and returns JSON —
    # it holds no Convex client and can create nothing.
    app.include_router(schedule.router)
    # Scheduled-report PDF. Same shape as the parser: payload in, bytes out, no
    # Convex client, no ingress secret, no write path of any kind.
    app.include_router(report.router)
    # MCP server CATALOGUE (Phase 2). Read-only discovery over the local
    # catalogue — it never contacts the upstream registry and never connects to
    # an MCP server. Same service-key dependency as every other /v1 router.
    app.include_router(mcp.router)
    # Phase 4: the OAuth control plane. Same /v1/mcp prefix and the same
    # service-key dependency; a separate module because driving an authorization
    # flow against a third party is a different job from reading a local table.
    app.include_router(mcp_oauth.router)

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled", extra={"path": request.url.path})
        # Never echo exception text to the caller.
        return JSONResponse({"error": "internal"}, status_code=500)

    return app


app = create_app()
