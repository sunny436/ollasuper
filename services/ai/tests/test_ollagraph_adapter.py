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
