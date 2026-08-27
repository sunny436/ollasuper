"""Phase 3 — the SEO report envelope, renderers, emitter, and the delegate-seam hook.

Hermetic: a FakeWriter captures the artifact/report/event calls (no network, no
Convex). Covers the spec's report scenarios — successful/partial/failed, missing &
invalid evidence, integrity hashing, resume-stable idempotency, the no-0-100-score
epistemic rule, and that the delegate hook emits BEFORE `to_observation` drops data.
"""

from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace

import pytest

from app.agent.spec import AgentOutcome
from app.orchestrator.orchestrator import Orchestrator
from app.seo.models import ConfidenceLevel, FindingStatus, ReportStatus, Severity
from app.seo.report import (
    bound_for_row,
    build_envelope,
    build_seo_report_emitter,
    render_json,
    render_markdown,
    render_pdf,
    report_id_for,
)

pytestmark = pytest.mark.anyio


def _report(**over) -> dict:
    base = {
        "target": "https://example.com",
        "coverage": ["robots.analyze", "metadata.audit", "crawl.run"],
        "checks_performed": [
            {
                "check_id": "crawl_index.robots_blocks_important",
                "intent": "robots.analyze",
                "status": "FAIL",
                "severity": "critical",
                "observation": "important pages blocked",
                "expected": "crawlable",
                "affected": ["/a", "/b"],
                "recommendation": "unblock",
                "verification": "refetch robots",
                "evidence": [
                    {"tool_id": "intel_robots", "intent": "robots.analyze",
                     "observed_at": "2026-08-26T10:00:00Z"}
                ],
            },
            {
                "check_id": "onpage.title_unique_descriptive",
                "intent": "metadata.audit",
                "status": "WARN",
                "severity": "medium",
                "observation": "dup titles",
                "evidence": [],
            },
            {
                "check_id": "gap.core_web_vitals",
                "status": "UNSUPPORTED",
                "severity": "info",
                "observation": "CWV needs CrUX",
            },
        ],
        "passed": [],
        "failed": ["crawl_index.robots_blocks_important"],
        "warnings": ["onpage.title_unique_descriptive"],
        "missing_data": ["gap.core_web_vitals"],
        "evidence_freshness": "live",
        "business_exposure": "high: crawl blocked",
    }
    base.update(over)
    return base


class FakeWriter:
    def __init__(self):
        self.artifacts: list[dict] = []
        self.reports: list[dict] = []
        self.events: list[dict] = []

    async def store_artifact(
        self, blob, *, filename, fmt, mime, sha256=None, artifact_key=None
    ):
        self.artifacts.append(
            {"fmt": fmt, "sha256": sha256, "artifact_key": artifact_key,
             "size": len(blob), "filename": filename, "mime": mime, "blob": blob}
        )
        return {"artifactId": f"art_{fmt}", "size": len(blob)}

    async def store_report(self, envelope):
        self.reports.append(envelope)
        return {"ok": True}

    async def emit_event(self, type, **body):
        self.events.append({"type": type, **body})
        return True


def _spec(kind="seo_audit", aid="seo"):
    return SimpleNamespace(output=SimpleNamespace(report_kind=kind), agent_id=aid)


def _res(outcome, data=None, error=None):
    return SimpleNamespace(outcome=outcome, data=data, error=error)


# --- envelope building -----------------------------------------------------
def test_status_partial_when_a_check_was_not_tested():
    rd = _report()
    rd["checks_performed"].append(
        {"check_id": "technical.mixed_content", "status": "NOT_TESTED",
         "severity": "medium", "observation": "tool failed"}
    )
    env = build_envelope(rd, stream_id="s", delegation_id="d")
    assert env.status is ReportStatus.PARTIAL


def test_status_completed_when_only_unsupported_gaps_remain():
    # UNSUPPORTED is a by-design gap, NOT a failure to run → still "completed".
    env = build_envelope(_report(), stream_id="s", delegation_id="d")
    assert env.status is ReportStatus.COMPLETED
    assert any("CWV" in u for u in env.unsupported_areas)


