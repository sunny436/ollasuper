"""Phase 2 (SEO) — catalogue integrity, rule-base rigor/epistemics, and the skill's
honesty guarantees. These are the hermetic guards that keep the SEO system honest:
every capability maps to a real read-only tool, every rule is SOURCED with an
observed-vs-expected condition and a verification method, known gaps resolve to
UNSUPPORTED rather than a fabricated value, and the report's SEO-health score is
scoped to signal health only — never a ranking guarantee.
"""

from __future__ import annotations

from app.seo.capabilities import (
    ALLOWED_CATEGORIES,
    ALLOWED_TOOL_IDS,
    SEO_CAPABILITIES,
    seo_intent_map,
)
from app.seo.checks import KNOWN_GAPS, SEO_CHECKS, checks_digest
from app.seo.models import Severity
from app.seo.skill import SEO_SKILL
from tests.fakes.seo_tools import category_for


# --- capability catalogue --------------------------------------------------
def test_every_capability_is_well_formed():
    for c in SEO_CAPABILITIES:
        assert c.intent and "." in c.intent, c.intent
        assert c.description.strip()
        assert c.tool_ids, c.intent
        assert c.query.strip()
        assert c.side_effect.value == "read_only", c.intent  # read-only end to end


def test_intent_map_covers_every_capability():
    m = seo_intent_map()
    assert set(m) == {c.intent for c in SEO_CAPABILITIES}
    for intent, spec in m.items():
        assert spec["query"].strip()
        assert spec["max_side_effect"].value == "read_only", intent


def test_every_catalogue_tool_is_in_scope():
    """Allowlist completeness at the catalogue level: every referenced tool_id is
    admitted either by its category or by an explicit allowlisted id."""
    for c in SEO_CAPABILITIES:
        for tid in c.tool_ids:
            in_scope = (
                category_for(tid) in ALLOWED_CATEGORIES or tid in ALLOWED_TOOL_IDS
            )
            assert in_scope, tid


def test_allowlisted_ids_are_used_by_some_capability():
    """No dead entries: every explicit allowlisted tool_id is actually referenced by
    a capability (else it is unreachable scope surface)."""
    used = {tid for c in SEO_CAPABILITIES for tid in c.tool_ids}
    assert ALLOWED_TOOL_IDS <= used


# --- rule base rigor + epistemics ------------------------------------------
def test_every_check_is_sourced_and_verifiable():
    cap_intents = {c.intent for c in SEO_CAPABILITIES}
    for chk in SEO_CHECKS:
        assert chk.check_id and chk.phase
        assert chk.expected.strip(), chk.check_id
        assert chk.verification.strip(), chk.check_id
        assert chk.source.strip(), chk.check_id
        assert isinstance(chk.severity_default, Severity)
        if chk.supported:
            # A supported check must be verifiable by a real SEO capability intent.
            assert chk.intent in cap_intents, chk.check_id
        else:
            # A known gap carries NO intent and is reported as UNSUPPORTED.
            assert chk.intent == "", chk.check_id
            assert "UNSUPPORTED" in chk.applicability, chk.check_id


def test_known_gaps_are_the_unsupported_checks():
    assert set(KNOWN_GAPS) == {c for c in SEO_CHECKS if not c.supported}
    assert KNOWN_GAPS, "the phase-2 gaps (GSC/GA4/CrUX/render) must be recorded"
    ids = {c.check_id for c in KNOWN_GAPS}
    # The researched Phase-2 gaps are all present.
    for expected in (
        "gap.index_coverage",
        "gap.core_web_vitals",
        "gap.ranking_traffic",
        "gap.render_parity",
    ):
        assert expected in ids


def test_applicability_gate_is_stated_where_it_matters():
    by_id = {c.check_id: c for c in SEO_CHECKS}
    # Crawl budget is APPLICABILITY-GATED (only large/fast-changing sites).
    assert by_id["architecture.crawl_budget_waste"].applicability != "always"
    # hreflang only applies to multi-locale sites.
    assert "multi" in by_id["international.hreflang"].applicability.lower()


def test_digest_lists_only_supported_checks():
    digest = checks_digest(supported_only=True)
    assert digest.strip()
    for gap in KNOWN_GAPS:
        assert gap.check_id not in digest


def test_no_check_promises_a_ranking_guarantee():
    banned = ("guaranteed ranking", "will rank", "guarantees a rank")
    for chk in SEO_CHECKS:
        blob = (chk.expected + " " + chk.verification).lower()
        assert not any(b in blob for b in banned), chk.check_id


# --- the skill guidance encodes the honesty rules --------------------------
def test_skill_states_capability_gap_honesty():
    low = (SEO_SKILL.constraints + SEO_SKILL.methodology).lower()
    assert "unsupported" in low
    assert "never" in low and "hallucinate" in low
    # Epistemics: page experience is a tiebreaker, E-E-A-T not a direct factor.
    assert "tiebreaker" in low
    assert "not a direct ranking factor" in low


def test_skill_renders_within_reason():
    # render() composes the full guidance; it must be non-trivial but not unbounded.
    text = SEO_SKILL.render()
    assert "SEO Audit" in text
    assert 500 < len(text)  # substantive guidance


# --------------------------------------------------------------------------- #
# QA remediation — the two failure modes the audit hit in practice were a crawl
# that timed out and a robots.txt verdict that was simply wrong. Neither is a
# maths bug; both are guidance the skill has to carry.
# --------------------------------------------------------------------------- #
def test_skill_tells_the_model_to_bound_an_expensive_scan():
    """A broken-link audit timed out in QA and only completed once narrowed."""
    t = SEO_SKILL.render().lower()
    assert "start bounded" in t
    assert "times out" in t or "timed out" in t or "timeout" in t
    # A partial, scoped answer must be presented as legitimate — otherwise the
    # model widens the scan until it dies rather than reporting what it has.
    assert "partial result" in t


def test_skill_requires_a_surprising_robots_block_to_be_verified():
    """The provider's parser returned a false `is_allowed: false` in testing, and
    a wrong 'Googlebot is blocked' is a P0-shaped claim."""
    t = SEO_SKILL.render().lower()
    assert "robots.txt" in t
    assert "raw robots.txt" in t
    assert "disagree" in t


def test_limitations_name_the_provider_and_rendering_gaps():
    t = SEO_SKILL.render().lower()
    assert "provider" in t and "wrong" in t
    assert "js-rendered" in t or "javascript" in t
