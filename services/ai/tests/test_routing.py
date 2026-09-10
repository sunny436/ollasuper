"""Master Model Router — the routing policy is pure, so this needs no network.

The latency assertion at the bottom is not decoration: the router sits on the
pre-first-token path of every chat turn, so a regression that made it do I/O
would be felt by every user as a slower assistant. A unit test is the only place
that catches it before production.
"""

from __future__ import annotations

import time

import pytest

from app.agent import health
from app.routing import Candidate, ModelProfile, RouterConfig, select

PROFILES = (
    '{"qwen3.5":       {"ttft_s": 0.72, "tok_per_s": 122, "reasoning_tier": 0},'
    ' "gpt-oss-120b":  {"ttft_s": 0.94, "tok_per_s": 151, "reasoning_tier": 0},'
    ' "deepseek-v4-pro":{"ttft_s": 1.62,"tok_per_s": 112, "reasoning_tier": 1},'
    ' "glm-5.2":       {"ttft_s": 7.03, "tok_per_s": 104, "reasoning_tier": 2}}'
)

ALL = [
    Candidate("qwen3.5", 0),
    Candidate("gpt-oss-120b", 0),
    Candidate("deepseek-v4-pro", 0),
    Candidate("glm-5.2", 0),
]
FALLBACK = "deepseek-v4-flash"


@pytest.fixture(autouse=True)
def _clean_health():
    health.reset()
    yield
    health.reset()


@pytest.fixture
def cfg() -> RouterConfig:
    return RouterConfig.from_settings(True, PROFILES)


def _sel(cfg, candidates=None, prompt=20, history=0, fallback=FALLBACK):
    return select(
        cfg=cfg,
        candidates=ALL if candidates is None else candidates,
        fallback=fallback,
        prompt_chars=prompt,
        history_chars=history,
    )


# --- the two classes -------------------------------------------------------


def test_simple_turn_picks_the_fastest_model(cfg):
    """A short question must not wait on a heavy reasoner."""
    assert _sel(cfg).model == "qwen3.5"


def test_heavy_turn_picks_the_deepest_reasoner(cfg):
    """A long turn is worth waiting for; TTFT stops being the objective."""
    d = _sel(cfg, prompt=9_000, history=9_000)
    assert d.model == "glm-5.2"
    assert d.reason.startswith("heavy:")


def test_history_alone_can_make_a_turn_heavy(cfg):
    """A one-line question in a long conversation is still a large turn."""
    assert _sel(cfg, prompt=20, history=40_000).model == "glm-5.2"


# --- hard filters come before speed ---------------------------------------


def test_exhausted_model_is_never_selected(cfg):
    health.mark_exhausted("qwen3.5", 600)
    assert _sel(cfg).model == "gpt-oss-120b"


def test_falls_back_when_every_candidate_is_exhausted(cfg):
    for c in ALL:
        health.mark_exhausted(c.id, 600)
    d = _sel(cfg)
    assert d.model == FALLBACK
    assert d.reason == "all_filtered"


def test_known_window_too_small_is_excluded(cfg):
    """A window we MEASURED and that cannot hold the turn disqualifies."""
    small = [Candidate("qwen3.5", 100), Candidate("gpt-oss-120b", 0)]
    # ~5000 estimated tokens, far past qwen's declared 100.
    assert _sel(cfg, candidates=small, prompt=20_000).model == "gpt-oss-120b"


def test_unknown_window_is_never_treated_as_too_small(cfg):
    """0 means NOT MEASURED. Excluding on it would drop 7 of 8 real models."""
    unknown = [Candidate("qwen3.5", 0)]
    assert _sel(cfg, candidates=unknown, prompt=500_000).model == "qwen3.5"


# --- fallback is total -----------------------------------------------------


def test_disabled_router_returns_the_requested_model():
    off = RouterConfig.from_settings(False, PROFILES)
    d = _sel(off)
    assert d.model == FALLBACK
    assert d.reason == "disabled"


def test_empty_candidates_returns_the_requested_model(cfg):
    """The old-Convex path: no candidates in the payload at all."""
    d = _sel(cfg, candidates=[])
    assert d.model == FALLBACK
    assert d.reason == "no_candidates"


def test_malformed_profiles_disable_the_router_rather_than_failing():
    bad = RouterConfig.from_settings(True, "{ not json at all")
    assert bad.enabled is False
    assert _sel(bad).model == FALLBACK


def test_empty_profiles_disable_the_router():
    assert RouterConfig.from_settings(True, "{}").enabled is False


def test_unprofiled_candidate_never_beats_a_profiled_one(cfg):
    """An unknown model gets the pessimistic default, so it cannot win on speed."""
    mixed = [Candidate("brand-new-model", 0), Candidate("qwen3.5", 0)]
    assert _sel(cfg, candidates=mixed).model == "qwen3.5"


def test_unprofiled_candidate_is_still_selectable_when_alone(cfg):
    """Pessimistic ordering must not mean 'never usable'."""
    assert _sel(cfg, candidates=[Candidate("brand-new-model", 0)]).model == (
        "brand-new-model"
    )


# --- the latency contract --------------------------------------------------


def test_routing_stays_far_inside_its_latency_budget(cfg):
    """Budget: P99 < 1ms. Measured ~9us, so this fails only on real regression.

    The threshold is deliberately 1ms and not 20us: this asserts the ORDER OF
    MAGNITUDE (no I/O crept in), not the exact speed of the CI machine.
    """
    samples = []
    for _ in range(2000):
        t = time.perf_counter()
        select(
            cfg=cfg,
            candidates=ALL,
            fallback=FALLBACK,
            prompt_chars=200,
            history_chars=4000,
        )
        samples.append(time.perf_counter() - t)
    samples.sort()
    p99 = samples[int(len(samples) * 0.99)]
    assert p99 < 1e-3, f"router P99 {p99 * 1e6:.0f}us exceeds the 1ms budget"


def test_profile_defaults_are_pessimistic():
    """An unmeasured model must not look fast by accident."""
    p = ModelProfile()
    assert p.ttft_s > 10
    assert p.reasoning_tier == 0
