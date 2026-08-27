"""Phase 3 — turn the SEO agent's transient `SEOReport` into a persisted, secure,
downloadable report artifact.

This module is invoked at the DELEGATE SEAM (orchestrator `_make_delegator`), the
one place the structured `AgentResult.data` still exists before
`HandoffResult.to_observation()` drops it. It:
  1. wraps the agent's SEOReport in a server-authoritative `ReportEnvelope`
     (run identity, timestamps, methodology version, provider provenance),
  2. renders JSON (always) + Markdown + PDF (reusing the filegen renderer),
  3. stores each rendering through the EXISTING secure artifact pipeline
     (`writer.store_artifact`) — with a SHA-256 integrity hash and a stable
     `artifact_key` so a crash-resume re-store is idempotent (no duplicate blobs),
  4. persists the report row (`writer.store_report`, idempotent by reportId),
  5. surfaces ONE `ARTIFACT` event (`artifact_type="seo_report"`) that the chat
     renders as the rich SEO report card.

Everything is best-effort: a failure here NEVER fails the chat turn.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from app.logging import get_logger
from app.models.events import EventType
from app.seo.capabilities import SEO_CAPABILITIES
from app.seo.checks import SEO_CHECKS
from app.seo.models import (
    AuditScope,
    CategoryRollup,
    ConfidenceLevel,
    FindingStatus,
    Methodology,
    ProviderProvenance,
    ReportArtifactRef,
    ReportEnvelope,
    ReportManifest,
    ReportStatus,
    ReportSummary,
    SEOFinding,
    Severity,
)
from app.seo.skill import SEO_SKILL

log = get_logger(__name__)

METHODOLOGY_NAME = SEO_SKILL.name
# Ties the report to BOTH the skill version and the rule-base identity, so a report
# is reproducible against the exact methodology that produced it.
METHODOLOGY_VERSION = f"{SEO_SKILL.version}+checks.{len(SEO_CHECKS)}"

MAX_ROW_BYTES = 600_000  # bounded envelope for the Convex row (~1 MiB doc cap)

_CHECK_BY_ID = {c.check_id: c for c in SEO_CHECKS}
_CAP_BY_INTENT = {c.intent: c for c in SEO_CAPABILITIES}
_PHASE_CATEGORY = {
    "crawl_index": "Crawl & Indexing",
    "architecture": "Architecture",
    "onpage": "On-Page SEO",
    "content": "Content",
    "technical": "Technical",
    "international": "International",
    "policy": "Policy & Spam",
}
_SEVERITY_ORDER = {
    Severity.CRITICAL: 0,
    Severity.HIGH: 1,
    Severity.MEDIUM: 2,
    Severity.LOW: 3,
    Severity.INFO: 4,
}

_MIME = {
    "json": "application/json",
    "md": "text/markdown",
    "pdf": "application/pdf",
}


# --- ids + small helpers ---------------------------------------------------
def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def report_id_for(stream_id: str, delegation_id: str, target: str) -> str:
    """A DETERMINISTIC, resume-stable report id. `delegation_id` is stable across
    resume (Phase-1 lineage); the v1-off path has none, so we fall back to a hash of
    the target. Keying on this makes `upsertReport`/`store_artifact` idempotent."""
    key = delegation_id or hashlib.sha1(  # noqa: S324 — non-crypto id
        target.encode("utf-8", "replace")
    ).hexdigest()[:10]
    digest = hashlib.sha1(  # noqa: S324 — non-crypto id
        f"{stream_id}:{key}".encode()
    ).hexdigest()[:20]
    return f"rpt_{digest}"


def _slug(text: str, limit: int = 48) -> str:
    keep = [c if (c.isalnum() or c in "-_.") else "-" for c in text.strip().lower()]
    s = "".join(keep).strip("-._") or "site"
    return s[:limit]


def _host(target: str) -> str:
    t = target.split("://", 1)[-1]
    return t.split("/", 1)[0] or target


def _filename(env: ReportEnvelope, fmt: str) -> str:
    return f"seo-audit-{_slug(_host(env.target))}.{fmt}"


# --- finding coercion (invalid / missing evidence are handled, never raised) -
def _coerce_findings(raw: object) -> tuple[list[SEOFinding], bool]:
    """Validate each finding, salvaging on failure. Malformed evidence is dropped +
    flagged (never raises); an unsalvageable finding degrades to a flagged stub."""
    findings: list[SEOFinding] = []
    had_invalid = False
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            had_invalid = True
            continue
        try:
            findings.append(SEOFinding.model_validate(item))
            continue
        except Exception:  # noqa: BLE001 — try to salvage before giving up
            had_invalid = True
        salvaged = dict(item)
        salvaged["evidence"] = []  # the most likely offender (extra='forbid')
        flags = list(salvaged.get("data_quality_flags") or [])
        flags.append("invalid_evidence_dropped")
        salvaged["data_quality_flags"] = flags
        try:
            findings.append(SEOFinding.model_validate(salvaged))
        except Exception:  # noqa: BLE001 — last resort: a minimal flagged stub
            findings.append(
                SEOFinding(
                    check_id=str(item.get("check_id") or "unknown"),
                    status=FindingStatus.NOT_TESTED,
                    observation="finding could not be parsed",
                    data_quality_flags=["unparseable_finding"],
                )
            )
    return findings, had_invalid


def _category_of(finding: SEOFinding) -> str:
    chk = _CHECK_BY_ID.get(finding.check_id)
    # For a check not in the catalogue (e.g. a crawler-emitted site-level finding),
    # derive the phase from the check_id's `phase.name` prefix rather than dumping
    # everything under "technical" — so `crawl_index.*`/`onpage.*` land in their true
    # category. Known checks keep their catalogue phase unchanged.
    phase = chk.phase if chk else finding.check_id.split(".", 1)[0]
    return _PHASE_CATEGORY.get(phase, "Technical")


def _flag_missing_evidence(findings: list[SEOFinding]) -> None:
    """A FAIL/WARN with no evidence is lower-confidence — flag it (do not drop)."""
    for f in findings:
        if f.status in (FindingStatus.FAIL, FindingStatus.WARN) and not f.evidence:
            if "missing_evidence" not in f.data_quality_flags:
                f.data_quality_flags.append("missing_evidence")


def _summarize(findings: list[SEOFinding]) -> ReportSummary:
    by_sev: dict[str, int] = {}
    cats: dict[str, CategoryRollup] = {}
    passed = failed = warnings = not_tested = 0
    for f in findings:
        by_sev[str(f.severity)] = by_sev.get(str(f.severity), 0) + 1
        cat = _category_of(f)
        roll = cats.setdefault(cat, CategoryRollup(category=cat))
        roll.findings += 1
        if f.status is FindingStatus.PASS:
            passed += 1
            roll.passed += 1
        elif f.status is FindingStatus.FAIL:
            failed += 1
            roll.failed += 1
        elif f.status is FindingStatus.WARN:
            warnings += 1
            roll.warned += 1
        elif f.status is FindingStatus.NOT_TESTED:
            not_tested += 1
    return ReportSummary(
        total_findings=len(findings),
        by_severity=by_sev,
        checks_performed=len(findings),
        passed=passed,
        failed=failed,
        warnings=warnings,
        not_tested=not_tested,
        categories=sorted(cats.values(), key=lambda c: c.category),
    )


def _provenance(coverage: list[str]) -> list[ProviderProvenance]:
    """Group the covered capabilities' tools by provider — the evidence supply chain."""
    by_provider: dict[str, ProviderProvenance] = {}
    for intent in coverage:
        cap = _CAP_BY_INTENT.get(intent)
        if cap is None:
            continue
        prov = by_provider.setdefault(
            cap.provider,
            ProviderProvenance(
                provider=cap.provider,
                freshness=cap.freshness,
                permissions=list(cap.permissions),
            ),
        )
        for tid in cap.tool_ids:
            if tid not in prov.tool_ids:
                prov.tool_ids.append(tid)
    return list(by_provider.values())


