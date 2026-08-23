"""Read-only /v1/tools introspection route: auth, 503-when-disabled, and
metadata-only responses. Mirrors test_routes.py's app wiring."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
from httpx import ASGITransport

from app.main import create_app
from app.tools.discovery import discover_from_spec
from app.tools.registry import ToolRegistry
from tests.conftest import make_settings

SERVICE_KEY = "test-service-key-aaaaaaaaaaaaaaaaaaaa"
SPEC = json.loads(
    (Path(__file__).parent / "fakes" / "ollagraph_openapi.json").read_text()
)


def _populated_registry() -> ToolRegistry:
    reg = ToolRegistry()
    r = discover_from_spec(SPEC, default_timeout=25.0)
    reg.replace_all(r.definitions, r.components, r.report)
    return reg


async def _client(app):
    transport = ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def test_requires_service_key():
    app = create_app()
    app.state.settings = make_settings("http://x")
    app.state.tool_registry = None
    c = await _client(app)
    try:
        r = await c.get("/v1/tools")  # no x-service-key
        assert r.status_code == 401
    finally:
        await c.aclose()


async def test_503_when_registry_disabled():
    app = create_app()
    app.state.settings = make_settings("http://x")
    app.state.tool_registry = None  # ollagraph off -> feature disabled
    c = await _client(app)
    try:
        r = await c.get("/v1/tools", headers={"x-service-key": SERVICE_KEY})
        assert r.status_code == 503
    finally:
        await c.aclose()


async def test_lists_metadata_only():
    app = create_app()
    app.state.settings = make_settings("http://x")
    app.state.tool_registry = _populated_registry()
    c = await _client(app)
    try:
        r = await c.get("/v1/tools", headers={"x-service-key": SERVICE_KEY})
        assert r.status_code == 200
        body = r.json()
        assert body["count"] == 12
        # read-only + EXTERNAL (registered enabled, approval-gated); HIGH_IMPACT
        # stays disabled.
        assert body["enabled"] == 9
        assert body["returned"] == 12
        assert body["categories"]["Scraping"] == 3
        # Compact rows carry metadata only — no schemas, no credentials.
        row = body["tools"][0]
        assert set(row) >= {"tool_id", "name", "category", "side_effect", "enabled"}
        assert "authorization" not in json.dumps(body).lower()
    finally:
        await c.aclose()


async def test_category_and_enabled_filters():
    app = create_app()
    app.state.settings = make_settings("http://x")
    app.state.tool_registry = _populated_registry()
    c = await _client(app)
    try:
        r = await c.get(
            "/v1/tools",
            params={"category": "Account"},
            headers={"x-service-key": SERVICE_KEY},
        )
        assert r.status_code == 200
        assert r.json()["returned"] == 3

        r2 = await c.get(
            "/v1/tools",
            params={"enabled": "false"},
            headers={"x-service-key": SERVICE_KEY},
        )
        assert all(t["enabled"] is False for t in r2.json()["tools"])
    finally:
        await c.aclose()


async def test_get_tool_detail_and_404():
    app = create_app()
    app.state.settings = make_settings("http://x")
    app.state.tool_registry = _populated_registry()
    c = await _client(app)
    try:
        r = await c.get(
            "/v1/tools/scrape_endpoint_v1_scrape_post",
            headers={"x-service-key": SERVICE_KEY},
        )
        assert r.status_code == 200
        assert r.json()["input_schema"] == {
            "$ref": "#/components/schemas/ScrapeRequest"
        }

        r404 = await c.get(
            "/v1/tools/nope", headers={"x-service-key": SERVICE_KEY}
        )
        assert r404.status_code == 404
    finally:
        await c.aclose()


# --- POST /v1/tools/discover (Phase 2, read-only metadata) -----------------
from tests.fakes.tool_defs import sample_registry  # noqa: E402


async def test_discover_requires_service_key():
    app = create_app()
    app.state.settings = make_settings("http://x")
    app.state.tool_registry = sample_registry()
    c = await _client(app)
    try:
        r = await c.post("/v1/tools/discover", json={"query": "scrape a page"})
        assert r.status_code == 401
    finally:
        await c.aclose()


async def test_discover_503_when_registry_disabled():
    app = create_app()
    app.state.settings = make_settings("http://x")
    app.state.tool_registry = None
    c = await _client(app)
    try:
        r = await c.post(
            "/v1/tools/discover",
            json={"query": "scrape a page"},
            headers={"x-service-key": SERVICE_KEY},
        )
        assert r.status_code == 503
    finally:
        await c.aclose()


async def test_discover_returns_relevant_candidates():
    app = create_app()
    app.state.settings = make_settings("http://x")
    app.state.tool_registry = sample_registry()
    c = await _client(app)
    try:
        r = await c.post(
            "/v1/tools/discover",
            json={"query": "find broken links on a website", "top_k": 3},
            headers={"x-service-key": SERVICE_KEY},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["no_match"] is False
        assert body["candidates"][0]["tool"]["tool_id"] == "broken_links"
        assert len(body["candidates"]) <= 3
        # metadata only — no credentials leak into the response
        assert "authorization" not in r.text.lower()
    finally:
        await c.aclose()


async def test_discover_no_match():
    app = create_app()
    app.state.settings = make_settings("http://x")
    app.state.tool_registry = sample_registry()
    c = await _client(app)
    try:
        r = await c.post(
            "/v1/tools/discover",
            json={"query": "explain gradient descent"},
            headers={"x-service-key": SERVICE_KEY},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["no_match"] is True
        assert body["candidates"] == []
    finally:
        await c.aclose()
