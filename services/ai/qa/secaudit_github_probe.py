"""Diagnose a GitHub MCP tool call through the plane's REAL stack, outside a turn.

    cd /opt/myos/services/ai && set -a && . ./.env && set +a && \
      .venv/bin/python -m qa.secaudit_github_probe <connection> <user> <workspace>

Runs the production lifespan (vault, OAuth resolver, session pool, curated
registry), composes the one GitHub connection exactly as a chat turn does, and
calls a few read tools. PROBE_WIRE=1 also prints each HTTP exchange's method,
status, content-type/encoding/length (never headers with credentials, never a
body). Prints only outcomes and REDACTED error chains — never a token.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys

from fastapi import FastAPI

from app.logging import redact_text
from app.main import lifespan
from app.mcp.turn import mcp_for_turn
from app.models.chat import McpConnectionRef

CALLS = json.loads(
    os.environ.get("PROBE_CALLS")
    or json.dumps(
        [
            ["list_commits", {"owner": "github", "repo": "github-mcp-server"}],
            [
                "list_commits",
                {"owner": "Sk09032", "repo": "telegram_summarization_bot"},
            ],
        ]
    )
)


def _wire() -> None:
    """Log every HTTP exchange of the MCP client: shape only, no secrets."""
    import app.mcp.session as session_mod

    real = session_mod.build_http_client

    def build(spec, headers, recorder, **kwargs):
        client = real(spec, headers, recorder, **kwargs)

        async def on_request(request):
            print("WIRE >", request.method, request.url.path, flush=True)

        async def on_response(response):
            h = response.headers
            print(
                "WIRE <",
                response.request.method,
                response.status_code,
                "type=" + h.get("content-type", ""),
                "enc=" + h.get("content-encoding", ""),
                "len=" + h.get("content-length", ""),
                flush=True,
            )

        client.event_hooks["request"].append(on_request)
        client.event_hooks["response"].append(on_response)
        return client

    session_mod.build_http_client = build
    for name in ("mcp", "httpx2", "httpcore2"):
        lg = logging.getLogger(name)
        lg.setLevel(logging.DEBUG)
        handler = logging.StreamHandler(sys.stdout)
        fmt = logging.Formatter("SDK %(name)s %(levelname)s %(message)s")
        handler.setFormatter(fmt)
        lg.addHandler(handler)


async def main(connection_id: str, user_id: str, workspace_id: str) -> None:
    if os.environ.get("PROBE_WIRE"):
        _wire()
    app = FastAPI()
    async with lifespan(app):
        s = app.state
        ref = McpConnectionRef(
            connectionId=connection_id,
            serverName="io.github.github/github-mcp-server",
            slug="github",
            version="1.12.1",
        )
        async with mcp_for_turn(
            s.mcp_pool,
            [ref],
            user_id=user_id,
            workspace_id=workspace_id,
            base=None,
            engine=s.db,
            settings=s.settings,
            convex=s.convex,
        ) as caps:
            print("composed tools:", len(caps.tool_ids), "failures:", caps.failures)
            by_name = {t.name: t for t in caps.registry.list()}
            adapter = caps.adapters[by_name["get_me"].provider]
            for name, args in CALLS:
                print("CALL", name, json.dumps(args), flush=True)
                try:
                    out = await adapter.call_tool(
                        by_name[name], args, user_id=user_id, workspace_id=workspace_id
                    )
                    print("OK", name, "bytes:", len(str(out)), flush=True)
                    print("RESULT", redact_text(json.dumps(out, default=str))[:400], flush=True)
                except Exception as e:  # noqa: BLE001
                    chain = []
                    cur: BaseException | None = e
                    while cur is not None and len(chain) < 6:
                        chain.append(
                            f"{type(cur).__name__}: {redact_text(str(cur))[:300]}"
                        )
                        cur = cur.__cause__ or cur.__context__
                    print("FAIL", name, " <- ".join(chain[:4]), flush=True)


if __name__ == "__main__":
    asyncio.run(main(*sys.argv[1:4]))
