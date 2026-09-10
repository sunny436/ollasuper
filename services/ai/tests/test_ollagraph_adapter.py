from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from app.clients.ollagraph import OllagraphAdapter
from app.config import Settings
from app.models.tools import ToolDefinition
from app.tools.errors import ToolError, ToolErrorKind

SPEC = json.loads(
    (Path(__file__).parent / "fakes" / "ollagraph_openapi.json").read_text()
)

KEY = "osk_testkey_abcdefgh1234"
SCRAPE = ToolDefinition(
    tool_id="scrape", name="Scrape", path="/v1/scrape", method="post"
)
SCHEMA = {
    "required": ["url"],
    "properties": {"url": {"type": "string"}, "timeout": {"type": "integer"}},
}


def _settings(**over) -> Settings:
    base = dict(
        ollagraph_base_url="https://api.ollagraph.test", ollagraph_api_key=KEY
    )
    base.update(over)
    return Settings(**base)


def _adapter(handler, **over):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return OllagraphAdapter(_settings(**over), client), client


async def test_fetch_spec_and_discover():
    adapter, client = _adapter(lambda req: httpx.Response(200, json=SPEC))
    try:
        result = await adapter.discover()
        assert result.report["registered"] == 12
    finally:
        await client.aclose()


async def test_fetch_spec_timeout():
    def handler(req):
        raise httpx.ReadTimeout("slow", request=req)

    adapter, client = _adapter(handler)
    try:
        with pytest.raises(ToolError) as ei:
            await adapter.fetch_spec()
        assert ei.value.kind == ToolErrorKind.TIMEOUT
    finally:
        await client.aclose()


async def test_fetch_spec_malformed():
    adapter, client = _adapter(lambda req: httpx.Response(200, text="not json"))
    try:
        with pytest.raises(ToolError) as ei:
            await adapter.fetch_spec()
        assert ei.value.kind == ToolErrorKind.MALFORMED_RESPONSE
    finally:
        await client.aclose()


async def test_call_tool_success_and_cost_header():
    def handler(req):
        return httpx.Response(200, json={"ok": 1}, headers={"x-credits-cost": "3"})

    adapter, client = _adapter(handler)
    try:
        out = await adapter.call_tool(
            SCRAPE, {"url": "https://x.com"}, input_schema=SCHEMA
        )
        assert out["ok"] is True
        assert out["data"] == {"ok": 1}
        assert out["cost"]["credits"] == "3"
    finally:
        await client.aclose()


async def test_bearer_header_is_sent():
    seen = {}

    def handler(req):
        seen["auth"] = req.headers.get("authorization")
        return httpx.Response(200, json={})

    adapter, client = _adapter(handler)
    try:
        await adapter.call_tool(SCRAPE, {"url": "https://x.com"}, input_schema=SCHEMA)
        assert seen["auth"] == f"Bearer {KEY}"
    finally:
        await client.aclose()


async def test_missing_required_field():
    adapter, client = _adapter(lambda req: httpx.Response(200, json={}))
    try:
        with pytest.raises(ToolError) as ei:
            await adapter.call_tool(SCRAPE, {}, input_schema=SCHEMA)
        assert ei.value.kind == ToolErrorKind.SCHEMA_VALIDATION
    finally:
        await client.aclose()


async def test_wrong_type_field():
    adapter, client = _adapter(lambda req: httpx.Response(200, json={}))
    try:
        with pytest.raises(ToolError) as ei:
            await adapter.call_tool(SCRAPE, {"url": 123}, input_schema=SCHEMA)
        assert ei.value.kind == ToolErrorKind.SCHEMA_VALIDATION
    finally:
        await client.aclose()


@pytest.mark.parametrize(
    "status,kind,retryable",
    [
        (401, ToolErrorKind.AUTH_FAILED, False),
        (403, ToolErrorKind.AUTH_FAILED, False),
        (404, ToolErrorKind.INVALID_TOOL, False),
        (422, ToolErrorKind.SCHEMA_VALIDATION, False),
        (429, ToolErrorKind.RATE_LIMITED, True),
        (503, ToolErrorKind.UPSTREAM_ERROR, True),
    ],
)
async def test_http_error_normalization(status, kind, retryable):
    adapter, client = _adapter(lambda req: httpx.Response(status, json={"e": 1}))
    try:
        with pytest.raises(ToolError) as ei:
            await adapter.call_tool(
                SCRAPE, {"url": "https://x.com"}, input_schema=SCHEMA
            )
        assert ei.value.kind == kind
        assert ei.value.retryable is retryable
        assert ei.value.status == status
    finally:
        await client.aclose()