def _confidence(findings: list[SEOFinding], not_tested: int) -> ConfidenceLevel:
    """QUALITATIVE, derived from coverage completeness + data-quality flags. NOT a
    number — Google warns against arbitrary scores."""
    flags = sum(len(f.data_quality_flags) for f in findings)
    tested = max(1, len(findings))
    if not_tested == 0 and flags == 0:
        return ConfidenceLevel.HIGH
    if not_tested > tested // 2 or flags > tested:
        return ConfidenceLevel.LOW
    return ConfidenceLevel.MEDIUM


def _sev_sort(findings: list[SEOFinding]) -> list[SEOFinding]:
    # TOTAL order, not severity-only: Python's sort is stable, so a severity-only key
    # leaves within-severity order = accumulation order, which DIFFERS across a durable
    # run's resume (a re-crawled batch reorders) → different rendered bytes → a churning
    # manifest hash. Break ties by (check_id, observation) so identical findings always
    # render byte-identically regardless of the order they were gathered in.
    return sorted(
        findings,
        key=lambda f: (
            _SEVERITY_ORDER.get(f.severity, 9),
            f.check_id or "",
            f.observation or "",
        ),
    )


def build_envelope(
    report_dict: dict,
    *,
    stream_id: str,
    delegation_id: str,
    generated_at: str | None = None,
) -> ReportEnvelope:
    """Wrap the agent's SEOReport dict in the server-authoritative envelope.

    `generated_at` is normally the wall clock, but a DURABLE run passes a fixed value
    (its run createdAt) so a resume re-emit renders byte-identical bytes — otherwise a
    fresh timestamp changes the JSON/MD/PDF, the dedup keeps the first blob, and the
    manifest records a hash that no longer matches it."""
    target = str(report_dict.get("target") or "")
    coverage = [str(c) for c in (report_dict.get("coverage") or [])]
    findings, had_invalid = _coerce_findings(report_dict.get("checks_performed"))
    _flag_missing_evidence(findings)
    # Store findings in a TOTAL, deterministic order (severity, check_id, observation)
    # so render_json/markdown/pdf are byte-identical across a durable run's resume — a
    # re-crawled batch must not reorder the report and churn the manifest hash.
    findings = _sev_sort(findings)
    summary = _summarize(findings)

    # completed unless a check that COULD run didn't (NOT_TESTED). UNSUPPORTED is a
    # by-design gap, so it does NOT make the audit "partial".
    status = (
        ReportStatus.PARTIAL if summary.not_tested > 0 else ReportStatus.COMPLETED
    )

    actionable = _sev_sort(
        [f for f in findings if f.status in (FindingStatus.FAIL, FindingStatus.WARN)]
    )
    recommendations = _dedup(f.recommendation for f in actionable if f.recommendation)
    verification = _dedup(
        f.verification
        for f in findings
        if f.status is FindingStatus.FAIL and f.verification
    )
    unsupported = [
        (f.observation or f.check_id)
        for f in findings
        if f.status is FindingStatus.UNSUPPORTED
    ]
    limitations = _dedup(
        [*unsupported, *(str(m) for m in (report_dict.get("missing_data") or []))]
    )

    return ReportEnvelope(
        report_id=report_id_for(stream_id, delegation_id, target),
        source_run_id=stream_id,
        target=target,
        scope=AuditScope(
            type="site" if "crawl.run" in coverage else "page", target=target
        ),
        status=status,
        generated_at=generated_at or _now_iso(),
        methodology=Methodology(name=METHODOLOGY_NAME, version=METHODOLOGY_VERSION),
        provider_provenance=_provenance(coverage),
        coverage=coverage,
        summary=summary,
        findings=findings,
        recommendations=recommendations,
        verification=verification,
        limitations=limitations,
        unsupported_areas=unsupported,
        evidence_freshness=str(report_dict.get("evidence_freshness") or ""),
        confidence=_confidence(findings, summary.not_tested),
        business_exposure=str(report_dict.get("business_exposure") or ""),
        data_quality_note="invalid_evidence_dropped" if had_invalid else "",
    )


