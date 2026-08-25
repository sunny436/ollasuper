"""Normalized, provider-agnostic tool metadata for the Tool Registry.

Phase 1 is a CATALOGUE only: these records describe capabilities discovered
from a provider's OpenAPI spec. Nothing here executes a tool and nothing here
is exposed to the LLM. The rest of OllaSuper depends on `ToolDefinition`, never
on Ollagraph-specific shapes.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class SideEffect(StrEnum):
    """Coarse blast-radius classification, for a FUTURE policy layer."""

    READ_ONLY = "read_only"
    EXTERNAL_SIDE_EFFECT = "external_side_effect"
    HIGH_IMPACT = "high_impact"


class Availability(StrEnum):
    AVAILABLE = "available"
    UNAVAILABLE = "unavailable"
    UNKNOWN = "unknown"


class ToolPermissions(BaseModel):
    """Metadata a future authorization engine will enforce. Phase 1 only
    RECORDS it — no enforcement, no engine."""

    model_config = ConfigDict(extra="forbid")

    required_permissions: list[str] = Field(default_factory=list)
    user_scope: bool = False
    workspace_scope: bool = False
    approval_required: bool = False


class ToolCostMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    unit: str = "credits"
    # Ollagraph exposes cost only at runtime via x-credits-* response headers,
    # never in the spec — so it is unknown at discovery time.
    known: bool = False
    source: str = "x-credits-cost response header"


class ToolDefinition(BaseModel):
    """One discovered capability, normalized. `input_schema` may contain raw
    `$ref`s into the provider's component schemas (kept on the registry and
    resolved lazily) — we deliberately do NOT fully dereference here."""

    model_config = ConfigDict(extra="forbid")

    tool_id: str
    name: str
    description: str = ""
    input_schema: dict = Field(default_factory=dict)
    output_schema: dict | None = None
    category: str = "uncategorized"
    provider: str = "ollagraph"
    permissions: ToolPermissions = Field(default_factory=ToolPermissions)
    timeout: float | None = None
    rate_limit: dict | None = None
    cost_metadata: ToolCostMetadata = Field(default_factory=ToolCostMetadata)
    side_effect: SideEffect = SideEffect.READ_ONLY
    enabled: bool = True
    availability: Availability = Availability.AVAILABLE
    # Phase 2: does the PROVIDER honour an idempotency key for this op (so a retry
    # is provider-deduped)? Set at discovery when the op declares an
    # Idempotency-Key param; false otherwise. Ollagraph declares none, so this is
    # false for every current tool. Read-only tools are safe to retry regardless;
    # this only makes a SIDE-EFFECTING tool safe to auto-retry.
    provider_idempotency_supported: bool = False
    version: str = ""
    # Provenance / future request construction. `required_auth` names the
    # provider security scheme this op needs (e.g. BearerAuth vs AdminToken).
    method: str = "post"
    path: str = ""
    required_auth: str = "BearerAuth"


class ToolFilters(BaseModel):
    """Optional metadata filters applied BEFORE ranking (Phase 1 metadata).
    Defaults keep only available + enabled tools; disabled/high-impact are
    surfaced only when explicitly opted into, and always carry their status."""

    model_config = ConfigDict(extra="forbid")

    categories: list[str] | None = None
    providers: list[str] | None = None
    include_disabled: bool = False
    include_unavailable: bool = False
    # Ceiling on blast radius. None = no ceiling (any side_effect allowed).
    max_side_effect: SideEffect | None = None
    # Phase 5: the caller's granted permissions. When set, a tool the caller can
    # never run (its required_permissions are not a subset) is not even ranked —
    # a scope-shaped narrowing that keeps selection aligned with authorization
    # (execution still enforces the resolved set + check_tool_policy). None = no
    # permission prefilter.
    granted_permissions: frozenset[str] | None = None


class ToolCandidate(BaseModel):
    """A ranked tool plus WHY it matched. `reason`/`matched_signals` are for
    debugging + observability, not end-user display."""

    model_config = ConfigDict(extra="forbid")

    tool: ToolDefinition
    score: float
    matched_signals: list[str] = Field(default_factory=list)
    reason: str = ""


class ToolSelectionResult(BaseModel):
    """The output of discovery: metadata only. No execution, no LLM binding."""

    model_config = ConfigDict(extra="forbid")

    query: str
    candidates: list[ToolCandidate] = Field(default_factory=list)
    no_match: bool = False
    stats: dict = Field(default_factory=dict)