async def test_malformed_success_response():
    adapter, client = _adapter(lambda req: httpx.Response(200, text="not json"))
    try:
        with pytest.raises(ToolError) as ei:
            await adapter.call_tool(
                SCRAPE, {"url": "https://x.com"}, input_schema=SCHEMA
            )
        assert ei.value.kind == ToolErrorKind.MALFORMED_RESPONSE
    finally:
        await client.aclose()


async def test_transport_error_is_unavailable():
    def handler(req):
        raise httpx.ConnectError("down", request=req)

    adapter, client = _adapter(handler)
    try:
        with pytest.raises(ToolError) as ei:
            await adapter.call_tool(
                SCRAPE, {"url": "https://x.com"}, input_schema=SCHEMA
            )
        assert ei.value.kind == ToolErrorKind.UNAVAILABLE
    finally:
        await client.aclose()


async def test_missing_key_fails_auth_before_network():
    adapter, client = _adapter(
        lambda req: httpx.Response(200, json={}), ollagraph_api_key=""
    )
    try:
        with pytest.raises(ToolError) as ei:
            await adapter.call_tool(
                SCRAPE, {"url": "https://x.com"}, input_schema=SCHEMA
            )
        assert ei.value.kind == ToolErrorKind.AUTH_FAILED
    finally:
        await client.aclose()


async def test_admin_token_tool_not_callable():
    admin = ToolDefinition(
        tool_id="a",
        name="A",
        path="/v1/admin/rotate",
        method="post",
        required_auth="AdminToken",
    )
    adapter, client = _adapter(lambda req: httpx.Response(200, json={}))
    try:
        with pytest.raises(ToolError) as ei:
            await adapter.call_tool(admin, {}, input_schema=None)
        assert ei.value.kind == ToolErrorKind.AUTH_FAILED
    finally:
        await client.aclose()


# --------------------------------------------------------------------------- #
# Crawl tools get a longer DEFAULT timeout. A site-wide broken-link audit cannot
# finish inside the 30s default — it timed out in QA and only completed once the
# scan was narrowed by hand — but the ceiling stays well under the 300s turn
# deadline so one call cannot consume an agentic turn's whole budget.
# --------------------------------------------------------------------------- #
def _timeout_for(tool: ToolDefinition, **over) -> float:
    s = _settings(**over)
    default = s.ollagraph_default_tool_timeout_s
    ident = f"{tool.tool_id} {tool.name}".lower()
    if any(m in ident for m in s.ollagraph_crawl_tool_markers):
        default = max(default, s.ollagraph_crawl_tool_timeout_s)
    return tool.timeout or default


def test_a_crawl_tool_gets_the_longer_default():
    broken = ToolDefinition(
        tool_id="seo_broken_links_endpoint_v1_seo_broken_links_audit_post",
        name="Broken links",
        path="/v1/seo/broken-links/audit",
        method="post",
    )
    assert _timeout_for(broken) == 90.0
    assert _timeout_for(broken) > _settings().ollagraph_default_tool_timeout_s


def test_an_ordinary_tool_keeps_the_short_default():
    assert _timeout_for(SCRAPE) == _settings().ollagraph_default_tool_timeout_s


def test_a_spec_declared_timeout_still_wins():
    """The override replaces the DEFAULT only — never a value the spec asked for."""
    crawl = ToolDefinition(
        tool_id="crawl_run", name="Crawl", path="/v1/crawl", method="post", timeout=12.0
    )
    assert _timeout_for(crawl) == 12.0


def test_the_crawl_ceiling_stays_inside_the_turn_deadline():
    """300s is the whole turn (ai_agent_total_deadline_s, and Convex sends the same
    300_000ms). One crawl must leave room for the rest of an agentic turn."""
    s = _settings()
    assert s.ollagraph_crawl_tool_timeout_s < s.ai_agent_total_deadline_s / 2
