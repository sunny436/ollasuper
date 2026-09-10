"""Master Model Router — the routing policy is pure, so this needs no network.

Two things here are not ordinary unit tests and should not be deleted as noise:

  * the LATENCY bound, because the router sits on the pre-first-token path of
    every chat turn and a regression that made it do I/O — or reintroduced a
    backtracking pattern — would be felt by every user as a slower assistant;
  * the PARAPHRASE set, because a router validated only on the prompts it was
    designed against proves nothing. Those cases are deliberately written to
    avoid the taxonomy's own vocabulary. Never "fix" a failing paraphrase by
    adding its exact words to the lexicon: that is how work-type classification
    quietly degenerates back into keyword matching, which is the bug this
    module exists to replace.
"""

from __future__ import annotations

import time

import pytest

from app.agent import health
from app.routing import (
    HEAVY,
    MODERATE,
    SIMPLE,
    Candidate,
    ModelProfile,
    RouterConfig,
    Signals,
    classify,
    select,
)

# Seeded from the measured benchmark. n=1 per model — enough to ORDER them, not
# ground truth, which is why the real thing is config.
PROFILES = (
    '{"qwen3.5":         {"ttft_s": 0.72, "tok_per_s": 122, "reasoning_tier": 0},'
    ' "gpt-oss-120b":    {"ttft_s": 0.94, "tok_per_s": 151, "reasoning_tier": 0},'
    ' "deepseek-v4-pro": {"ttft_s": 1.62, "tok_per_s": 112, "reasoning_tier": 1},'
    ' "deepseek-v4-flash":{"ttft_s": 4.88,"tok_per_s": 201, "reasoning_tier": 2},'
    ' "glm-5.2":         {"ttft_s": 7.03, "tok_per_s": 104, "reasoning_tier": 2}}'
)

ALL = [
    Candidate("qwen3.5", 0),
    Candidate("gpt-oss-120b", 0),
    Candidate("deepseek-v4-pro", 0),
    Candidate("deepseek-v4-flash", 0),
    Candidate("glm-5.2", 0),
]
TIER = {
    "qwen3.5": 0,
    "gpt-oss-120b": 0,
    "deepseek-v4-pro": 1,
    "deepseek-v4-flash": 2,
    "glm-5.2": 2,
}
FALLBACK = "deepseek-v4-flash"


@pytest.fixture(autouse=True)
def _clean_health():
    health.reset()
    yield
    health.reset()


@pytest.fixture
def cfg() -> RouterConfig:
    return RouterConfig.from_settings(True, PROFILES)


def _route(cfg, text="", candidates=None, **kw):
    return select(
        cfg=cfg,
        candidates=ALL if candidates is None else candidates,
        fallback=FALLBACK,
        signals=Signals(text=text, **kw),
    )


def _tier(cfg, text, **kw) -> int:
    """The reasoning tier actually selected — assert on this, never on a model
    id, so re-benchmarking the profiles cannot break the suite."""
    return TIER[_route(cfg, text, **kw).model]


# ---------------------------------------------------------------------------
# THE REGRESSION FIXTURES. Verbatim from the two conversations a real user ran.
# Every one is 21-82 characters, and under the original length-based policy all
# five routed to qwen3.5 — the FASTEST and WEAKEST model in the catalogue.
# ---------------------------------------------------------------------------

REAL_USER_PROMPTS = [
    "deep audit this website https://ollanode.com/",
    "i want the ultra deep seo audit",
    "do a deep SEO audit of this website https://www.networkershome.com/",
    "do a ultra deep audit",
    "make a deep marketing  stratigies of this website or product https://ollanode.com/",
]


@pytest.mark.parametrize("q", REAL_USER_PROMPTS)
def test_real_user_prompts_are_heavy(cfg, q):
    assert classify(Signals(text=q)).reasoning == HEAVY
    assert _tier(cfg, q) == 2, f"routed below tier 2: {q!r}"


def test_real_prompts_are_all_short(cfg):
    """The point of the fixtures: length carries no information here."""
    assert all(len(q) < 100 for q in REAL_USER_PROMPTS)


# ---------------------------------------------------------------------------
# GENERALISATION. Held-out paraphrases, written to avoid the taxonomy's words —
# no "audit", no "deep", no "analyze". If these only pass because their exact
# phrasing was added to a lexicon, the test is worthless.
# ---------------------------------------------------------------------------

HEAVY_PARAPHRASES = [
    "go through this site and tell me everything hurting our rankings",
    "what's likely to break when we put this in front of real traffic",
    "I need to understand why our numbers dropped last quarter",
    "walk me through the risks before we commit to this",
    "tell me which of these two ways is safer long term",
    "is there anything here that would embarrass us in a security review",
    "figure out why the job keeps dying after about an hour",
    "help me pick between Postgres and Mongo for this workload",
    "what would you change before we ship this to customers",
    "our checkout is slow, work out why",
]


