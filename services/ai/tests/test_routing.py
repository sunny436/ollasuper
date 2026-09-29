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
    assert classify(Signals(text="fix it")).grounded is False


def test_a_standing_corpus_does_not_ground_every_turn(cfg):
    """Caught on PROD, not here: this assertion originally demanded the
    opposite. Any account with uploaded files has rag_files > 0 on EVERY turn,
    so counting it as grounding marked all of them grounded — and "hi" left the
    fast path onto a reasoner. Availability is not need."""
    assert classify(Signals(text="fix it", rag_files=3)).grounded is False


@pytest.mark.parametrize("q", ["hi", "thanks!", "what's 15% of 240"])
def test_trivial_stays_fast_even_with_a_corpus_attached(cfg, q):
    assert _tier(cfg, q, rag_files=5) == 0, f"left the fast path with a corpus: {q!r}"


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


def _p99(fn, n=2000, rounds=3) -> float:
    """The best P99 of `rounds` passes. A wall-clock P99 measures the scheduler
    as much as the code: with a parallel suite and a browser on the same box
    the single-pass P99 of the 48k-char case read 3455us (measured 2026-09-15)
    and 200us alone. A regex regression inflates EVERY pass; scheduler noise
    inflates some — so the minimum keeps the 1ms bound meaningful."""
    best = None
    for _ in range(rounds):
        xs = []
        for _ in range(n):
            t = time.perf_counter()
            fn()
            xs.append(time.perf_counter() - t)
        xs.sort()
        p99 = xs[int(n * 0.99)]
        best = p99 if best is None else min(best, p99)
    return best


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


# ===========================================================================
# THE SHIPPED CONFIGURATION
#
# Everything above tests the ALGORITHM against a synthetic fixture, and
# deliberately asserts on tiers rather than model ids so re-benchmarking cannot
# break it. This block does the opposite job: it pins the roster that actually
# ships, because the tier->model mapping is a product decision ("simple goes to
# gemini-3.7") and nothing else in the suite would notice if a profile edit
# silently inverted it.
#
# The profiles used to live only in the VM's .env, where no test could reach
# them and they drifted out of step with the Convex catalogue unseen. They are
# now a default in app/config.py, and this is what binds them to the rules.
# ===========================================================================
SIMPLE_MODEL = "gemini-3.7-flash-high"
MODERATE_MODEL = "deepseek-v4-flash"
HEAVY_MODEL = "gemini-3.8-flash-high"
SHIPPED = [
    Candidate(SIMPLE_MODEL, 0),
    Candidate(MODERATE_MODEL, 131_072),
    Candidate(HEAVY_MODEL, 0),
]


@pytest.fixture
def shipped() -> RouterConfig:
    """The real profiles, parsed exactly as production parses them."""
    from app.config import Settings

    cfg = RouterConfig.from_settings(True, Settings().ai_router_profiles)
    assert cfg.enabled, "the shipped profiles must parse"
    return cfg


def _ship_decision(shipped, text, candidates=None, **kw):
    return select(
        cfg=shipped,
        candidates=SHIPPED if candidates is None else candidates,
        fallback=MODERATE_MODEL,
        signals=Signals(text=text, **kw),
    )


def _ship(shipped, text, candidates=None, **kw):
    return _ship_decision(shipped, text, candidates, **kw).model


def _ship_floor(shipped, text, **kw):
    return _ship_decision(shipped, text, **kw).floor


def test_the_shipped_roster_is_exactly_three_models_one_per_tier(shipped):
    assert set(shipped.profiles) == {SIMPLE_MODEL, MODERATE_MODEL, HEAVY_MODEL}
    assert shipped.profiles[SIMPLE_MODEL].reasoning_tier == SIMPLE
    assert shipped.profiles[MODERATE_MODEL].reasoning_tier == MODERATE
    assert shipped.profiles[HEAVY_MODEL].reasoning_tier == HEAVY


def test_the_ttft_ordering_is_what_makes_the_tie_break_correct(shipped):
    """select() takes the lowest TTFT among models meeting the floor, so this
    ordering IS the routing. Re-measured on production 2026-09-29 (no-tool TTFT
    p50: 0.9 / 2.4 / 3.2 s) the moderate model is the fastest, so text work at
    BOTH lower floors goes to it (image turns are promoted to the heavy model
    either way). If a re-benchmark inverts this, it fails HERE with the reason."""
    ttft = {m: p.ttft_s for m, p in shipped.profiles.items()}
    assert ttft[MODERATE_MODEL] < ttft[SIMPLE_MODEL] < ttft[HEAVY_MODEL]