def test_scope_site_when_crawl_ran_else_page():
    site = build_envelope(_report(), stream_id="s", delegation_id="d")
    assert site.scope.type == "site"
    rd = _report(coverage=["metadata.audit"])
    page = build_envelope(rd, stream_id="s", delegation_id="d")
    assert page.scope.type == "page"


def test_summary_and_category_rollup():
    env = build_envelope(_report(), stream_id="s", delegation_id="d")
    assert env.summary.failed == 1 and env.summary.warnings == 1
    cats = {c.category: c for c in env.summary.categories}
    assert cats["Crawl & Indexing"].failed == 1
    assert cats["On-Page SEO"].warned == 1


def test_uncatalogued_check_ids_categorise_by_prefix_not_all_technical():
    # Crawler-emitted site-level findings are not in the check catalogue; they must
    # land in the category their `phase.name` prefix implies, not all under Technical.
    rd = _report(
        coverage=["crawl.run"],
        checks_performed=[
            {"check_id": "crawl_index.robots_txt", "status": "PASS",
             "severity": "info", "observation": "robots present"},
            {"check_id": "onpage.h1", "status": "PASS",
             "severity": "info", "observation": "single h1"},
            {"check_id": "technical.https_ssl", "status": "PASS",
             "severity": "info", "observation": "valid tls"},
        ],
    )
    env = build_envelope(rd, stream_id="s", delegation_id="d")
    cats = {c.category: c for c in env.summary.categories}
    assert cats["Crawl & Indexing"].passed == 1  # robots_txt, NOT Technical
    assert cats["On-Page SEO"].passed == 1  # h1
    assert cats["Technical"].passed == 1  # https_ssl


def test_provenance_from_covered_capabilities():
    env = build_envelope(_report(), stream_id="s", delegation_id="d")
    assert env.provider_provenance
    prov = env.provider_provenance[0]
    assert prov.provider == "ollagraph" and prov.tool_ids


def test_confidence_is_qualitative_not_numeric():
    env = build_envelope(_report(), stream_id="s", delegation_id="d")
    assert isinstance(env.confidence, ConfidenceLevel)
    assert env.confidence in set(ConfidenceLevel)


def test_missing_evidence_is_flagged_not_dropped():
    env = build_envelope(_report(), stream_id="s", delegation_id="d")
    warn = next(
        f for f in env.findings if f.check_id == "onpage.title_unique_descriptive"
    )
    assert "missing_evidence" in warn.data_quality_flags


def test_llm_shaped_finding_is_normalized_not_lost():
    # A delegated LLM audit that uses its own finding vocabulary must still yield real
    # findings, not opaque "could not be parsed" stubs.
    rd = _report(
        coverage=["metadata.audit"],
        checks_performed=[
            {
                "id": "title-too-long",
                "description": "The homepage title exceeds 60 characters.",
                "priority": "high",
                "result": "fail",
                "recommended_action": "Shorten the title to 50-60 chars.",
                "affected_urls": ["https://x/", "https://x/a"],
            }
        ],
    )
    env = build_envelope(rd, stream_id="s", delegation_id="d")
    f = env.findings[0]
    assert f.observation == "The homepage title exceeds 60 characters."
    assert f.status is FindingStatus.FAIL and f.severity is Severity.HIGH
    assert f.recommendation.startswith("Shorten")
    assert f.affected == ["https://x/", "https://x/a"]
    assert "normalized_finding" in f.data_quality_flags


