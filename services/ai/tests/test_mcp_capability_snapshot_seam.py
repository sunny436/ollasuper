"""Capability discovery must read the snapshot the session actually carries.

Measured on production with Google Maps' MCP server: both call sites passed
`getattr(session, "capabilities", None)`, but `McpSession` names the field
`snapshot`. The snapshot was therefore always None, and every server was asked
for resources and prompts it never advertised. Google's mapstools answers an
unadvertised `resources/list` with HTTP 404, the SDK reads a 404 as "session
terminated", and the session died right after connecting:

    mcp.session_ready google-maps tools=5
    mcp.session_failed google-maps session_expired 404

`discover_capabilities` itself was tested and correct — it skips unadvertised
lists when handed a snapshot. The seam in front of it never handed one over.
"""

from __future__ import annotations

import ast
from dataclasses import fields
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.mcp.capabilities import snapshot_from
from app.mcp.index import discover_capabilities
from app.mcp.session import McpSession

APP = Path(__file__).resolve().parents[1] / "app"
CALL_SITES = [APP / "mcp" / "turn.py", APP / "routers" / "mcp.py"]


def _snapshot_attributes(path: Path) -> list[str]:
    """The session attribute each `discover_capabilities(snapshot=...)` reads."""
    found: list[str] = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if not (
            isinstance(node, ast.Call)
            and getattr(node.func, "id", None) == "discover_capabilities"
        ):
            continue
        for kw in node.keywords:
            if kw.arg != "snapshot":
                continue
            value = kw.value
            is_getattr = getattr(getattr(value, "func", None), "id", None) == "getattr"
            if isinstance(value, ast.Call) and is_getattr:
                found.append(value.args[1].value)
            elif isinstance(value, ast.Attribute):
                found.append(value.attr)
            else:
                found.append(ast.dump(value))
    return found


@pytest.mark.parametrize("path", CALL_SITES, ids=lambda p: p.name)
def test_every_call_site_reads_a_field_mcp_session_has(path):
    names = _snapshot_attributes(path)
    assert names, f"{path.name} no longer passes snapshot= to discover_capabilities"
    session_fields = {f.name for f in fields(McpSession)}
    for name in names:
        assert name in session_fields, (
            f"{path.name} reads session.{name}; McpSession has {sorted(session_fields)}"
        )


@pytest.mark.anyio
async def test_a_tools_only_server_is_never_asked_for_resources_or_prompts():
    calls: list[str] = []

    class ToolsOnlyClient:
        """Shaped like Google's MCP servers: `capabilities: {tools: {...}}`."""

        server_capabilities = SimpleNamespace(
            tools=SimpleNamespace(list_changed=False),
            resources=None,
            prompts=None,
            logging=None,
            completions=None,
        )
        server_info = SimpleNamespace(name="mapstools", version="1.0.0")
        protocol_version = "2025-11-25"
        instructions = None

        async def list_resources(self):
            calls.append("resources/list")
            raise RuntimeError("HTTP 404 - the SDK ends the session")

        async def list_resource_templates(self):
            calls.append("resources/templates/list")
            raise RuntimeError("HTTP 404")

        async def list_prompts(self):
            calls.append("prompts/list")
            raise RuntimeError("HTTP 404")

    client = ToolsOnlyClient()
    snapshot = snapshot_from(client, tool_count=5)
    assert snapshot.has_tools
    assert not snapshot.has_resources
    assert not snapshot.has_prompts

    await discover_capabilities(
        client, connection_id="c1", server_slug="google-maps", snapshot=snapshot
    )
    assert calls == []
