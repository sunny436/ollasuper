"""Phase 2 (SEO) — catalogue integrity, rule-base rigor/epistemics, and the typed
output contract. These are the hermetic guards that keep the SEO system honest:
every capability maps to a real read-only tool, every rule is SOURCED with an
observed-vs-expected condition and a verification method, known gaps resolve to
UNSUPPORTED rather than a fabricated value, and the report can never carry a
0-100 score or a ranking guarantee.
"""

from __future__ import annotations

import jsonschema
import pytest
from pydantic import ValidationError

from app.seo.agent import SEO_AGENT
from app.seo.capabilities import (
    ALLOWED_CATEGORIES,
    ALLOWED_TOOL_IDS,
    SEO_CAPABILITIES,
    seo_intent_map,
)
from app.seo.checks import KNOWN_GAPS, SEO_CHECKS, checks_digest
from app.seo.models import (
    OUTPUT_SCHEMA,
    SEO_AGENT_OUTPUT_SCHEMA,
    EvidenceRecord,
    FindingStatus,
    SEOFinding,
    SEOReport,
    Severity,
)
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


# --- typed output contract -------------------------------------------------
def test_report_has_no_numeric_score():
    # No 0-100 score anywhere: not a model field, not a schema property.
    assert "score" not in SEOReport.model_fields
    props = OUTPUT_SCHEMA.get("properties", {})
    assert not any("score" in k.lower() for k in props), list(props)


def test_output_schema_is_strict():
    # The STRICT SEOReport schema still governs the deterministic durable-run report.
    assert OUTPUT_SCHEMA.get("additionalProperties") is False
    assert "target" in OUTPUT_SCHEMA.get("properties", {})


def test_seo_agent_is_gated_on_the_lenient_schema():
    # The SUB-AGENT is gated leniently so build_envelope's salvage — not a formatting
    # technicality — decides the audit. Requires only a `checks_performed` array and
    # does NOT forbid additional properties.
    schema = SEO_AGENT.output.schema
    assert schema is SEO_AGENT_OUTPUT_SCHEMA
    assert schema.get("additionalProperties") is not False
    assert schema.get("required") == ["checks_performed"]
    # A good report with extra keys + a loose scalar type (evidence_freshness as an
    # object) passes — the strict schema would have failed it and produced FAILED.
    jsonschema.validate(
        instance={
            "target": "https://x",
            "checks_performed": [],
            "evidence_freshness": {"note": "an object, not a string"},
            "prioritised_action_plan": ["do X"],
        },
        schema=schema,
    )
    # But findings hidden under the wrong key (no checks_performed) still fails, so the
    # key-naming repair pass is triggered rather than silently emitting an empty report.
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance={"findings": []}, schema=schema)


def _valid_report() -> dict:
    finding = SEOFinding(
        check_id="crawl_index.robots_blocks_important",
        intent="robots.analyze",
        status=FindingStatus.PASS,
        observation="robots.txt allows all important paths",
        expected="important pages + CSS/JS are crawlable",
        evidence=[EvidenceRecord(tool_id="intel_robots", intent="robots.analyze")],
        severity=Severity.INFO,
        confidence=0.9,
        recommendation="",
        verification="re-fetch robots.txt",
    )
    return SEOReport(
        target="https://example.com",
        coverage=["robots.analyze"],
        checks_performed=[finding],
        passed=["crawl_index.robots_blocks_important"],
        business_exposure="low: no crawl/index blockers observed",
    ).model_dump()


def test_valid_report_validates():
    jsonschema.validate(instance=_valid_report(), schema=OUTPUT_SCHEMA)


def test_hallucinated_key_fails_validation():
    bad = _valid_report()
    bad["seo_score"] = 87  # a fabricated numeric score
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=bad, schema=OUTPUT_SCHEMA)


def test_out_of_enum_status_is_rejected():
    with pytest.raises(ValidationError):
        SEOFinding(check_id="x", status="LOOKS_FINE")  # not a FindingStatus


def test_confidence_is_bounded():
    with pytest.raises(ValidationError):
        SEOFinding(
            check_id="x", status=FindingStatus.WARN, confidence=1.5
        )  # ge=0, le=1


def test_unsupported_is_a_first_class_status():
    # An honest capability gap is representable WITHOUT any fabricated data.
    f = SEOFinding(
        check_id="gap.core_web_vitals",
        status=FindingStatus.UNSUPPORTED,
        observation="",
        expected="LCP<=2.5s, INP<=200ms, CLS<=0.1 at CrUX 75th pct",
        recommendation="connect CrUX/PageSpeed to measure field data",
        data_quality_flags=["requires_crux_psi"],
    )
    assert f.status is FindingStatus.UNSUPPORTED


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
