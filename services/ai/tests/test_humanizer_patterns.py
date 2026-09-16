"""The detector: does it see each AI tell, does it leave protected text alone,
and is it fast enough to run on every writing turn?

Hermetic and exact. The taxonomy comes from `blader/humanizer` v3.0.0 (MIT), so
each test names the pattern it pins; if a phrase list is edited, the pattern it
belongs to keeps its own test.
"""

from __future__ import annotations

import time

import pytest

from app.humanizer.patterns import (
    DEFAULT_THRESHOLD,
    analyze,
    human_voice_score,
    profile,
    protected_spans,
)


def _ids(text: str, **kw) -> set[str]:
    findings, _ = analyze(text, **kw)
    return {f.pattern for f in findings}


# --------------------------------------------------------------- A: staging
@pytest.mark.parametrize(
    ("pattern", "text"),
    [
        ("A1", "This is not just a database but a new way to think about state."),
        ("A2", "The migration finished ahead of schedule.\n\nLet that sink in.\n"),
        ("A3", "At its core, the problem was never the database at all."),
        ("A4", "Let's dive into the three things that actually moved the number."),
        ("A5", "Don't get me wrong, the old approach shipped a lot of value."),
    ],
)
def test_staging_patterns_act_on_one_sighting(pattern, text):
    assert pattern in _ids(text)


# ------------------------------------------------------------- C: inflation
@pytest.mark.parametrize(
    ("pattern", "text"),
    [
        ("C12", "Additionally, the robust platform showcases a comprehensive suite."),
        ("C13", "The release stands as a testament to years of careful work."),
        ("C14", "Latency is closely associated with the number of open sockets."),
        ("C15", "Revenue grew 12%, highlighting the strength of the channel."),
        ("C16", "The renowned platform boasts a vibrant developer community."),
        ("C17", "Experts argue that the shift is already well underway."),
        ("C18", "The cache serves as the first line of defence for the API."),
    ],
)
def test_inflation_patterns(pattern, text):
    assert pattern in _ids(text)


# ------------------------------------------------------------- E: leftovers
@pytest.mark.parametrize(
    ("pattern", "text"),
    [
        (
            "E22",
            "That covers the rollout. I hope this helps! Let me know if you need more.",
        ),
        ("E23", "As of my last update the pricing page listed three tiers."),
        ("E25", "The retry loop was added to replace the previous approach entirely."),
    ],
)
def test_leftover_patterns(pattern, text):
    assert pattern in _ids(text)


def test_the_heading_echo_is_caught():
    text = "## Why caching matters\n\nCaching matters because it saves work.\n"
    assert "E24" in _ids(text)


def test_a_decorative_heading_is_caught():
    assert "D20" in _ids("## Strategic Negotiations And Global Partnerships\n\nBody.\n")
    assert "D20" in _ids("## Shipping \U0001f680 faster\n\nBody.\n")


def test_a_plain_sentence_case_heading_is_not_decorative():
    assert "D20" not in _ids("## Why we moved off the queue\n\nA different body.\n")


# ---------------------------------------------------------------- B: rhythm
def test_repeated_sentence_openings():
    text = (
        "The platform indexes every document. The platform also answers questions. "
        "The platform keeps a history."
    )
    assert "B7" in _ids(text)


#: Enough words for a rate to mean something (the detector ignores anything
#: shorter, because one dash in one sentence is not a habit).
_FILLER = (
    "We moved the index to a new host over a weekend and watched the graphs "
    "until Monday. Queries got faster for most teams and slower for one, which "
    "took another week to explain. The notes below cover what changed, what we "
    "would skip, and who had to be woken up. None of it was planned in advance "
    "and most of it was fixed by someone reading a log file at the right time. "
) * 4


def test_dash_density_only_fires_in_bulk():
    one = _FILLER + "We shipped it in March \u2014 later than planned."
    assert "B8" not in _ids(one)
    many = _FILLER + " ".join(
        [f"Point {i} \u2014 which mattered \u2014 landed late." for i in range(12)]
    )
    assert "B8" in _ids(many)


def test_a_writing_sample_raises_the_dash_ceiling():
    """Upstream: a supplied sample overrides the patterns, dashes included."""
    many = _FILLER + " ".join(
        [f"Point {i} \u2014 which mattered \u2014 landed late." for i in range(12)]
    )
    assert "B8" in _ids(many)
    assert "B8" not in _ids(many, sample=many)


