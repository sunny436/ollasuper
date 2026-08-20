"""/v1/title — auth, generation, and graceful failure. No network (LLM mocked)."""

from __future__ import annotations

import httpx
import pytest
from httpx import ASGITransport
from langchain_core.messages import AIMessage

from app.clients.convex import ConvexClient
from app.main import create_app
from app.runtime.registry import Registry
from tests.conftest import make_settings

SERVICE_KEY = "test-service-key-aaaaaaaaaaaaaaaaaaaa"


class _FakeLLM:
    def __init__(self, *, content: str = "", exc: Exception | None = None) -> None:
        self._content = content
        self._exc = exc

    async def ainvoke(self, _messages):
        if self._exc is not None:
            raise self._exc
        return AIMessage(content=self._content)


def _payload() -> dict:
    return {
        "firstUser": "How can I integrate Google OAuth with Convex?",
        "firstAssistant": "You configure the Google OAuth client in Convex auth...",
    }


@pytest.fixture
async def client(fake_convex):
    settings = make_settings(fake_convex.url)
    app = create_app()
    http = ConvexClient.build_http_client()
    app.state.settings = settings
    app.state.http = http
    app.state.convex = ConvexClient(settings, http)
    app.state.registry = Registry(max_per_user=2, max_global=3)
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    await http.aclose()


@pytest.mark.parametrize("headers", [{}, {"x-service-key": "wrong"}])
async def test_title_requires_the_service_key(client, headers):
    r = await client.post("/v1/title", json=_payload(), headers=headers)
    assert r.status_code == 401


async def test_title_returns_generated_title(client, monkeypatch):
    monkeypatch.setattr(
        "app.routers.generate.build_llm",
        lambda *a, **k: _FakeLLM(content="  Google OAuth Convex  "),
    )
    r = await client.post(
        "/v1/title", json=_payload(), headers={"x-service-key": SERVICE_KEY}
    )
    assert r.status_code == 200
    assert r.json()["title"] == "Google OAuth Convex"


async def test_title_llm_failure_returns_empty(client, monkeypatch):
    monkeypatch.setattr(
        "app.routers.generate.build_llm",
        lambda *a, **k: _FakeLLM(exc=RuntimeError("gemini unavailable")),
    )
    r = await client.post(
        "/v1/title", json=_payload(), headers={"x-service-key": SERVICE_KEY}
    )
    assert r.status_code == 200
    assert r.json()["title"] == ""
