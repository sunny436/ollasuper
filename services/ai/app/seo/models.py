"""Typed SEO evidence + findings + report (Phase 2, read-only).

Every finding is evidence-backed and status-typed; the report carries coverage,
pass/fail/warn, missing data, freshness, and a QUALITATIVE business-exposure
narrative — deliberately NO 0-100 score (Google explicitly warns against arbitrary
scores). `SEOReport.model_json_schema()` becomes the SEO agent's
`OutputContract.schema`, so the sub-agent's JSON is validated (+ one bounded repair)
by the Phase-1 runtime before it is returned as a `HandoffResult`.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from app.models.tools import SideEffect


class FindingStatus(StrEnum):
    PASS = "PASS"  # noqa: S105 — an audit status, not a credential
    FAIL = "FAIL"
    WARN = "WARN"
    NOT_TESTED = "NOT_TESTED"
    NOT_APPLICABLE = "NOT_APPLICABLE"
    UNSUPPORTED = "UNSUPPORTED"


class Severity(StrEnum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INFO = "info"


class EvidenceRecord(BaseModel):
    """One capability call's provenance-bearing observation — the audit trail
    behind a finding. `extra='forbid'` so a hallucinated field trips the one bounded
    schema repair rather than passing silently."""

    model_config = ConfigDict(extra="forbid")

    tool_id: str = ""
    intent: str = ""
    target: str = ""
    method: str = "post"
    path: str = ""
    side_effect: SideEffect = SideEffect.READ_ONLY
    ok: bool = True
    status_code: int | None = None
    observed_at: str = ""  # ISO-8601 UTC — feeds evidence_freshness
    request: dict = Field(default_factory=dict)
    response_excerpt: dict | None = None  # bounded raw payload
    raw_ref: str = ""  # pointer into the durable execution ledger
    # Phase 4: structured data-quality metadata for first-party evidence (GA4
    # sampling counts, GSC quota, CrUX coverage, timezone/currency). Keep BOUNDED —
    # it counts toward the report row's ~1 MiB cap. Free-form to avoid a per-provider
    # schema; the named string flags on SEOFinding.data_quality_flags remain the
    # primary signal (see app/seo/flags.py).
    quality: dict = Field(default_factory=dict)


class SEOFinding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    check_id: str
    intent: str = ""
    status: FindingStatus
    observation: str = ""  # what was actually seen
    expected: str = ""  # what the rule expects (the normative condition)
    affected: list[str] = Field(default_factory=list)  # URLs/elements
    evidence: list[EvidenceRecord] = Field(default_factory=list)
    severity: Severity = Severity.INFO
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    recommendation: str = ""
    verification: str = ""  # how to reproduce/re-verify
    data_quality_flags: list[str] = Field(default_factory=list)


class SEOReport(BaseModel):
    """The SEO agent's structured result. NO numeric 0-100 score by design —
    business_exposure is a qualitative narrative, and coverage/pass/fail/warn/missing
    are reported separately so the reader sees what was and was not tested."""

    model_config = ConfigDict(extra="forbid")

    target: str
    coverage: list[str] = Field(default_factory=list)  # intents attempted
    checks_performed: list[SEOFinding] = Field(default_factory=list)
    passed: list[str] = Field(default_factory=list)  # check_ids
    failed: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    missing_data: list[str] = Field(default_factory=list)  # NOT_TESTED/UNSUPPORTED
    evidence_freshness: str = ""  # oldest->newest observed_at window
    business_exposure: str = ""  # qualitative risk narrative (NEVER numeric)


# The STRICT SEOReport JSON schema (Pydantic v2, Draft 2020-12). It governs the
# durable-run report, which is assembled from DETERMINISTIC crawl findings, not an
# LLM — so strictness is free there.
OUTPUT_SCHEMA: dict = SEOReport.model_json_schema()

# The LENIENT schema the SEO SUB-AGENT is gated on. Validating an LLM against the
# strict schema (additionalProperties:false + exact scalar types) turned a perfectly
# good audit into a FAILED report on a formatting technicality — a stray extra key,
# or `evidence_freshness` returned as an object instead of a string. `build_envelope`
# already coerces/salvages EVERY field defensively (findings via `_coerce_findings`,
# scalars via `str(... or "")`), so the strict gate was redundant AND harmful. Require
# only that the model returned an object carrying a `checks_performed` array (so the
# report has findings under the key build_envelope reads); leave everything else to
# the salvage layer. The `checks_performed` requirement, plus the repair pass naming
# the allowed keys, keeps a model from hiding its findings under `findings`.
SEO_AGENT_OUTPUT_SCHEMA: dict = {
    "type": "object",
    "required": ["checks_performed"],
    "properties": {"checks_performed": {"type": "array"}},
}


# --- Phase 3: the persisted, downloadable REPORT ENVELOPE ------------------
# The agent's SEOReport (above) is the CORE. The envelope WRAPS it with metadata
# the agent must not self-claim — run identity, timestamps, methodology version,
# provider provenance — all added server-side by the emission layer. The agent's
# OUTPUT_SCHEMA is deliberately NOT extended, so the Phase-2 contract is unchanged.


class ReportStatus(StrEnum):
    COMPLETED = "completed"  # every applicable, supported check ran
    PARTIAL = "partial"  # some checks NOT_TESTED (tool failure/timeout)
    FAILED = "failed"  # the agent produced no valid report


class ConfidenceLevel(StrEnum):
    """QUALITATIVE audit confidence, derived from coverage + data-quality flags.
    Deliberately NOT a 0-100 number (Google warns against arbitrary scores)."""

    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class Methodology(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = "OllaSuper SEO Methodology"
    version: str = ""


class AuditScope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str = "page"  # "page" | "site"
    target: str = ""
    pages_analyzed: int | None = None  # populated only when a crawl ran
    notes: str = ""


class ProviderProvenance(BaseModel):
    """Which provider + tools produced the evidence — the audit's supply chain."""

    model_config = ConfigDict(extra="forbid")

    provider: str = "ollagraph"
    tool_ids: list[str] = Field(default_factory=list)
    freshness: str = "live"
    permissions: list[str] = Field(default_factory=list)