def test_forced_triads_fire_in_bulk():
    text = _FILLER + " ".join(
        [f"Case {i} is fast, reliable, and scalable." for i in range(10)]
    )
    assert "B6" in _ids(text)


# ------------------------------------------- severity: weak alone is nothing
def test_a_weak_tell_alone_is_not_a_finding():
    """§9/§10/§11/§21 are 'weak alone' upstream: a passive verb in otherwise
    clean prose is ordinary English, not evidence of a machine."""
    clean_but_passive = (
        "The index was rebuilt overnight. Queries returned to their usual "
        "latency by the time the team logged in."
    )
    assert _ids(clean_but_passive) == set()


def test_a_weak_tell_counts_beside_an_acting_one():
    text = (
        "Let's dive into the numbers. The index was rebuilt overnight and "
        "queries were restored by morning."
    )
    ids = _ids(text)
    assert "A4" in ids and "B11" in ids


# ------------------------------------------------------- protected spans
PROTECTED_DOC = (
    "---\ntitle: Notes\n---\n\n"
    "# Release notes\n\n"
    "```json\n"
    '{"copy": "in today\'s digital landscape we leverage a robust tapestry"}\n'
    "```\n\n"
    "Run `leverage --robust --seamless` before you start.\n\n"
    "> Additionally, the robust platform stands as a testament to innovation.\n\n"
    'The report said "this is not just a tool but a testament to innovation".\n\n'
    "[internal-link: delve into the realm -> the comprehensive guide]\n\n"
    "![alt: a robust seamless dashboard](image-placeholder)\n\n"
    "Details: [the comprehensive overview](https://x.test/delve-into-the-realm)\n"
)


def test_protected_spans_are_never_flagged():
    """Upstream's 'do not change code, links, metadata' as a mechanism: every
    tell in this document sits inside code, a quote, a link or a marker."""
    findings, _ = analyze(PROTECTED_DOC)
    assert findings == [], [f"{f.pattern}: {f.excerpt}" for f in findings]


def test_protected_spans_are_merged_and_ordered():
    spans = protected_spans(PROTECTED_DOC)
    assert spans == sorted(spans)
    for (_, end), (start, _) in zip(spans, spans[1:], strict=False):
        assert start > end


def test_the_blog_output_contract_is_structure_not_prose():
    """The Blog skill MUST emit these; humanizing them would break the contract
    its own tests assert."""
    doc = (
        "## OllaSuper Blog Quality Score\n"
        "96/100 — Exceptional\n"
        "Quality of this draft — NOT a Google-ranking prediction.\n"
        "Content quality 29/30, SEO 24/25, E-E-A-T 14/15, Technical 15/15, "
        "AI-Citation 14/15\n\n"
        "## Sources & evidence\n"
        "Additionally, the robust tapestry of sources showcases a testament.\n"
    )
    findings, _ = analyze(doc)
    assert findings == [], [f.pattern for f in findings]


# ------------------------------------------------------------- the register
def test_technical_register_keeps_reference_text_neutral():
    """Upstream: technical/reference/legal stays neutral. 'serves as' and
    'associated with' are ordinary in API documentation."""
    doc = "The header serves as the idempotency key and is associated with the run."
    assert _ids(doc) & {"C14", "C18"}
    assert not (_ids(doc, register="technical") & {"C14", "C18"})


def test_technical_register_still_catches_slop():
    doc = "Let's dive into the endpoint. I hope this helps!"
    ids = _ids(doc, register="technical")
    assert "A4" in ids and "E22" in ids


# ------------------------------------------------------------------- score
def test_clean_human_prose_scores_at_the_ship_threshold():
    text = (
        "# What we learned running analytics for thirty teams\n\n"
        "Most dashboards go stale within a month. We watched it happen at thirty "
        "companies last year, and the pattern was always the same: someone builds "
        "a board, three people look at it for a week, then it rots.\n\n"
        "The teams that kept theirs alive did one boring thing. They picked a "
        "single number that someone's job depended on and put it at the top. "
        "Everything else went below the fold or got deleted.\n"
    )
    assert human_voice_score(text) >= DEFAULT_THRESHOLD


