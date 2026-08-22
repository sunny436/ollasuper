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
    version: str = ""
    # Provenance / future request construction. `required_auth` names the
    # provider security scheme this op needs (e.g. BearerAuth vs AdminToken).
    method: str = "post"
    path: str = ""
    required_auth: str = "BearerAuth"