def failed_envelope(
    stream_id: str,
    delegation_id: str,
    reason: str,
    target: str = "",
    generated_at: str | None = None,
) -> ReportEnvelope:
    return ReportEnvelope(
        report_id=report_id_for(stream_id, delegation_id, target),
        source_run_id=stream_id,
        target=target,
        status=ReportStatus.FAILED,
        generated_at=generated_at or _now_iso(),
        methodology=Methodology(name=METHODOLOGY_NAME, version=METHODOLOGY_VERSION),
        confidence=ConfidenceLevel.LOW,
        failure_reason=(reason or "the audit did not complete")[:500],
    )


def _dedup(items) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for it in items:
        s = str(it).strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


# --- renderers -------------------------------------------------------------
def render_json(env: ReportEnvelope) -> bytes:
    """Full-fidelity, machine-readable report (findings + evidence references)."""
    return json.dumps(
        env.model_dump(mode="json"), indent=2, ensure_ascii=False
    ).encode("utf-8")


def render_markdown(env: ReportEnvelope) -> str:
    s = env.summary
    lines: list[str] = [
        f"# SEO Audit Report — {env.target or 'target'}",
        "",
        f"- **Status:** {env.status}",
        f"- **Generated:** {env.generated_at}",
        f"- **Methodology:** {env.methodology.name} v{env.methodology.version}",
        f"- **Scope:** {env.scope.type}",
        f"- **Confidence:** {env.confidence} (based on coverage)",
        "",
        "## Overview",
        f"- Total findings: {s.total_findings}",
        f"- Checks: {s.checks_performed} · passed {s.passed} · "
        f"failed {s.failed} · warnings {s.warnings} · not tested {s.not_tested}",
        "- Severity: "
        + ", ".join(f"{k} {v}" for k, v in sorted(s.by_severity.items())),
        "",
        "## Category breakdown",
        "",
        "| Category | Pass | Warn | Fail | Findings |",
        "| --- | --- | --- | --- | --- |",
    ]
    lines += [
        f"| {c.category} | {c.passed} | {c.warned} | {c.failed} | {c.findings} |"
        for c in s.categories
    ]
    lines += ["", "## Findings", ""]
    for f in _sev_sort(env.findings):
        lines.append(f"### [{f.severity}/{f.status}] {f.check_id}")
        if f.observation:
            lines.append(f"- **Observed:** {f.observation}")
        if f.expected:
            lines.append(f"- **Expected:** {f.expected}")
        if f.affected:
            aff = ", ".join(f.affected[:20])
            lines.append(f"- **Affected ({len(f.affected)}):** {aff}")
        if f.recommendation:
            lines.append(f"- **Recommendation:** {f.recommendation}")
        if f.verification:
            lines.append(f"- **Verify:** {f.verification}")
        if f.evidence:
            lines.append(
                "- **Evidence:** "
                + "; ".join(
                    f"{e.tool_id or e.intent}@{e.observed_at or 'n/a'}"
                    for e in f.evidence[:8]
                )
            )
        if f.data_quality_flags:
            lines.append(f"- _data quality: {', '.join(f.data_quality_flags)}_")
        lines.append("")
    if env.business_exposure:
        lines += ["## Business exposure", "", env.business_exposure, ""]
    if env.limitations:
        lines += ["## Limitations & unsupported", ""]
        lines += [f"- {x}" for x in env.limitations]
        lines.append("")
    if env.provider_provenance:
        lines += ["## Provenance", ""]
        for p in env.provider_provenance:
            lines.append(
                f"- **{p.provider}** ({p.freshness}): {len(p.tool_ids)} tools"
            )
        lines.append("")
    return "\n".join(lines)


