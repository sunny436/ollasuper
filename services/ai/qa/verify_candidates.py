"""Probe candidate MCP servers for real, before any of them is curated.

WHY THIS EXISTS. Curation is the gate that makes a server executable, so a
curated row is a security decision. Writing one because a registry entry exists
would make the registry authoritative over this deployment — exactly the
inversion Phase 2 refuses. This contacts each candidate and records what it
actually does.

WHAT COUNTS AS VERIFIED. Not "the row exists" and not "the host resolves":

    open  — an MCP `initialize` completed and tools were listed. Connectable
            with no credential. Safe to curate and immediately usable.
    auth  — the server answered 401 with a `WWW-Authenticate` challenge, which
            is how MCP OAuth is discovered at runtime. Real and usable, but a
            user must authorize it first. Safe to curate.
    dead  — unreachable, TLS failure, protocol failure, or a non-auth error.
            NOT curated. A dead endpoint in an allowlist is a defect.

`probe_auth` is Phase 4's, reused rather than reimplemented: it stops after
metadata, so it registers no client, requests no token and shows no consent
screen. This whole script is read-only against every third party it touches.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

TIMEOUT_S = 20.0


async def _probe_one(name: str, url: str, transport: str) -> dict[str, Any]:
    """One candidate: initialize, list tools, or classify the refusal."""
    import httpx2

    from app.mcp.oauth.probe import probe_auth

    out: dict[str, Any] = {
        "name": name,
        "url": url,
        "transport": transport,
        "verdict": "dead",
        "tools": 0,
        "auth": "",
        "detail": "",
    }

    # 1. The auth SHAPE first, because it is the cheapest question and it
    #    answers "is this real but locked" without opening a session.
    try:
        async with httpx2.AsyncClient(
            timeout=httpx2.Timeout(TIMEOUT_S), follow_redirects=True
        ) as client:
            shape = await probe_auth(url, client)
        out["auth"] = getattr(shape, "scheme", "") or ""
        reachable = bool(getattr(shape, "reachable", False))
        if getattr(shape, "requires_auth", False) or out["auth"]:
            out["verdict"] = "auth"
            out["detail"] = f"401 challenge: {out['auth'] or 'oauth'}"
            return out
        if not reachable:
            out["detail"] = "unreachable at probe"
            return out
    except Exception as exc:  # noqa: BLE001 — a candidate may do anything
        out["detail"] = f"probe: {type(exc).__name__}"

    # 2. A REAL MCP handshake, THROUGH A STATUS RECORDER.
    #
    # THE SDK ERASES THE HTTP STATUS — Phase 3 measured it: a 401, 403, 429, 500
    # and 503 all arrive as the identical `MCPError(-32603)` inside a
    # doubly-nested ExceptionGroup. A first version of this file read only the
    # exception text and classified 34 live vendor servers as "dead" when every
    # one of them was answering 401, which would have thrown away almost the
    # entire catalogue.
    #
    # `StatusRecorder` is the httpx2 response event hook Phase 3 built for
    # exactly this, and `build_http_client` is the production wiring. Reused
    # rather than reimplemented, so this classifies failures the same way a real
    # connection does.
    from app.mcp.models import McpConnectionSpec, McpServerIdentity
    from app.mcp.status import StatusRecorder
    from app.mcp.transport import build_http_client

    recorder = StatusRecorder()
    try:
        from mcp.client import Client
        from mcp.client.streamable_http import streamable_http_client

        spec = McpConnectionSpec(
            connection_id="verify",
            identity=McpServerIdentity(slug="verify", trusted=False),
            server_name=name,
            version="probe",
            transport="streamable-http",
            endpoint_url=url,
            auth_kind="none",
            user_id="verify",
            workspace_id="verify",
            connect_timeout_s=TIMEOUT_S,
            request_timeout_s=TIMEOUT_S,
        )
        http = build_http_client(spec, {}, recorder)
        async with http:
            async with Client(
                server=streamable_http_client(url, http_client=http)
            ) as session:
                tools = await session.list_tools()
                out["verdict"] = "open"
                out["tools"] = len(getattr(tools, "tools", tools) or [])
                return out
    except Exception as exc:  # noqa: BLE001
        status = recorder.status
        out["detail"] = f"{type(exc).__name__}: {str(exc)[:80]}"
        if status in (401, 403):
            out["verdict"] = "auth"
            out["auth"] = (recorder.www_authenticate or "oauth")[:60]
            out["detail"] = f"HTTP {status}"
        elif status is not None:
            out["detail"] = f"HTTP {status}"
        elif not recorder.saw_response:
            out["detail"] = "no response from the server"
        return out


async def main() -> None:
    candidates = json.load(sys.stdin)
    # Bounded concurrency: these are other people's servers and a QA sweep has
    # no business arriving as a burst.
    sem = asyncio.Semaphore(6)

    async def run(c: dict) -> dict:
        async with sem:
            return await _probe_one(c["name"], c["url"], c.get("transport", ""))

    rows = await asyncio.gather(*(run(c) for c in candidates))
    print(json.dumps(rows, indent=None))


if __name__ == "__main__":
    asyncio.run(main())