def test_normalizes_the_live_llm_finding_shape_cleanly():
    # The exact per-finding shape observed from the delegated SEO agent on prod:
    # `observed`/`scope`/`check` rather than observation/affected/check_id.
    rd = _report(
        coverage=["metadata.audit"],
        checks_performed=[
            {
                "check": "Contact page response and soft-404 signals",
                "status": "FAIL",
                "severity": "High",
                "scope": "https://www.networkershome.com/contactus/",
                "observed": "The page returned apparent HTTP 200 soft-404 signals.",
                "expected": "A contact page should return 200 with unique content.",
                "confidence": "Medium",
                "recommendation": "Restore unique contact content.",
                "verification": "Manually inspect the rendered page.",
            }
        ],
    )
    f = build_envelope(rd, stream_id="s", delegation_id="d").findings[0]
    # The observation is the clean `observed` value — NOT a dump of every key.
    assert f.observation == "The page returned apparent HTTP 200 soft-404 signals."
    assert "status:" not in f.observation and "recommendation:" not in f.observation
    assert f.status is FindingStatus.FAIL and f.severity is Severity.HIGH
    assert f.affected == ["https://www.networkershome.com/contactus/"]
    assert f.recommendation == "Restore unique contact content."
    assert f.verification == "Manually inspect the rendered page."


def test_descriptionless_finding_keeps_its_raw_content():
    rd = _report(
        coverage=["metadata.audit"],
        checks_performed=[{"foo": "bar", "widget_count": 3}],
    )
    env = build_envelope(rd, stream_id="s", delegation_id="d")
    obs = env.findings[0].observation
    assert obs and obs != "finding could not be parsed"
    assert "foo: bar" in obs  # raw content surfaced, never lost


def test_normalized_finding_status_defaults_to_not_tested_never_fail():
    # An unrecognised status must degrade to the HONEST NOT_TESTED, never a FAIL.
    rd = _report(
        coverage=["metadata.audit"],
        checks_performed=[{"description": "something", "status": "mysterious"}],
    )
    env = build_envelope(rd, stream_id="s", delegation_id="d")
    assert env.findings[0].status is FindingStatus.NOT_TESTED


def test_invalid_evidence_degrades_without_crashing():
    rd = _report()
    # a malformed evidence record (unknown key trips extra='forbid')
    rd["checks_performed"][0]["evidence"] = [{"totally": "wrong", "shape": 1}]
    env = build_envelope(rd, stream_id="s", delegation_id="d")
    f = env.findings[0]
    assert "invalid_evidence_dropped" in f.data_quality_flags
    assert env.data_quality_note == "invalid_evidence_dropped"


def test_report_id_is_deterministic_and_resume_stable():
    a = report_id_for("s1", "d1", "https://x.com")
    b = report_id_for("s1", "d1", "https://x.com")
    assert a == b and a.startswith("rpt_")
    assert report_id_for("s1", "d2", "https://x.com") != a  # different delegation
    # v1-off path (no delegation_id) still stable via target hash
    assert report_id_for("s1", "", "https://x.com") == report_id_for("s1", "", "https://x.com")


# --- no arbitrary 0-100 score anywhere -------------------------------------
def test_no_numeric_score_in_envelope():
    env = build_envelope(_report(), stream_id="s", delegation_id="d")
    blob = json.dumps(env.model_dump(mode="json")).lower()
    assert '"score"' not in blob and "seo_score" not in blob


# --- renderers -------------------------------------------------------------
def test_renderers_produce_valid_outputs():
    env = build_envelope(_report(), stream_id="s", delegation_id="d")
    parsed = json.loads(render_json(env))
    assert parsed["report_id"] == env.report_id
    md = render_markdown(env)
    assert "# SEO Audit Report" in md and "Category breakdown" in md
    pdf = render_pdf(env)
    assert pdf[:5] == b"%PDF-"


def test_bound_for_row_trims_when_oversize():
    rd = _report()
    # inflate evidence so the row exceeds the cap
    big = {"tool_id": "t", "response_excerpt": {"x": "y" * 5000}}
    rd["checks_performed"][0]["evidence"] = [big] * 200
    env = build_envelope(rd, stream_id="s", delegation_id="d")
    row = bound_for_row(env)
    assert row.get("row_truncated") is True
    assert len(json.dumps(row).encode()) <= 600_000