def _pdf_spec(env: ReportEnvelope) -> dict:
    """Build a filegen FileSpec (dict) from the envelope — reuse the proven PDF path."""
    s = env.summary
    sections: list[dict] = [
        {
            "heading": "Overview",
            "level": 1,
            "bullets": [
                f"Status: {env.status}",
                f"Generated: {env.generated_at}",
                f"Methodology: {env.methodology.name} v{env.methodology.version}",
                f"Confidence: {env.confidence} (based on coverage)",
                f"Total findings: {s.total_findings}",
                f"Checks: {s.checks_performed} (passed {s.passed}, failed {s.failed}, "
                f"warnings {s.warnings}, not tested {s.not_tested})",
            ],
        },
        {
            "heading": "Category breakdown",
            "level": 1,
            "table": {
                "columns": ["Category", "Pass", "Warn", "Fail", "Findings"],
                "rows": [
                    [c.category, c.passed, c.warned, c.failed, c.findings]
                    for c in s.categories
                ],
            },
        },
    ]
    for f in _sev_sort(env.findings):
        body = []
        if f.observation:
            body.append(f"Observed: {f.observation}")
        if f.expected:
            body.append(f"Expected: {f.expected}")
        if f.recommendation:
            body.append(f"Recommendation: {f.recommendation}")
        if f.verification:
            body.append(f"Verify: {f.verification}")
        sections.append(
            {
                "heading": f"[{f.severity}/{f.status}] {f.check_id}",
                "level": 2,
                "text": "\n\n".join(body),
                "bullets": f.affected[:20],
            }
        )
    if env.limitations:
        sections.append(
            {
                "heading": "Limitations & unsupported",
                "level": 1,
                "bullets": env.limitations,
            }
        )
    return {
        "format": "pdf",
        "title": f"SEO Audit — {env.target or 'target'}",
        "subtitle": f"{env.methodology.name} v{env.methodology.version}",
        "sections": sections,
    }


def render_pdf(env: ReportEnvelope) -> bytes:
    """Reuse the filegen renderer (imported lazily so SEO-off never pulls it)."""
    from app.filegen.generate import render_and_validate

    data, _mime, report = render_and_validate(_pdf_spec(env))
    if not report.get("ok", True):
        raise ValueError("pdf validation failed")
    return data


