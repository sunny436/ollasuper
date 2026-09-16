"""Diagnose a GitHub MCP tool call through the plane's REAL stack, outside a turn.

    cd /opt/myos/services/ai && set -a && . ./.env && set +a && \
      .venv/bin/python -m qa.secaudit_github_probe <connection> <user> <workspace>

Runs the production lifespan (vault, OAuth resolver, session pool, curated
registry), composes the one GitHub connection exactly as a chat turn does, and
calls a few read tools. Prints only the outcome and a REDACTED error chain —
never a token. Found (2026-09-16): reads on github/github-mcp-server answer, the
same reads on Sk09032/telegram_summarization_bot and sunny436/ollasuper time out
inside the GitHub MCP server (`tools/call` timed out) — not an audit defect.
"""

from __future__ import annotations

import asyncio
import sys

from fastapi import FastAPI

from app.logging import redact_text
from app.main import lifespan
from app.mcp.turn import mcp_for_turn
from app.models.chat import McpConnectionRef


async def main(connection_id: str, user_id: str, workspace_id: str) -> None:
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
            me = await adapter.call_tool(
                by_name["get_me"], {}, user_id=user_id, workspace_id=workspace_id
            )
            import re as _re

            login = (
                _re.findall(r"login[^A-Za-z0-9]+([A-Za-z0-9-]+)", str(me)) or ["?"]
            )[0]
            print("github login:", login)
            calls = [
                (
                    "list_commits",
                    {"owner": "github", "repo": "github-mcp-server", "perPage": 1},
                ),
                (
                    "get_file_contents",
                    {"owner": "github", "repo": "github-mcp-server", "path": "LICENSE"},
                ),
                (
                    "list_commits",
                    {
                        "owner": "Sk09032",
                        "repo": "telegram_summarization_bot",
                        "perPage": 1,
                    },
                ),
            ]
            for name, args in calls:
                tool = by_name[name]

                try:
                    out = await adapter.call_tool(
                        tool, args, user_id=user_id, workspace_id=workspace_id
                    )
                    print("OK", name, "bytes:", len(str(out)))
                except Exception as e:  # noqa: BLE001
                    chain = []
                    cur: BaseException | None = e
                    while cur is not None and len(chain) < 6:
                        chain.append(
                            f"{type(cur).__name__}: {redact_text(str(cur))[:300]}"
                        )
                        cur = cur.__cause__ or cur.__context__
                    print("FAIL", name, " <- ".join(chain[:3]))


if __name__ == "__main__":
    asyncio.run(main(*sys.argv[1:4]))
