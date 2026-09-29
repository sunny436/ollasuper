"""The automatic model health registry and its background probe.

The property under test is the one the product needs: a model that starts
refusing leaves rotation by itself, and a model that recovers comes back by
itself — no restart, no `.env` edit — while chat never waits on, or breaks
because of, the checking.

Time is a fake clock and the gateway is an `httpx.MockTransport`, so nothing
sleeps and nothing leaves the process.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import openai
import pytest
from langchain_core.messages import AIMessage

import app.main as main_mod
from app.agent import health, health_probe
from app.config import Settings
from app.main import create_app
from app.routing import Candidate, RouterConfig, Signals, select, select_failover
from tests.conftest import make_settings
from tests.test_mcp_routes import _patched

SERVICE_KEY = "test-service-key-aaaaaaaaaaaaaaaaaaaa"
BASE = "http://gateway.test/v1"
UPSTREAMS = {
    "deepseek-v4-flash": "ollima-sidecar",
    "gpt-oss-120b": "ollima-sidecar",
    "gemini-3.7-flash-high": "antigravity",
    "gemini-3.8-flash-high": "antigravity",
    "grok-4.3": "xai",
}
LIMIT_BODY = (
    '{"error":{"message":"you (acct_x) have reached your session usage limit, '
    'upgrade for higher limits"}}'
)


class Clock:
    def __init__(self) -> None:
        self.t = 10_000.0
        self.w = 1_800_000_000.0

    def advance(self, seconds: float) -> None:
        self.t += seconds
        self.w += seconds


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    health.reset()
    monkeypatch.setattr(health, "_now", lambda: c.t)
    monkeypatch.setattr(health, "_wall", lambda: c.w)
    yield c
    health.reset()


def _settings(**over) -> Settings:
    return make_settings(
        "http://x",
        ollima_base_url=BASE,
        ollima_api_key="sk-ollima-test",
        **over,
    )


class Gateway:
    """Scripted Ollima: per-model queue of responses (int status, or an exception)."""

    def __init__(self) -> None:
        self.script: dict[str, list] = {}
        self.calls: list[str] = []
        self.models_status = 200

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            data = [{"id": k, "owned_by": v} for k, v in UPSTREAMS.items()]
            return httpx.Response(self.models_status, json={"data": data})
        model = json.loads(request.content)["model"]
        self.calls.append(model)
        queue = self.script.get(model) or [200]
        step = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(step, Exception):
            raise step
        if step == 200:
            return httpx.Response(200, json={"choices": [{"message": {"content": ""}}]})
        if isinstance(step, tuple):
            status, body, headers = step
            return httpx.Response(status, text=body, headers=headers)
        return httpx.Response(step, text=LIMIT_BODY if step == 429 else "err")

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))


def _req() -> httpx.Request:
    return httpx.Request("POST", f"{BASE}/chat/completions")


def _status_error(cls, status: int, text: str):
    return cls(
        text, response=httpx.Response(status, request=_req(), text=text), body=None
    )


# ------------------------------------------------------------ classification
def test_classification_by_status_and_request_phase():
    assert health.classify(
        _status_error(openai.RateLimitError, 429, LIMIT_BODY)
    ) == health.Failure(health.RATE_LIMITED, True)
    assert health.classify(
        _status_error(openai.InternalServerError, 503, "upstream down")
    ) == health.Failure(health.PROVIDER_ERROR, True)
    assert health.classify(openai.APITimeoutError(request=_req())) == health.Failure(
        health.TIMEOUT, True
    )
    assert health.classify(openai.APIConnectionError(request=_req())) == health.Failure(
        health.UNREACHABLE, True
    )
    # A refused REQUEST is not the model's fault.
    assert (
        health.classify(_status_error(openai.BadRequestError, 400, "bad schema"))
        is None
    )
    # A mid-stream transport error is recognised but NOT safe to fail over.
    assert health.classify(httpx.RemoteProtocolError("peer closed")) == health.Failure(
        health.UNREACHABLE, False
    )
    assert health.classify(IndexError("Tool call index out of bounds")) is None
    assert health.classify(ValueError("boom")) is None


def test_a_request_id_containing_429_is_not_a_quota_refusal():
    """A real grok response id was `02e025d9-429d-…`."""
    body = '{"id":"02e025d9-429d-9c90-811b-5cdb572dcea8","error":"upstream reset"}'
    assert health.classify_status(502, body) == health.PROVIDER_ERROR
    assert health.classify(
        _status_error(openai.InternalServerError, 502, body)
    ).kind == (health.PROVIDER_ERROR)
    # ...while a gateway-wrapped real refusal still is one.
    wrapped = "All variants failed: Error 429 Too Many Requests: weekly usage limit"
    assert health.classify_status(502, wrapped) == health.RATE_LIMITED


# ------------------------------------------------------------ state machine
async def test_429_cooldown_then_automatic_reprobe_restores_the_model(clock):
    settings = _settings()
    health.configure(settings)
    health.observe(["deepseek-v4-flash"])
    gw = Gateway()

    health.record_exception(
        "deepseek-v4-flash", _status_error(openai.RateLimitError, 429, LIMIT_BODY)
    )
    assert health.is_exhausted("deepseek-v4-flash")
    snap = {m["model"]: m for m in health.snapshot()}["deepseek-v4-flash"]
    assert snap["state"] == health.RATE_LIMITED and snap["available"] is False
    assert "acct_x" not in (snap["reason"] or ""), "account names are redacted"

    # Cooldown over, worker alive: still out until the worker has re-checked it,
    # so a user is not the recovery probe.
    clock.advance(601)
    health.mark_worker_tick()
    assert health.is_exhausted("deepseek-v4-flash")
    assert health.due_for_probe(limit=2, revalidate_s=1800) == ["deepseek-v4-flash"]

    async with gw.client() as client:
        results = await health_probe.tick(client, settings, {})
    assert results == [("deepseek-v4-flash", health.HEALTHY)]
    assert not health.is_exhausted("deepseek-v4-flash")
    assert health.snapshot()[0]["state"] == health.HEALTHY
    assert health.snapshot()[0]["provider"] == "ollima-sidecar"


async def test_a_reprobe_that_is_still_limited_backs_off_further(clock):
    settings = _settings()
    health.configure(settings)
    health.observe(["m"])
    gw = Gateway()
    gw.script["m"] = [429]
    health.mark_exhausted("m", 600)
    clock.advance(601)
    health.mark_worker_tick()
    async with gw.client() as client:
        assert await health_probe.probe(client, settings, "m") == health.RATE_LIMITED
    h = health._models["m"]
    assert h.consecutive_failures == 2
    assert round(h.retry_at - clock.t) == 1200, "second failure doubles the cooldown"


def test_backoff_doubles_per_failure_and_is_capped(clock):
    health.configure(_settings(ai_model_health_max_backoff_s=3000))
    for expected in (600, 1200, 2400, 3000, 3000):
        health.record_failure("m", health.RATE_LIMITED, "429")
        assert round(health._models["m"].retry_at - clock.t) == expected


def test_retry_after_is_honoured_within_the_cap(clock):
    health.configure(_settings())
    health.record_failure("m", health.RATE_LIMITED, "429", retry_after=42)
    assert round(health._models["m"].retry_at - clock.t) == 42


async def test_timeout_unreachable_5xx_and_unknown_model_are_distinct(clock):
    settings = _settings()
    health.configure(settings)
    gw = Gateway()
    gw.script = {
        "slow": [httpx.ReadTimeout("read timed out")],
        "gone": [httpx.ConnectError("connection refused")],
        "down": [503],
        "removed": [(502, '{"error":{"message":"unknown provider for model x"}}', {})],
        # Prod, grok-4.3 with its xai upstream down: the gateway answered 408.
        "stalled": [408],
    }
    health.observe(list(gw.script))
    async with gw.client() as client:
        outcomes = {m: await health_probe.probe(client, settings, m) for m in gw.script}
    assert outcomes == {
        "slow": health.TIMEOUT,
        "gone": health.UNREACHABLE,
        "down": health.PROVIDER_ERROR,
        "removed": health.PROVIDER_ERROR,
        "stalled": health.TIMEOUT,
    }
    assert all(health.is_exhausted(m) for m in gw.script)
    # Transient classes come back far sooner than a provider failure.
    assert health._models["slow"].retry_at - clock.t == 60
    assert health._models["down"].retry_at - clock.t == 3600


async def test_a_400_probe_is_inconclusive_and_never_benches_a_model(clock):
    settings = _settings()
    health.observe(["picky"])
    gw = Gateway()
    gw.script["picky"] = [400]
    async with gw.client() as client:
        assert await health_probe.probe(client, settings, "picky") == "inconclusive"
    assert not health.is_exhausted("picky")
    assert health._models["picky"].state == health.UNKNOWN
    assert health._models["picky"].last_checked_at is not None


async def test_upstreams_come_from_the_gateway_and_a_429_flags_its_siblings(clock):
    settings = _settings()
    health.configure(settings)
    health.observe(list(UPSTREAMS))
    gw = Gateway()
    async with gw.client() as client:
        assert await health_probe.refresh_upstreams(client, settings) == len(UPSTREAMS)
    for m in UPSTREAMS:  # everything freshly checked, nothing else due
        health.record_success(m)
    health.record_failure("deepseek-v4-flash", health.RATE_LIMITED, "429")
    # Same quota domain: re-checked soon, but NOT benched on a guess.
    assert not health.is_exhausted("gpt-oss-120b")
    assert health.due_for_probe(limit=5, revalidate_s=1800) == ["gpt-oss-120b"]
    assert "gemini-3.7-flash-high" not in health.due_for_probe(
        limit=5, revalidate_s=1800
    )


def test_a_dead_worker_fails_open(clock):
    health.configure(_settings())
    health.mark_exhausted("m", 600)
    clock.advance(601)
    # No worker has ever ticked: an expired cooldown lets the model back at once.
    assert not health.is_exhausted("m")
    # A worker that ticked, then stopped for longer than 3 intervals, is dead.
    health.mark_exhausted("n", 600)
    health.mark_worker_tick()
    clock.advance(601)
    assert not health.is_exhausted("n")


def test_the_post_cooldown_wait_for_a_probe_is_bounded(clock):
    health.configure(_settings())
    health.mark_exhausted("m", 600)
    clock.advance(601)
    health.mark_worker_tick()
    assert health.is_exhausted("m")
    clock.advance(119)
    health.mark_worker_tick()
    assert not health.is_exhausted("m"), "never more than 2 ticks past the cooldown"


def test_a_healthy_model_is_only_revalidated_without_recent_success(clock):
    health.observe(["busy", "idle"])
    health.record_success("busy")
    health.record_success("idle")
    clock.advance(1700)
    health.record_success("busy")  # real traffic
    clock.advance(200)
    assert health.due_for_probe(limit=5, revalidate_s=1800) == ["idle"]


def test_one_exception_is_counted_once(clock):
    exc = _status_error(openai.RateLimitError, 429, LIMIT_BODY)
    health.record_exception("m", exc)
    health.record_exception("m", exc)  # the runner seeing what the graph recorded
    assert health._models["m"].consecutive_failures == 1


async def test_quarantine_holds_against_traffic_and_a_real_probe_restores_it(clock):
    settings = _settings()
    health.configure(settings)
    health.observe(["gemini-3.7-flash-high"])
    assert health.quarantine("gemini-3.7-flash-high", 120)
    assert not health.quarantine("never-seen", 120), (
        "unknown ids never grow the registry"
    )
    health.record_success("gemini-3.7-flash-high")  # a lucky call must not lift it
    assert health.is_exhausted("gemini-3.7-flash-high")
    clock.advance(121)
    health.mark_worker_tick()
    gw = Gateway()
    async with gw.client() as client:
        results = await health_probe.tick(client, settings, {})
    assert results == [("gemini-3.7-flash-high", health.HEALTHY)]
    assert gw.calls == ["gemini-3.7-flash-high"], "restored by a REAL request"
    assert not health.is_exhausted("gemini-3.7-flash-high")


def test_a_stream_break_mark_expires(clock):
    health.mark_stream_broken("m")
    assert not health.streams_tool_calls_cleanly("m")
    clock.advance(health.STREAM_BROKEN_TTL_S + 1)
    assert health.streams_tool_calls_cleanly("m")


def test_the_registry_is_bounded(clock):
    health.observe([f"m{i}" for i in range(health.MAX_MODELS + 20)])
    assert len(health._models) == health.MAX_MODELS


# ------------------------------------------------------------ worker isolation
async def test_a_failing_worker_never_stops_itself_or_chat(clock, monkeypatch):
    """Every request the worker makes raises something unexpected; the loop keeps
    ticking and a chat turn running at the same time still answers."""
    from app.models.chat import ModelCandidate  # noqa: PLC0415
    from app.runtime.runner import run_generation  # noqa: PLC0415
    from tests.test_capability_parity import (  # noqa: PLC0415
        DEFAULT,
        GEMINI,
        RecordingConvex,
        _final,
        _patch_models,
        _req,
    )

    def explode(request):
        raise RuntimeError("worker bug")

    ticks = {"n": 0}
    real_sleep = asyncio.sleep

    async def fast_sleep(_s):
        ticks["n"] += 1
        await real_sleep(0)

    monkeypatch.setattr(health_probe.asyncio, "sleep", fast_sleep)
    health.observe([GEMINI, DEFAULT])
    client = httpx.AsyncClient(transport=httpx.MockTransport(explode))
    worker = asyncio.create_task(
        health_probe.run_health_probe(_settings(), client=client)
    )
    try:
        rec = _patch_models(monkeypatch, lambda m, s, n: AIMessage(content="answer"))
        convex = RecordingConvex()
        await run_generation(
            _req("What is a mutex?", [ModelCandidate(id=GEMINI, contextWindow=0)]),
            _settings(ai_router_enabled=True),
            convex,
        )
        for _ in range(50):
            if ticks["n"] >= 5:
                break
            await real_sleep(0)
        assert ticks["n"] >= 5, "the loop kept ticking through its own failures"
        assert not worker.done()
        assert _final(convex)["status"] == "done"
        assert [m for m, *_ in rec.calls] == [GEMINI]
    finally:
        worker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await worker
        await client.aclose()


async def test_upstreams_load_right_after_start_before_any_probe(clock, monkeypatch):
    """Failover independence needs the upstream map; it must not wait a whole
    probe interval after a restart, and loading it spends no model quota."""
    gw = Gateway()
    health.observe(["deepseek-v4-flash"])
    sleeps: list[float] = []
    parked = asyncio.Event()

    async def fake_sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) > 1:  # park at the first probe interval
            parked.set()
            await asyncio.Event().wait()

    monkeypatch.setattr(health_probe.asyncio, "sleep", fake_sleep)
    client = gw.client()
    worker = asyncio.create_task(
        health_probe.run_health_probe(_settings(), client=client)
    )
    try:
        await asyncio.wait_for(parked.wait(), timeout=5)
        assert sleeps[0] == health_probe._FIRST_UPSTREAMS_DELAY_S
        assert health.upstream_of("deepseek-v4-flash") == "ollima-sidecar"
        assert gw.calls == [], "no model was probed to learn upstreams"
    finally:
        worker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await worker
        await client.aclose()


async def test_lifespan_starts_and_cancels_the_worker_without_network():
    settings = _settings(
        ai_model_health_probe_enabled=True, ai_model_health_probe_interval_s=3600
    )
    app = create_app()
    with _patched(main_mod, "get_settings", lambda: settings):
        async with main_mod.lifespan(app):
            tasks = [
                t for t in asyncio.all_tasks() if t.get_name() == "model-health-probe"
            ]
            assert len(tasks) == 1 and not tasks[0].done()
        assert tasks[0].done()


async def test_lifespan_does_not_start_the_worker_when_disabled():
    settings = _settings(ai_model_health_probe_enabled=False)
    app = create_app()
    with _patched(main_mod, "get_settings", lambda: settings):
        async with main_mod.lifespan(app):
            assert not [
                t for t in asyncio.all_tasks() if t.get_name() == "model-health-probe"
            ]


# ------------------------------------------------------------ router integration
SHIPPED = RouterConfig.from_settings(True, Settings().ai_router_profiles)
CANDS = [Candidate(id=m) for m in UPSTREAMS]


def _failover(primary: str, floor: int, **over) -> str:
    return select_failover(
        cfg=SHIPPED,
        candidates=over.pop("candidates", CANDS),
        primary=primary,
        floor=floor,
        upstream_of=over.pop("upstream_of", health.upstream_of),
        is_available=lambda m: not health.is_exhausted(m),
        **over,
    )


def test_failover_picks_an_independent_upstream_that_meets_the_floor(clock):
    health.set_upstreams(UPSTREAMS)
    assert _failover("deepseek-v4-flash", 1) == "gemini-3.8-flash-high"
    assert _failover("gemini-3.7-flash-high", 0) == "deepseek-v4-flash"
    assert _failover("gemini-3.8-flash-high", 2) == "deepseek-v4-flash"


def test_failover_never_offers_the_same_upstream(clock):
    health.set_upstreams(UPSTREAMS)
    for m in ("gemini-3.7-flash-high", "gemini-3.8-flash-high", "grok-4.3"):
        health.mark_exhausted(m, 600)
    # Only gpt-oss-120b is left, and it shares deepseek's quota: nothing to try.
    assert _failover("deepseek-v4-flash", 1) == ""


def test_failover_skips_unavailable_and_uses_preference_only_as_tie_break(clock):
    health.set_upstreams(UPSTREAMS)
    health.mark_exhausted("gemini-3.8-flash-high", 600)
    assert _failover("deepseek-v4-flash", 1) == "gemini-3.7-flash-high"
    # A preferred model that is BELOW the floor never beats one that meets it...
    assert _failover("gemini-3.7-flash-high", 1, preferred="grok-4.3") == (
        "deepseek-v4-flash"
    )
    # ...but among models that all meet it, the preference decides.
    assert _failover("gemini-3.7-flash-high", 0, preferred="grok-4.3") == "grok-4.3"


def test_failover_with_unknown_upstreams_still_works(clock):
    assert _failover("deepseek-v4-flash", 1) == "gemini-3.8-flash-high"
    assert _failover("x", 0, candidates=[], preferred="gpt-oss-120b") == "gpt-oss-120b"


def test_the_router_drops_an_unhealthy_model_and_readmits_it_on_recovery(clock):
    # Shipped profiles (re-measured 2026-09-29): deepseek-v4-flash is the fastest
    # model meeting floor 0 for text; gemini-3.7-flash-high is next.
    cands = [Candidate(id="gemini-3.7-flash-high"), Candidate(id="deepseek-v4-flash")]
    sig = Signals(text="What is a mutex?")
    assert select(cfg=SHIPPED, candidates=cands, fallback="x", signals=sig).model == (
        "deepseek-v4-flash"
    )
    health.mark_exhausted("deepseek-v4-flash", 600)
    d = select(cfg=SHIPPED, candidates=cands, fallback="x", signals=sig)
    assert d.model == "gemini-3.7-flash-high" and d.floor == 0
    health.record_success("deepseek-v4-flash")  # probe or traffic success
    assert select(cfg=SHIPPED, candidates=cands, fallback="x", signals=sig).model == (
        "deepseek-v4-flash"
    )


# ------------------------------------------------------------ ops endpoints
@pytest.fixture
async def api(clock):
    app = create_app()
    app.state.settings = _settings()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def test_health_endpoints_require_the_service_key(api):
    assert (await api.get("/v1/models/health")).status_code in (401, 403)
    r = await api.post("/v1/models/health/m/quarantine", json={"seconds": 60})
    assert r.status_code in (401, 403)


async def test_health_snapshot_and_quarantine_endpoint(api):
    headers = {"x-service-key": SERVICE_KEY}
    health.observe(["gemini-3.7-flash-high"])
    body = (await api.get("/v1/models/health", headers=headers)).json()
    assert [m["model"] for m in body["models"]] == ["gemini-3.7-flash-high"]
    assert set(body["worker"]) == {"alive", "last_tick_age_s"}

    bad = await api.post(
        "/v1/models/health/gemini-3.7-flash-high/quarantine",
        headers=headers,
        json={"seconds": 5},
    )
    assert bad.status_code == 422, "bounded: 30-3600s"
    unknown = await api.post(
        "/v1/models/health/nope/quarantine", headers=headers, json={"seconds": 60}
    )
    assert unknown.status_code == 404
    ok = await api.post(
        "/v1/models/health/gemini-3.7-flash-high/quarantine",
        headers=headers,
        json={"seconds": 60},
    )
    assert ok.status_code == 200
    assert ok.json()["model"]["state"] == health.QUARANTINE
    assert health.is_exhausted("gemini-3.7-flash-high")