# --- the emitter -----------------------------------------------------------
async def test_emitter_stores_three_formats_with_hash_and_idempotency_key():
    w = FakeWriter()
    emit = build_seo_report_emitter(w, settings=None)
    await emit("seo_audit", _report(), {"stream_id": "s1", "delegation_id": "d1"})

    fmts = {a["fmt"] for a in w.artifacts}
    assert fmts == {"json", "md", "pdf"}
    for a in w.artifacts:
        assert len(a["sha256"]) == 64  # a real SHA-256 hex digest
        assert a["artifact_key"].endswith(f":{a['fmt']}")
        # the declared hash matches the bytes (integrity contract)
        assert a["sha256"] == hashlib.sha256(a["blob"]).hexdigest()
    # exactly one report row + one ARTIFACT event
    assert len(w.reports) == 1
    assert len(w.events) == 1
    ev = w.events[0]
    assert ev["artifact_type"] == "seo_report"
    assert ev["artifact_id"] == "art_json"  # real, non-empty (the JSON artifact)
    assert ev["metadata"]["report_id"].startswith("rpt_")


async def test_emitter_failed_report_still_surfaces_json_only():
    w = FakeWriter()
    emit = build_seo_report_emitter(w, settings=None)
    rm = {"stream_id": "s", "delegation_id": "d"}
    await emit("seo_audit", None, rm, "agent crashed")
    assert {a["fmt"] for a in w.artifacts} == {"json"}  # no md/pdf for a failure
    assert w.reports[0]["status"] == "failed"
    assert w.events[0]["artifact_type"] == "seo_report"


async def test_emitter_ignores_other_kinds():
    w = FakeWriter()
    emit = build_seo_report_emitter(w, settings=None)
    await emit("some_other_kind", _report(), {"stream_id": "s", "delegation_id": "d"})
    assert not w.artifacts and not w.reports and not w.events


# --- the delegate-seam hook (emits BEFORE to_observation drops data) -------
async def test_delegate_hook_emits_on_structured_result():
    calls = []

    async def emitter(kind, data, run_meta, *a):
        calls.append((kind, data, run_meta, a))

    env = SimpleNamespace(report_emitter=emitter)
    sub_env = SimpleNamespace(run_id="s1", delegation_id="d1")
    result = _res(AgentOutcome.STRUCTURED_RESULT, data={"target": "x"})
    await Orchestrator._maybe_emit_report(env, _spec(), result, sub_env)
    assert calls and calls[0][0] == "seo_audit"
    assert calls[0][2] == {"stream_id": "s1", "delegation_id": "d1"}


async def test_delegate_hook_emits_failed_on_failure():
    calls = []

    async def emitter(kind, data, run_meta, *a):
        calls.append((kind, data, a))

    env = SimpleNamespace(report_emitter=emitter)
    sub_env = SimpleNamespace(run_id="s", delegation_id="d")
    result = _res(AgentOutcome.FAILURE, error={"detail": "boom"})
    await Orchestrator._maybe_emit_report(env, _spec(), result, sub_env)
    assert calls and calls[0][1] is None  # failed → None data
    assert "boom" in calls[0][2][0]


async def test_delegate_hook_noop_without_report_kind_or_emitter():
    calls = []

    async def emitter(*a):
        calls.append(a)

    result = _res(AgentOutcome.STRUCTURED_RESULT, data={})
    sub = SimpleNamespace(run_id="s", delegation_id="d")
    # no report_kind
    await Orchestrator._maybe_emit_report(
        SimpleNamespace(report_emitter=emitter), _spec(kind="", aid="research"),
        result, sub,
    )
    # no emitter on env
    await Orchestrator._maybe_emit_report(
        SimpleNamespace(report_emitter=None), _spec(), result, sub,
    )
    assert not calls
