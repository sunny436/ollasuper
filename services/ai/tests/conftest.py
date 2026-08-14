from __future__ import annotations

import pytest

from app.clients.convex import ConvexClient
from app.config import Settings
from tests.fakes.convex_server import FakeConvexServer


@pytest.fixture
async def fake_convex():
    server = FakeConvexServer()
    async with server as state:
        yield state


def make_settings(url: str, **overrides) -> Settings:
    base = {
        "ai_service_key": "test-service-key-aaaaaaaaaaaaaaaaaaaa",
        "ai_ingress_secret": "test-ingress-secret-bbbbbbbbbbbbbbbb",
        "openrouter_api_key": "sk-or-v1-test",
        "convex_internal_url": url,
        "convex_site_url": url,
        # Deliberately NOT overriding the flush timings. An earlier version of
        # this fixture pinned the interval to 100ms "so tests are fast", which
        # silently re-introduced the exact policy bug the writer tests exist to
        # catch. Tests run against the production numbers.
    }
    base.update(overrides)
    return Settings(**base)


@pytest.fixture
async def convex_client(fake_convex):
    settings = make_settings(fake_convex.url)
    http = ConvexClient.build_http_client()
    try:
        yield ConvexClient(settings, http), settings
    finally:
        await http.aclose()
