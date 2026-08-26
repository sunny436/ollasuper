"""Production agent + skill roster for the live orchestrated runtime (Phase 13).

Declarative rosters: adding a specialist or a skill is an edit to THESE lists,
never to `runner.py` or a central router (the QA-11 modularity property). The
runner wires them into the EXISTING streaming single-agent path — skills as
system-prompt guidance, `delegate_to_agent`/`find_capabilities` as tools — so
token streaming, crash-resume, approval-suspend and cancellation are all
preserved (only the sub-agent's own reasoning runs batch, as a tool observation).

SAFETY: every specialist is READ-ONLY (`side_effects_allowed=False`). Delegation
sub-agents therefore never carry a side effect, so the Phase-2 at-most-once
guarantee holds even if a crashed delegation resumes (a re-run only repeats
read-only tools). Side-effecting work stays with the top agent, approval-gated.
"""

from __future__ import annotations

import copy
from typing import TYPE_CHECKING

from app.agent.orchestration_tools import DELEGATE_TOOL_SPEC
from app.agent.spec import (
    DEFAULT_AGENT,
    AgentSpec,
    CapabilityPolicy,
    ContextPolicy,
)
from app.orchestrator.capabilities import CapabilityResolver
from app.orchestrator.orchestrator import AgentRegistry, Orchestrator
from app.skills.manifest import SkillManifest
from app.skills.registry import SkillRegistry

if TYPE_CHECKING:
    from app.config import Settings

# Read-only capability ceiling shared by every specialist.
_RO = CapabilityPolicy(tool_ids=None, include_shared=True, side_effects_allowed=False)
# A pure-synthesis agent: no tools at all (empty allowlist).
_NO_TOOLS = CapabilityPolicy(tool_ids=frozenset(), side_effects_allowed=False)


PRODUCTION_AGENTS: list[AgentSpec] = [
    AgentSpec(
        agent_id="research",
        role="research specialist",
        instructions=(
            "You are a research specialist. Gather information from multiple "
            "independent sources, cross-check claims, separate well-supported facts "
            "from speculation, and be explicit about what you relied on. Prefer "
            "primary and recent sources for fast-changing topics."
        ),
        capability=_RO,
        context=ContextPolicy(max_steps=6, tool_result_max_chars=8000),
    ),
    AgentSpec(
        agent_id="data",
        role="data analyst",
        instructions=(
            "You are a data analyst. Reason quantitatively and carefully: state your "
            "assumptions, show the key steps, compute precisely, distinguish "
            "correlation from causation, and flag uncertainty or missing data rather "
            "than guessing."
        ),
        capability=_RO,
        context=ContextPolicy(max_steps=5, tool_result_max_chars=8000),
    ),
    AgentSpec(
        agent_id="writer",
        role="writing specialist",
        instructions=(
            "You are a writing specialist. Turn findings into a clear, well-structured "
            "answer: lead with the conclusion, organize with short sections or lists "
            "when useful, stay concise, and remain faithful to the inputs."
        ),
        capability=_NO_TOOLS,
        context=ContextPolicy(max_steps=2, tool_result_max_chars=4000),
    ),
]


PRODUCTION_SKILLS: list[SkillManifest] = [
    SkillManifest(
        skill_id="research-methodology",
        name="Research Methodology",
        purpose="rigorous multi-source research",
        when_to_use="researching a topic, investigating, or verifying claims",
        tags=frozenset(
            {"research", "investigate", "sources", "verify", "compare", "evidence"}
        ),
        methodology=(
            "Identify exactly what must be established. Gather from multiple "
            "independent sources; cross-check the key claims; separate fact from "
            "speculation; state confidence and cite what you used."
        ),
    ),
    SkillManifest(
        skill_id="data-analysis",
        name="Data Analysis",
        purpose="careful quantitative analysis",
        when_to_use="analyzing data, numbers, metrics, or statistics",
        tags=frozenset(
            {"data", "analyze", "statistics", "calculate", "metrics", "quantitative"}
        ),
        methodology=(
            "State assumptions; show the key computation steps; compute precisely; "
            "distinguish correlation from causation; report uncertainty and any gaps."
        ),
    ),
    SkillManifest(
        skill_id="report-writing",
        name="Report Writing",
        purpose="clear, structured, actionable reporting",
        when_to_use="producing a report, summary, comparison, or recommendation",
        tags=frozenset(
            {"report", "summary", "recommendation", "compare", "brief", "actionable"}
        ),
        methodology=(
            "Lead with the conclusion; support it with evidence; structure with short "
            "headings or lists; end with clear, actionable next steps."
        ),
    ),
    SkillManifest(
        skill_id="software-engineering",
        name="Software Engineering",
        purpose="correct, readable code",
        when_to_use="writing, debugging, refactoring, or reviewing code",
        tags=frozenset(
            {"code", "coding", "debug", "function", "programming", "refactor"}
        ),
        methodology=(
            "Clarify the requirement; write the simplest correct solution; handle the "
            "obvious edge cases; explain briefly; note assumptions and complexity."
        ),
    ),
]


def build_delegate_spec() -> dict:
    """A `delegate_to_agent` spec whose `role` is CONSTRAINED (enum) and documented
    to the ACTUAL roster. The static spec advertises example roles that drift from
    the roster, so the model delegates to non-existent roles and every delegation
    fails as 'unknown agent role' (found in Phase-13 prod verification). Deriving the
    enum from PRODUCTION_AGENTS makes delegation reliable and keeps the tool honest
    as the roster grows — the name is unchanged, so executor routing is unaffected."""
    roles = [a.agent_id for a in PRODUCTION_AGENTS]
    hints = "; ".join(f"'{a.agent_id}' ({a.role})" for a in PRODUCTION_AGENTS)
    spec = copy.deepcopy(DELEGATE_TOOL_SPEC)
    role = spec["function"]["parameters"]["properties"]["role"]
    role["enum"] = roles
    role["description"] = (
        f"The specialist to delegate to — MUST be one of: {hints}."
    )
    return spec


def build_live_runtime(
    settings: Settings, resolver: CapabilityResolver
) -> tuple[Orchestrator, SkillRegistry]:
    """Assemble the orchestrator (for its tested delegator) + skill registry from
    the production roster. The orchestrator is used ONLY for `_make_delegator` and
    skill discovery — the live runner keeps its own streaming graph; it never calls
    `orchestrator.run` (which is batch)."""
    agent_registry = AgentRegistry([DEFAULT_AGENT, *PRODUCTION_AGENTS])
    skill_registry = SkillRegistry(PRODUCTION_SKILLS)
    orchestrator = Orchestrator(
        resolver=resolver,
        registry=agent_registry,
        settings=settings,
        skills=skill_registry,
    )
    return orchestrator, skill_registry