class CategoryRollup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: str
    passed: int = 0
    warned: int = 0
    failed: int = 0
    findings: int = 0


class ReportSummary(BaseModel):
    """Evidence-grounded counts ONLY — no composite score."""

    model_config = ConfigDict(extra="forbid")

    total_findings: int = 0
    by_severity: dict[str, int] = Field(default_factory=dict)
    checks_performed: int = 0
    passed: int = 0
    failed: int = 0
    warnings: int = 0
    not_tested: int = 0
    categories: list[CategoryRollup] = Field(default_factory=list)


class ReportArtifactRef(BaseModel):
    """One downloadable rendering of the report (md/json/pdf) + its integrity hash.
    `artifact_id` is the `chatArtifacts` row id (safe to expose; NOT a storageId)."""

    model_config = ConfigDict(extra="forbid")

    format: str
    mime: str
    size: int = 0
    sha256: str = ""
    artifact_id: str = ""


class ReportManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artifacts: list[ReportArtifactRef] = Field(default_factory=list)
    methodology_version: str = ""
    generated_at: str = ""


class ReportEnvelope(BaseModel):
    """The full persisted report. Server-authoritative metadata + the agent's
    findings. `extra='forbid'` so a stray key is caught, not silently stored."""

    model_config = ConfigDict(extra="forbid")

    report_id: str
    source_run_id: str = ""  # = streamId (the run identity)
    target: str = ""
    scope: AuditScope = Field(default_factory=AuditScope)
    status: ReportStatus = ReportStatus.COMPLETED
    generated_at: str = ""  # server ISO-8601 UTC
    methodology: Methodology = Field(default_factory=Methodology)
    provider_provenance: list[ProviderProvenance] = Field(default_factory=list)
    coverage: list[str] = Field(default_factory=list)  # intents attempted
    summary: ReportSummary = Field(default_factory=ReportSummary)
    findings: list[SEOFinding] = Field(default_factory=list)
    recommendations: list[str] = Field(default_factory=list)
    verification: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    unsupported_areas: list[str] = Field(default_factory=list)
    evidence_freshness: str = ""
    confidence: ConfidenceLevel = ConfidenceLevel.MEDIUM  # qualitative, not numeric
    business_exposure: str = ""  # qualitative narrative (NEVER numeric)
    manifest: ReportManifest | None = None
    failure_reason: str = ""  # populated only when status == FAILED
    data_quality_note: str = ""  # e.g. "invalid_evidence_dropped"