def bound_for_row(env: ReportEnvelope) -> dict:
    """The bounded JSON view stored in the Convex `seoReports` row (card source). Full
    fidelity lives in the JSON artifact; here we trim the heaviest evidence payloads if
    the row would exceed the ~1 MiB document cap, and flag that it was trimmed."""
    row = env.model_dump(mode="json")
    if len(json.dumps(row).encode("utf-8")) <= MAX_ROW_BYTES:
        return row
    # Drop the raw response excerpts first (kept in the JSON artifact).
    for f in row.get("findings", []):
        for e in f.get("evidence", []):
            e["response_excerpt"] = None
    if len(json.dumps(row).encode("utf-8")) > MAX_ROW_BYTES:
        for f in row.get("findings", []):
            f["evidence"] = f.get("evidence", [])[:3]
    row["row_truncated"] = True
    return row


# --- the emitter (built by the runner, called at the delegate seam) --------
ReportEmitter = Callable[..., Awaitable[None]]


def build_seo_report_emitter(writer, settings) -> ReportEmitter:
    """Return an async `emit(kind, report_dict, run_meta, failure_reason="")` bound to
    the live writer. Wired onto the delegator env ONLY when `ai_seo_enabled`."""

    async def _store(env: ReportEnvelope, fmt: str, blob: bytes):
        digest = hashlib.sha256(blob).hexdigest()
        res = await writer.store_artifact(
            blob,
            filename=_filename(env, fmt),
            fmt=fmt,
            mime=_MIME[fmt],
            sha256=digest,
            artifact_key=f"{env.report_id}:{fmt}",
        )
        aid = res.get("artifactId") if isinstance(res, dict) else None
        if not aid:
            return None
        return ReportArtifactRef(
            format=fmt, mime=_MIME[fmt], size=len(blob), sha256=digest,
            artifact_id=str(aid),
        )

    async def emit(
        kind: str, report_dict: object, run_meta: dict, failure_reason: str = ""
    ) -> None:
        if kind != "seo_audit":
            return
        stream_id = str(run_meta.get("stream_id") or "")
        deleg = str(run_meta.get("delegation_id") or "")
        # A durable run passes a fixed generated_at so re-emit on resume is idempotent.
        gen_at = run_meta.get("generated_at") or None
        if isinstance(report_dict, dict):
            env = build_envelope(
                report_dict,
                stream_id=stream_id,
                delegation_id=deleg,
                generated_at=gen_at,
            )
        else:
            env = failed_envelope(
                stream_id, deleg, failure_reason, generated_at=gen_at
            )

        refs: list[ReportArtifactRef] = []
        # JSON is ALWAYS produced — so the ARTIFACT event has a real, non-empty
        # artifact_id (the frontend drops an ARTIFACT event that lacks one).
        jref = await _store(env, "json", render_json(env))
        if jref:
            refs.append(jref)
        if env.status is not ReportStatus.FAILED:
            mref = await _store(env, "md", render_markdown(env).encode("utf-8"))
            if mref:
                refs.append(mref)
            try:
                pref = await _store(env, "pdf", render_pdf(env))
                if pref:
                    refs.append(pref)
            except Exception:  # noqa: BLE001 — PDF is a bonus; never fail the report
                log.warning("seo.report_pdf_failed", extra={"report_id": env.report_id})

        env.manifest = ReportManifest(
            artifacts=refs,
            methodology_version=env.methodology.version,
            generated_at=env.generated_at,
        )
        rep_resp = await writer.store_report(bound_for_row(env))
        # Only surface the card if the row actually persisted — a dangling ARTIFACT
        # event would make the card's getReport throw "Not found" (a console.error
        # that fails the e2e zero-error gate).
        if not (isinstance(rep_resp, dict) and rep_resp.get("ok")):
            log.warning("seo.report_row_failed", extra={"report_id": env.report_id})
            return

        primary = jref.artifact_id if jref else (refs[0].artifact_id if refs else "")
        if not primary:
            log.warning("seo.report_no_artifact", extra={"report_id": env.report_id})
            return
        await writer.emit_event(
            EventType.ARTIFACT,
            artifact_id=primary,
            artifact_type="seo_report",
            metadata={
                "report_id": env.report_id,
                "target": env.target,
                "status": str(env.status),
                "total_findings": env.summary.total_findings,
                "by_severity": env.summary.by_severity,
            },
        )

    return emit