@pytest.mark.parametrize("q", HEAVY_PARAPHRASES)
def test_held_out_paraphrases_reach_the_reasoner(cfg, q):
    assert _tier(cfg, q) == 2, f"paraphrase routed below tier 2: {q!r}"


# ---------------------------------------------------------------------------
# THE FAST PATH. The win must not cost trivial turns their latency.
# ---------------------------------------------------------------------------

TRIVIAL = [
    "hi",
    "hello there",
    "thanks!",
    "what's 15% of 240",
    "name a primary colour",
    "who is the CEO of Microsoft",
    "what time is it in Tokyo",
    "what does audit mean",
    "summarise this article",
    "translate this audit report to French",
]


@pytest.mark.parametrize("q", TRIVIAL)
def test_trivial_requests_stay_on_the_fast_model(cfg, q):
    assert _tier(cfg, q) == 0, f"trivial request left the fast path: {q!r}"


def test_a_long_input_with_trivial_work_stays_simple(cfg):
    """The case length routing gets exactly backwards: a 5,000-word rewrite is
    a large INPUT and trivial WORK."""
    q = "rewrite this in plainer English: " + ("word " * 1000)
    assert classify(Signals(text=q)).reasoning == SIMPLE
    assert _tier(cfg, q) == 0


def test_an_analytic_word_in_the_object_does_not_make_it_analysis(cfg):
    """The head verb governs. 'translate this audit report' is a translation."""
    c = classify(Signals(text="translate this audit report to French"))
    assert c.work == "transform"
    assert c.reasoning == SIMPLE


def test_a_definitional_opener_is_a_lookup(cfg):
    c = classify(Signals(text="what does audit mean"))
    assert c.work == "retrieve"
    assert c.reasoning == SIMPLE


def test_a_question_opener_does_not_hide_a_real_question(cfg):
    """...but an interrogative WRAPS rather than governs: a long 'what's ...'
    question about failure is analysis, not a lookup."""
    c = classify(
        Signals(text="what's likely to break when we put this in front of real traffic")
    )
    assert c.reasoning == HEAVY


# ---------------------------------------------------------------------------
# THE TWO AXES
# ---------------------------------------------------------------------------


def test_grounding_is_detected_without_any_lexical_cue(cfg):
    """Structural facts survive any paraphrase."""
    assert classify(Signals(text="fix it", has_document=True)).grounded is True
    assert classify(Signals(text="fix it", rag_files=3)).grounded is True
    assert classify(Signals(text="fix it")).grounded is False


def test_a_url_marks_the_turn_grounded(cfg):
    assert classify(Signals(text="check https://example.com/pricing")).grounded is True


def test_structural_signals_raise_reasoning_with_no_keywords(cfg):
    """'fix it' says nothing, but an attached document is real work."""
    assert classify(Signals(text="fix it")).reasoning == SIMPLE
    assert classify(Signals(text="fix it", has_document=True)).reasoning >= MODERATE
    assert classify(Signals(text="fix it", open_loops=2)).reasoning >= MODERATE


def test_grounding_never_lowers_the_capability_floor(cfg):
    """A grounded turn runs many steps and pays TTFT on each, but that must
    never buy a weaker model than the work needs."""
    grounded = classify(Signals(text="deep audit this site https://x.com"))
    self_contained = classify(Signals(text="deep audit of the design I described"))
    assert grounded.reasoning == HEAVY
    assert self_contained.reasoning == HEAVY
    assert _tier(cfg, "deep audit this site https://x.com") == 2


# ---------------------------------------------------------------------------
# CAPABILITY BEFORE SPEED
# ---------------------------------------------------------------------------


def test_a_heavy_turn_never_takes_a_faster_weaker_model(cfg):
    d = _route(cfg, "do a ultra deep audit")
    assert TIER[d.model] == 2
    # ...and within the capable set the cheapest start wins: TTFT is paid per
    # step, so 4.88s beats 7.03s even though both are tier 2.
    assert d.model == "deepseek-v4-flash"


def test_when_nothing_meets_the_floor_it_takes_the_best_available(cfg):
    """Degrade to the deepest model on offer, never silently to the fastest."""
    weak = [Candidate("qwen3.5", 0), Candidate("deepseek-v4-pro", 0)]
    d = _route(cfg, "do a ultra deep audit", candidates=weak)
    assert d.model == "deepseek-v4-pro"