def test_the_score_falls_as_slop_is_added_and_is_deterministic():
    base = (
        "We moved the index to a new host over a weekend. Queries got faster "
        "for most teams and slower for one, which took another week to explain. "
        "The write-up below covers what we changed and what we would skip.\n"
    )
    slop = base + (
        "In today's digital landscape, this is not just a migration but a "
        "testament to innovation. Additionally, the robust platform seamlessly "
        "unlocks comprehensive value. Let that sink in.\n"
    )
    assert human_voice_score(base) > human_voice_score(slop)
    assert human_voice_score(slop) == human_voice_score(slop)
    assert 0 <= human_voice_score(slop) <= 100


def test_empty_and_junk_inputs_are_survivable():
    assert human_voice_score("") == 100
    assert analyze("")[0] == []
    assert profile("").words == 1  # never divides by zero


# ------------------------------------------------------------------ latency
def _p99(fn, n: int = 30, rounds: int = 3) -> float:
    """Best P99 of `rounds` passes — the shape `tests/test_routing.py` settled
    on, because a wall-clock P99 measures the scheduler as much as the code."""
    best = None
    for _ in range(rounds):
        xs = []
        for _ in range(n):
            t = time.perf_counter()
            fn()
            xs.append(time.perf_counter() - t)
        xs.sort()
        p99 = xs[min(int(n * 0.99), n - 1)]
        best = p99 if best is None else min(best, p99)
    return best


def test_a_full_length_article_is_scanned_inside_its_budget():
    """THE regression that matters for the hot path. This repo has shipped
    catastrophic backtracking on user-controlled text before (see
    `tests/test_routing.py`): `(?:\\w+\\s+){0,3}` cost 2.7ms under a 1ms budget.
    These patterns run over every writing turn's output, so they get a ceiling.
    """
    article = (
        "## Section heading here\n\n"
        "In today's digital landscape, the robust platform is not just a tool "
        "but a testament to innovation — seamlessly unlocking comprehensive "
        "value for teams, leaders, and customers. Additionally, experts argue "
        "that this marks a pivotal moment, highlighting the shift.\n\n"
    ) * 180  # ~50KB, a long article's worth
    assert len(article) > 40_000
    p99 = _p99(lambda: analyze(article))
    # Measured after threading one profile through the pass: ~150ms best,
    # ~200ms worst on this box. The ceiling is a REGRESSION guard (a
    # backtracking pattern would blow past it by an order of magnitude), not a
    # tight fit.
    assert p99 < 0.5, f"50KB scan P99 {p99 * 1000:.0f}ms exceeds the 500ms budget"


def test_pathological_input_does_not_blow_up():
    """Adversarial shapes a model (or a paste) can produce: unterminated fences,
    a wall of dashes, no whitespace at all."""
    for junk in (
        "```" + "x" * 30_000,
        "—" * 20_000,
        "a" * 50_000,
        "`" * 5_000,
        "#" * 5_000,
    ):
        p99 = _p99(lambda text=junk: analyze(text), n=5, rounds=1)
        assert p99 < 1.0, f"pathological input took {p99 * 1000:.0f}ms"


def test_a_correct_marketing_block_is_not_treated_as_slop():
    """Measured against the shipped detector before the fix: the evidence
    heading was flagged as a decorative heading (D20) and a labelled claim as a
    one-line closer (A2), so the stage would have told the model to "fix"
    Marketing's mandatory contract."""
    block = (
        "## \U0001f7e2 What the data shows\n\n"
        "**FACT:** Churn fell to 3.1% in Q3 \U0001f7e2 verified (Stripe export).\n\n"
        "**ASSUMPTION:** Seasonality is flat \U0001f534 assumed.\n\n"
        "**RECOMMENDATION:** Extend the onboarding flow to the enterprise tier.\n"
    )
    findings, _ = analyze(block)
    assert not [f for f in findings if f.pattern in {"D20", "A2"}], [
        (f.pattern, f.excerpt) for f in findings
    ]


def test_prose_inside_a_labelled_claim_is_still_humanized():
    """Protection covers the label and the tag, not the sentence around them."""
    text = (
        "**FACT:** Additionally, the robust funnel seamlessly converts "
        "\U0001f7e2 verified."
    )
    assert "C12" in _ids(text)


def test_a_non_evidence_emoji_heading_is_still_decorative():
    assert "D20" in _ids("## Shipping \U0001f680 faster\n\nBody.\n")
