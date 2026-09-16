from __future__ import annotations

import asyncio
import sys

import pytest

from app.clients.convex import ConvexClient
from app.config import Settings
from tests.fakes.convex_server import FakeConvexServer

# psycopg's async mode cannot run on Windows' default ProactorEventLoop; pick the
# Selector loop so the DB-backed tests (test_knowledge_db / test_retrieve_db) run
# on Windows dev machines too. No-op on Linux/CI.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


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
        "ollima_api_key": "sk-ollima-test",
        "convex_internal_url": url,
        "convex_site_url": url,
        # Render in-thread in tests so _render_page monkeypatches apply (the
        # process pool would not see them). Prod uses the pool for crash safety.
        "ai_ocr_render_workers": 0,
        # The background model-health probe makes real HTTP calls; any test that
        # runs the lifespan must opt in explicitly.
        "ai_model_health_probe_enabled": False,
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


@pytest.fixture(autouse=True)
def _attested_fixture_rows(monkeypatch, tmp_path_factory):
    """Every `LocalRow` fixture slug has a fresh, verified runtime attestation.

    `resolve_local_spec` refuses a local server without one (audit H-12), and
    the local-MCP suites predate that gate: they exercise policy, identity and
    the turn, not the launcher. The launcher's own verdicts are tested in
    `test_mcp_local_runtime.py`, which points `mcp_local_attestation_dir` at
    its own empty directory and therefore ignores this.
    """
    import time

    from app.mcp.local import attest
    from tests.fakes.mcp_gateway import LocalRow

    base = tmp_path_factory.mktemp("attest")
    digest = LocalRow().image_digest
    for slug in (
        "gw-fixture",
        "gw-hostile",
        "fs-local",
        "github",
        "srv-a",
        "srv-b",
        "a",
        "b",
    ):
        attest.write(
            attest.Attestation(
                slug=slug,
                verified=True,
                image_digest=digest,
                container_id="fixture",
                started_at=time.time() - 1,
                heartbeat_at=time.time() - 1,
            ),
            base,
        )
    monkeypatch.setattr(attest, "ATTESTATION_DIR", base)
