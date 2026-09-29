"""Liveness and readiness. Public — no secrets in either response."""

from __future__ import annotations

import asyncio
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
    configured = (
        # chat -> Ollima; title/OCR/embeddings -> OpenRouter; both required.
        bool(state.settings.ollima_api_key)
        and bool(state.settings.openrouter_api_key)
        and bool(state.settings.ai_service_key)
    )

    now = time.monotonic()
    if now - _last_check[0] < _READY_CACHE_S:
        convex_ok = _last_check[1]
    else:
        convex_ok = await state.convex.healthy()
        _last_check = (now, convex_ok)

    # PHASE 8: MCP is REPORTED, and gates readiness in exactly one case.
    #
    # A remote MCP server being down must never make OllaSuper report unhealthy
    # — that would take the whole deployment out of a load balancer because a
    # third party had an outage, which is the failure §166 exists to prevent. So
    # none of this consults a network.
    #
    # THE ONE EXCEPTION is a CONFIGURATION error: the flag is on and the pool
    # did not start. That is not a third party's problem, it is this
    # deployment's, and a process serving MCP routes that can only 503 is not
    # ready in any useful sense.
    mcp_enabled = bool(getattr(state.settings, "mcp_connections_enabled", False))
    mcp_pool_live = getattr(state, "mcp_pool", None) is not None
    mcp = {
        "enabled": mcp_enabled,
        "pool": mcp_pool_live,
        # Presence, never the key. `mcp_vault` is None unless OAuth is enabled
        # AND `KeyProvider` accepted a key at boot.
        "vault": getattr(state, "mcp_vault", None) is not None,
        "local": bool(getattr(state.settings, "mcp_local_enabled", False)),
    }
    mcp_ok = (not mcp_enabled) or mcp_pool_live

    # DOCUMENTS: the same rule as MCP — a third party's outage never gates
    # readiness, a CONFIGURATION error does. LibreOffice enabled with a
    # component missing is this deployment's fault: DOCX rendering would fail
    # silently on every turn (which is exactly what happened on 19-09-2026).
    from app.documents.soffice import soffice_components

    docs_enabled = bool(getattr(state.settings, "ai_documents_soffice_enabled", False))
    components = soffice_components() if docs_enabled else {}
    docs_ok = (not docs_enabled) or all(
        components.get(k) for k in ("binary", "writer", "impress")
    )
    documents = {"soffice_enabled": docs_enabled, "ok": docs_ok, **components}

    # LIBRARY: two configuration errors that would otherwise surface only as a
    # trickle of failed files - decoders below the required sandbox isolation,
    # and an embedding dimension that does not fit the index column.
    from app.sandbox.harness import live_check, sandbox_status

    status = sandbox_status()
    # A REAL sandbox start (cached 30 s), off the event loop: the probes above
    # were taken at boot, and a sandbox that cannot start NOW refuses every
    # decode while they still read green.
    live = await asyncio.to_thread(live_check)
    index_ok = getattr(state, "index_dim_ok", True) is not False
    # Named for what it proves, and never echoing the word the leak test bans.
    sandbox = {
        "tier": status["tier"],
        "detail": status["detail"],
        "isolated": status["secret_free"],
        "min_tier": status["min_tier"],
        "meets_minimum": status["meets_minimum"],
        # Each isolation layer on its own (the host monitor alerts per layer).
        "pid_namespace": status.get("pid_namespace", ""),
        "readonly_fs": status.get("readonly_fs", False),
        "proc_isolated": status.get("proc_isolated", False),
        "live": live,
    }
    library = {"sandbox": sandbox, "index_dimension_ok": index_ok}
    library_ok = bool(status["meets_minimum"]) and index_ok and bool(live["ok"])

    ready = configured and convex_ok and mcp_ok and docs_ok and library_ok
    if not ready:
        response.status_code = 503
    return {
        "ready": ready,
        "configured": configured,
        "convex": convex_ok,
        "active": state.registry.active,
        "mcp": mcp,
        "documents": documents,
        "library": library,
    }