@pytest.mark.parametrize(
    "text",
    [
        "what is a connection pool",
        "who wrote the raft paper",
        "translate this to french: the build is broken",
        "summarize the release notes",
    ],
)
def test_simple_work_routes_to_the_speed_first_model(shipped, text):
    assert _ship(shipped, text) == MODERATE_MODEL


@pytest.mark.parametrize(
    "text",
    [
        "write a onboarding email for new customers",
        "draft a changelog entry for the caching work",
        "build me a regex that matches semver",
    ],
)
def test_moderate_work_routes_to_the_balanced_model(shipped, text):
    assert _ship(shipped, text) == MODERATE_MODEL


@pytest.mark.parametrize(
    "text",
    [
        "do a ultra deep audit",
        "why does the nightly job keep dying",
        "compare postgres and mysql for our workload and recommend one",
        "walk me through the risks of this migration",
        "figure out what is making checkout slow",
    ],
)
def test_deep_work_routes_to_the_quality_first_model(shipped, text):
    assert _ship(shipped, text) == HEAVY_MODEL


def test_structural_signals_promote_without_any_keyword(shipped):
    """An attachment or a stack of open loops is evidence no paraphrase can
    remove, so it must lift a bland request off the fast model."""
    # A bland phrase with no action verb in it at all — "have a look at this"
    # would NOT do, because it matches the analytic taxonomy and is already
    # heavy before any structural signal is added.
    bland = "here are the notes"
    # The fastest text model already serves floors 0 and 1, so the promotion is
    # asserted on the FLOOR it produces rather than on the model id.
    assert _ship_floor(shipped, bland) == SIMPLE
    assert _ship_floor(shipped, bland, has_document=True) >= MODERATE
    assert _ship_floor(shipped, bland, open_loops=2) >= MODERATE
    assert _ship(shipped, bland, has_document=True) == MODERATE_MODEL
    # An image promotes the CLASSIFICATION the same way, but the moderate model
    # cannot take images, so the promotion is served by the vision-capable model
    # at that floor. This line used to assert MODERATE_MODEL, which is precisely
    # the production failure: the provider answered 400 for every image.
    assert classify(Signals(text=bland, has_image=True), 1200).reasoning >= MODERATE
    assert shipped.profiles[_ship(shipped, bland, has_image=True)].vision


def test_a_fetching_turn_goes_to_a_model_that_converges(shipped):
    """deepseek is the fastest first token and the worst tool loop: on grounded
    turns it took 11 steps / 235 s p50 against gemini-3.7's 3 steps / 19 s, and
    shipped without this rule it searched for five minutes on a news question.
    A turn that fetches keeps to models marked agentic, at every floor."""
    assert not shipped.profiles[MODERATE_MODEL].agentic
    simple = _ship_decision(shipped, "what is the latest stable python release")
    assert (simple.model, simple.floor) == (SIMPLE_MODEL, SIMPLE)
    moderate = _ship_decision(shipped, "write a short summary of today's AI news")
    assert (moderate.model, moderate.floor) == (HEAVY_MODEL, MODERATE)
    assert _ship(shipped, "check https://example.com/pricing") != MODERATE_MODEL


def test_a_self_contained_turn_keeps_the_fastest_model(shipped):
    # The agentic rule must not cost the no-tool turns their speed.
    assert _ship(shipped, "what is a mutex") == MODERATE_MODEL
    assert _ship(shipped, "write a onboarding email for new customers") == (
        MODERATE_MODEL
    )


def test_an_attached_document_is_not_a_tool_loop(shipped):
    # Grounded, but its text arrives inline: routed as self-contained work.
    bland = "here are the notes"
    assert classify(Signals(text=bland, has_document=True)).fetches is False
    assert _ship(shipped, bland, has_document=True) == MODERATE_MODEL


def test_a_fetching_turn_is_still_answered_when_only_a_looping_model_is_up(shipped):
    only = [c for c in SHIPPED if c.id == MODERATE_MODEL]
    assert _ship(shipped, "what is the latest stable python release", only) == (
        MODERATE_MODEL
    )


def test_agentic_defaults_to_true_for_an_unmarked_profile():
    cfg = RouterConfig.from_settings(
        True, '{"a": {"ttft_s": 1}, "b": {"ttft_s": 2, "agentic": false}}'
    )
    assert cfg.profiles["a"].agentic is True
    assert cfg.profiles["b"].agentic is False


def test_the_speed_preference_leans_but_never_overrides(shipped):
    """responseSpeed controls answer LENGTH by contract, so it may nudge a tier
    and must not redefine capability."""
    assert (
        _ship(shipped, "do a ultra deep audit", response_speed="fast") == MODERATE_MODEL
    )
    assert (
        _ship(shipped, "what is a mutex", response_speed="thorough") == MODERATE_MODEL
    )