def test_an_exhausted_model_is_never_selected(cfg):
    health.mark_exhausted("deepseek-v4-flash", 600)
    assert _route(cfg, "do a ultra deep audit").model == "glm-5.2"


def test_a_known_window_too_small_is_excluded(cfg):
    small = [Candidate("qwen3.5", 100), Candidate("gpt-oss-120b", 0)]
    assert _route(cfg, "hi" * 20_000, candidates=small).model == "gpt-oss-120b"


def test_an_unknown_window_is_never_treated_as_too_small(cfg):
    """0 means NOT MEASURED, and 7 of 8 real models have it."""
    one = [Candidate("qwen3.5", 0)]
    assert _route(cfg, "x" * 500_000, candidates=one).model == "qwen3.5"


# ---------------------------------------------------------------------------
# USER PREFERENCE — a nudge, never an override
# ---------------------------------------------------------------------------


def test_thorough_lifts_and_fast_lowers(cfg):
    base = classify(Signals(text="write a function to parse a CSV"))
    fast = classify(
        Signals(text="write a function to parse a CSV", response_speed="fast")
    )
    thorough = classify(
        Signals(text="write a function to parse a CSV", response_speed="thorough")
    )
    assert fast.reasoning <= base.reasoning <= thorough.reasoning


def test_fast_cannot_strip_capability_from_heavy_work(cfg):
    """responseSpeed controls answer LENGTH today; it may lean the decision but
    must not send a deep request to the weakest model."""
    c = classify(Signals(text="do a ultra deep audit", response_speed="fast"))
    assert c.reasoning >= MODERATE


# ---------------------------------------------------------------------------
# FALLBACK IS TOTAL
# ---------------------------------------------------------------------------


def test_disabled_router_returns_the_requested_model():
    off = RouterConfig.from_settings(False, PROFILES)
    d = _route(off, "do a ultra deep audit")
    assert d.model == FALLBACK and d.reason == "disabled"


def test_empty_candidates_returns_the_requested_model(cfg):
    d = _route(cfg, "anything", candidates=[])
    assert d.model == FALLBACK and d.reason == "no_candidates"


def test_all_exhausted_returns_the_requested_model(cfg):
    for c in ALL:
        health.mark_exhausted(c.id, 600)
    assert _route(cfg, "do a ultra deep audit").reason == "all_filtered"


def test_malformed_profiles_disable_rather_than_fail():
    assert RouterConfig.from_settings(True, "{ not json").enabled is False
    assert RouterConfig.from_settings(True, "{}").enabled is False


def test_unprofiled_candidate_never_wins_on_speed(cfg):
    """An unmeasured model gets the pessimistic default, so it cannot look fast."""
    mixed = [Candidate("brand-new", 0), Candidate("qwen3.5", 0)]
    assert _route(cfg, "hi", candidates=mixed).model == "qwen3.5"


def test_profile_defaults_are_pessimistic():
    p = ModelProfile()
    assert p.ttft_s > 10 and p.reasoning_tier == 0


# ---------------------------------------------------------------------------
# THE LATENCY CONTRACT
# ---------------------------------------------------------------------------


def _p99(fn, n=2000) -> float:
    xs = []
    for _ in range(n):
        t = time.perf_counter()
        fn()
        xs.append(time.perf_counter() - t)
    xs.sort()
    return xs[int(n * 0.99)]


def test_routing_stays_inside_its_latency_budget(cfg):
    p99 = _p99(lambda: _route(cfg, "do a ultra deep audit", history_chars=4000))
    assert p99 < 1e-3, f"router P99 {p99 * 1e6:.0f}us exceeds the 1ms budget"


def test_the_worst_case_input_also_fits_the_budget(cfg):
    """A 48k-char paste is the ai_max_turn_chars ceiling AND the worst case for
    the scanner: no signal anywhere, so every branch is retried at every
    position. An earlier `(?:\\w+\\s+){0,3}` here measured 2.7ms — catastrophic
    backtracking on user-controlled text. The edge window is what bounds it.
    """
    huge = "audit this " + ("token " * 9000)
    assert len(huge) > 48_000
    p99 = _p99(lambda: _route(cfg, huge), n=1000)
    assert p99 < 1e-3, f"48k-char turn P99 {p99 * 1e6:.0f}us exceeds the 1ms budget"


def test_cost_does_not_grow_with_input_size(cfg):
    """The bound is the point: a huge turn must not cost proportionally more."""
    short = _p99(lambda: _route(cfg, "do a ultra deep audit"), n=1000)
    huge = _p99(lambda: _route(cfg, "audit this " + ("token " * 9000)), n=1000)
    assert huge < short * 20, f"short={short * 1e6:.0f}us huge={huge * 1e6:.0f}us"
