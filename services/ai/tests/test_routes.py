"""Route behaviour: auth, concurrency, cancellation, and non-blocking accept."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from httpx import ASGITransport

from app.clients.convex import ConvexClient
from app.main import create_app
from app.runtime.registry import Registry
from tests.conftest import make_settings

SERVICE_KEY = "test-service-key-aaaaaaaaaaaaaaaaaaaa"


def _payload(**over) -> dict:
    body = {
        "streamId": "s1",
        "threadId": "t1",
        "messageId": "m1",
        "userId": "u1",
        "workspaceId": "w1",
        "model": "anthropic/claude-opus-5",
        "history": [{"role": "user", "content": "hi", "seq": 0, "attachments": []}],
    }
    body.update(over)
    return body


class _StubRunner:
    """Stands in for run_generation so routes are tested without a model."""

    def __init__(self, delay: float = 0.2) -> None:
        self.delay = delay
        self.started = 0
        self.cancelled = 0

    async def __call__(self, req, settings, convex) -> None:
        self.started += 1
        try:
            await asyncio.sleep(self.delay)
        except asyncio.CancelledError:
            self.cancelled += 1
            raise


@pytest.fixture
async def client(fake_convex, monkeypatch):
    settings = make_settings(fake_convex.url)
    runner = _StubRunner()
    monkeypatch.setattr("app.routers.generate.run_generation", runner)

    app = create_app()
    http = ConvexClient.build_http_client()
    app.state.settings = settings
    app.state.http = http
    app.state.convex = ConvexClient(settings, http)
    app.state.registry = Registry(max_per_user=2, max_global=3)

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c, app, runner
    await http.aclose()


async def test_healthz_is_public(client):
    c, _, _ = client
    r = await c.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


@pytest.mark.parametrize(
    "headers",
    [
        {},  # missing entirely
        {"x-service-key": ""},  # empty
        {"x-service-key": "wrong"},  # wrong length
        {"x-service-key": "x" * len(SERVICE_KEY)},  # right length, wrong value
    ],
)
async def test_generate_requires_the_service_key(client, headers):
    c, _, runner = client
    r = await c.post("/v1/generate", json=_payload(), headers=headers)
    assert r.status_code == 401
    assert "detail" in r.json()
    # And no work was started.
    assert runner.started == 0


async def test_generate_accepts_and_returns_immediately(client):
    c, app, runner = client
    r = await c.post(
        "/v1/generate", json=_payload(), headers={"x-service-key": SERVICE_KEY}
    )
    # 202 before any model work: Convex's dispatch action treats non-2xx as
    # terminal, so blocking here would couple generation lifetime to one
    # action's timeout.
    assert r.status_code == 202
    assert r.json()["messageId"] == "m1"
    await asyncio.sleep(0.05)
    assert runner.started == 1
    assert app.state.registry.has("m1")


async def test_duplicate_message_id_is_a_conflict(client):
    c, _, _ = client
    h = {"x-service-key": SERVICE_KEY}
    assert (await c.post("/v1/generate", json=_payload(), headers=h)).status_code == 202
    r = await c.post("/v1/generate", json=_payload(), headers=h)
    assert r.status_code == 409


async def test_per_user_concurrency_cap(client):
    c, _, _ = client
    h = {"x-service-key": SERVICE_KEY}
    for i in range(2):  # max_per_user=2
        r = await c.post("/v1/generate", json=_payload(messageId=f"m{i}"), headers=h)
        assert r.status_code == 202
    r = await c.post("/v1/generate", json=_payload(messageId="m9"), headers=h)
    assert r.status_code == 429
    assert r.headers.get("Retry-After")


async def test_an_arbitrary_catalogue_model_is_accepted(client):
    """The model list is fetched live from OpenRouter, so the service must not
    second-guess it. Convex is the authority on what is allowed; this side only
    rejects structurally invalid values.

    This previously asserted the opposite (422 for "openai/gpt-4o") against a
    hard-coded three-model enum. That id is a real, selectable model now.
    """
    c, _, runner = client
    r = await c.post(
        "/v1/generate",
        json=_payload(model="openai/gpt-4o"),
        headers={"x-service-key": SERVICE_KEY},
    )
    assert r.status_code == 202
    # The runner is scheduled as a background task, so yield once before
    # asserting -- same as test_generate_accepts_and_starts above.
    await asyncio.sleep(0.05)
    assert runner.started == 1


async def test_an_empty_model_is_rejected_by_validation(client):
    """min_length=1 still holds: an empty model would reach the provider as a
    malformed request, so it should fail loudly here instead."""
    c, _, runner = client
    r = await c.post(
        "/v1/generate",
        json=_payload(model=""),
        headers={"x-service-key": SERVICE_KEY},
    )
    assert r.status_code == 422
    assert runner.started == 0


async def test_unknown_fields_are_rejected(client):
    """extra='forbid': a Convex-side rename must fail loudly, not silently."""
    c, _, _ = client
    r = await c.post(
        "/v1/generate",
        json=_payload(surpriseField="boom"),
        headers={"x-service-key": SERVICE_KEY},
    )
    assert r.status_code == 422


async def test_cancel_hits_the_running_task(client):
    c, app, runner = client
    h = {"x-service-key": SERVICE_KEY}
    await c.post("/v1/generate", json=_payload(), headers=h)
    await asyncio.sleep(0.05)

    r = await c.post("/v1/generate/m1/cancel", headers=h)
    assert r.status_code == 202
    assert r.json()["cancelled"] is True
    await asyncio.sleep(0.05)
    assert runner.cancelled == 1
    # Released, so the slot is reusable.
    assert not app.state.registry.has("m1")


async def test_cancel_of_an_unknown_generation_is_404_not_an_error(client):
    """A 404 here is normal: it means the generation already finished, or is on
    another worker. The ingress cancel flag still stops it either way."""
    c, _, _ = client
    r = await c.post("/v1/generate/nope/cancel", headers={"x-service-key": SERVICE_KEY})
    assert r.status_code == 404
    assert r.json()["cancelled"] is False


async def test_cancel_requires_auth(client):
    c, _, _ = client
    r = await c.post("/v1/generate/m1/cancel")
    assert r.status_code == 401
