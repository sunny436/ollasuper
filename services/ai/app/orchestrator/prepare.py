"""One shared preparation result for BOTH the batch `Orchestrator.run` and the
live streaming runner. Replaces the old positional 4-tuple from `_prepare_run`
with a named, validated record so the two paths can never drift.

`route_hint` is advisory: KNOWLEDGE_ONLY / INTERACTIVE_TOOLS are emitted today;
SEO_SPECIALIST / DURABLE_RUN are forward-declared for later phases; CLARIFY /
UNSUPPORTED are emitted only in the edge cases below.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.models.tools import ToolCandidate
    from app.skills.manifest import ActiveSkill


class RouteHint(StrEnum):
    KNOWLEDGE_ONLY = "knowledge_only"
    INTERACTIVE_TOOLS = "interactive_tools"
    SEO_SPECIALIST = "seo_specialist"
    DURABLE_RUN = "durable_run"
    CLARIFY = "clarify"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True, slots=True)
class CapabilityGap:
    """A capability a skill asked for that could not be satisfied — surfaced for
    honest reporting rather than silently dropped."""

    intent_or_id: str
    reason: str  # "no_tool" | "unauthorized" | "provider_unavailable"


@dataclass(frozen=True, slots=True)
class ProviderReadiness:
    """Global provider availability (configured + discovered) vs per-user
    readiness (credentials/quota). Kept separate on purpose."""

    provider: str
    available: bool
    user_ready: bool
    reason: str = ""


@dataclass(frozen=True, slots=True)
class PreparedRun:
    """Everything both consumers need from preparation, computed once."""

    active_skills: tuple[ActiveSkill, ...] = ()
    rendered_skills: str = ""
    system_guidance: str = ""
    candidates: tuple[ToolCandidate, ...] = ()
    force_approval_ids: frozenset[str] = frozenset()
    capability_gaps: tuple[CapabilityGap, ...] = ()
    readiness: tuple[ProviderReadiness, ...] = ()
    route_hint: RouteHint = RouteHint.KNOWLEDGE_ONLY
    # Kept off the public field set but handy for OrchestratorResult.active_skills
    # and the runner's `agent.skills_active` log (one canonical shape).
    _meta: tuple[dict, ...] = field(default=(), repr=False)

    @property
    def skill_records(self) -> list[dict]:
        """`[{"id", "version"}, ...]` for OrchestratorResult / logging."""
        return [
            {"id": a.manifest.skill_id, "version": a.manifest.version}
            for a in self.active_skills
        ]