# ---------------------------------------------------- the emergency models
#
# The catalogue also carries two UNPROFILED models. Their absence from the
# profiles IS the mechanism: select() falls back to ModelProfile() — ttft 99s,
# tier 0 — so they lose at floor 0 and are excluded above it, and become
# reachable only through the "nothing meets the floor" branch.
EMERGENCY = [Candidate("gpt-oss-120b", 0), Candidate("grok-4.3", 0)]


def test_an_unprofiled_model_never_wins_while_a_primary_is_healthy(shipped):
    everything = SHIPPED + EMERGENCY
    for text in ("what is a mutex", "write a changelog", "do a ultra deep audit"):
        assert _ship(shipped, text, candidates=everything) in {
            SIMPLE_MODEL,
            MODERATE_MODEL,
            HEAVY_MODEL,
        }


def test_an_unprofiled_model_answers_when_every_primary_is_down(shipped):
    """The reason they are in the catalogue at all: three simultaneous outages
    would otherwise leave nothing to dispatch."""
    for m in (SIMPLE_MODEL, MODERATE_MODEL, HEAVY_MODEL):
        health.mark_exhausted(m, 600)
    chosen = _ship(shipped, "do a ultra deep audit", candidates=SHIPPED + EMERGENCY)
    assert chosen in {"gpt-oss-120b", "grok-4.3"}


def test_a_turn_too_large_for_the_balanced_model_moves_up_not_down(shipped):
    """deepseek-v4-flash has a MEASURED 131k window; the Geminis are unmeasured
    (0 = unknown, never disqualifying). A turn past 131k must not fall back to
    the fast model — capability before speed."""
    huge = "x" * (140_000 * 4)
    assert _ship(shipped, huge) == HEAVY_MODEL


def test_the_python_default_model_is_one_of_the_shipped_three():
    """It is the fallback when routing is off or errors, and what Convex's
    DEFAULT_MODEL must agree with; a default outside the catalogue dispatches a
    model the provider no longer serves."""
    from app.config import Settings

    assert Settings().ai_default_model == MODERATE_MODEL


# --------------------------------------------------------------- image turns
# Production: an image attachment routed to the text-only moderate model and the
# provider answered 400 "this model does not support image input", which reached
# the user as "Something went wrong". Capability comes before latency, so an
# image turn may only land on a model that accepts images.


def test_an_image_turn_never_routes_to_a_text_only_model(shipped):
    assert shipped.profiles[MODERATE_MODEL].vision is False
    for text in ("what is this", "describe the attached screenshot", "read this"):
        chosen = _ship(shipped, text, has_image=True)
        assert shipped.profiles[chosen].vision, f"{text!r} -> {chosen}"


def test_an_image_turn_pays_for_the_cheapest_model_that_can_actually_see(shipped):
    """An image promotes the turn to MODERATE, and of the two vision-capable
    models only the heavy one meets that floor — so image turns cost ~2.3s more
    TTFT than a plain question. That is the existing "capability before speed"
    rule applied to a capability that was previously unmodelled; the alternative
    is the 400 that shipped."""
    chosen = _ship(shipped, "what is in this picture", has_image=True)
    assert chosen == HEAVY_MODEL
    assert shipped.profiles[chosen].vision


def test_a_text_turn_is_unaffected_by_the_vision_filter(shipped):
    assert _ship(shipped, "summarise the attached notes", has_document=True) == (
        MODERATE_MODEL
    )


def test_the_shortfall_is_recorded_when_nothing_takes_images(shipped):
    """Every candidate text-only: the turn is still answered, and says so."""
    only_text = [c for c in SHIPPED if c.id == MODERATE_MODEL]
    d = select(
        cfg=shipped,
        candidates=only_text,
        fallback=MODERATE_MODEL,
        signals=Signals(text="what is this", has_image=True),
    )
    assert d.model == MODERATE_MODEL
    assert "vision_unmet" in d.reason


def test_an_image_turn_does_not_fail_over_to_a_text_only_model(shipped):
    from app.routing import select_failover

    target = select_failover(
        cfg=shipped,
        candidates=SHIPPED,
        primary=SIMPLE_MODEL,
        floor=SIMPLE,
        upstream_of=lambda m: "",
        is_available=lambda m: True,
        needs_vision=True,
    )
    assert target == HEAVY_MODEL, target


def test_a_profile_without_the_vision_key_is_not_excluded():
    """Profiles written before this field existed must keep routing."""
    cfg = RouterConfig.from_settings(
        True, '{"m": {"ttft_s": 1.0, "tok_per_s": 10, "reasoning_tier": 0}}'
    )
    assert cfg.profiles["m"].vision is True
