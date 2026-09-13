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

    # 2. A REAL MCP handshake. Nothing short of this proves the endpoint speaks
    #    the protocol rather than merely answering HTTP.
    try:
        from mcp.client import Client
        from mcp.client.streamable_http import streamable_http_client

        async with httpx2.AsyncClient(
            timeout=httpx2.Timeout(TIMEOUT_S), follow_redirects=True
        ) as http:
            async with Client(
                server=streamable_http_client(url, http_client=http)
            ) as session:
                tools = await session.list_tools()
                out["verdict"] = "open"
                out["tools"] = len(getattr(tools, "tools", tools) or [])
                return out
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)[:120]
        # A 401 can also surface here, through the SDK's erased status.
        if "401" in msg or "auth" in msg.lower() or "unauthor" in msg.lower():
            out["verdict"] = "auth"
            out["detail"] = "401 during initialize"
        else:
            out["detail"] = f"{type(exc).__name__}: {msg}"
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
