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


# The JSON-schema dict the SEO agent's OutputContract.schema uses. Pydantic v2 emits
# Draft 2020-12 with $defs/$ref, resolved natively by the Phase-1 jsonschema.validate.
OUTPUT_SCHEMA: dict = SEOReport.model_json_schema()
