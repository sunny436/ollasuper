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
from app.blog.capabilities import blog_intent_map
from app.blog.skill import BLOG_SKILL
from app.orchestrator.capabilities import CapabilityResolver
from app.orchestrator.intents import register_intents
from app.orchestrator.orchestrator import AgentRegistry, Orchestrator
from app.research.capabilities import research_intent_map
from app.research.skill import RESEARCH_SKILL
from app.seo.capabilities import seo_intent_map
from app.seo.skill import SEO_SKILL
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


def effective_agents(settings: Settings | None = None) -> list[AgentSpec]:
    """The live agent roster. SEO is NO LONGER a delegated sub-agent — the SEO audit
    runs INLINE in the main turn (guided by SEO_SKILL) and streams a markdown report,
    so the roster is just `PRODUCTION_AGENTS`. `settings` is kept for signature
    compatibility with the skill roster + call sites."""
    return list(PRODUCTION_AGENTS)


def effective_skills(settings: Settings | None = None) -> list[SkillManifest]:
    """The live skill roster for these settings — the static roster plus any
    flag-gated skills. `ai_seo_enabled` appends the ONE SEO skill; OFF (or no
    settings) is byte-identical to `PRODUCTION_SKILLS`."""
    skills = list(PRODUCTION_SKILLS)
    if settings is not None and getattr(settings, "ai_seo_enabled", False):
        skills.append(SEO_SKILL)
    # The Blog Assistant is a SEPARATE flag-gated skill (never merged with SEO).
    if settings is not None and getattr(settings, "ai_blog_enabled", False):
        skills.append(BLOG_SKILL)
    # Deep Research is a SEPARATE flag-gated skill (optional; sibling to SEO/Blog).
    if settings is not None and getattr(settings, "ai_research_enabled", False):
        skills.append(RESEARCH_SKILL)
    return skills


def build_delegate_spec(settings: Settings | None = None) -> dict:
    """A `delegate_to_agent` spec whose `role` is CONSTRAINED (enum) and documented
    to the ACTUAL roster. The static spec advertises example roles that drift from
    the roster, so the model delegates to non-existent roles and every delegation
    fails as 'unknown agent role' (found in Phase-13 prod verification). Deriving the
    enum from the EFFECTIVE roster makes delegation reliable and keeps the tool honest
    as the roster grows (incl. the flag-gated SEO agent) — the name is unchanged, so
    executor routing is unaffected."""
    agents = effective_agents(settings)
    roles = [a.agent_id for a in agents]
    hints = "; ".join(f"'{a.agent_id}' ({a.role})" for a in agents)
    spec = copy.deepcopy(DELEGATE_TOOL_SPEC)
    # Name the ACTUAL roster in the function description too — the static spec's fixed
    # examples ('research'/'data'/'document') omit the flag-gated SEO specialist, so
    # the model never learns to hand an SEO audit to it and does the audit inline
    # (or delegates to a role that isn't offered). Deriving both the description and
    # the enum from the effective roster keeps delegation reliable as it grows.
    spec["function"]["description"] = (
        "Delegate a self-contained sub-task to one of your specialist agents and "
        "receive its structured result. Prefer this whenever a listed specialist "
        "handles the task better than you can inline (e.g. hand a whole-site or "
        "multi-page audit to the matching specialist rather than doing it yourself). "
        f"Available specialists: {hints}. The sub-agent runs with its own tools "
        "under the same safety policy; you observe its result."
    )
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
    if getattr(settings, "ai_seo_enabled", False):
        # Additively register the SEO capability intents (never clobbers a core
        # intent like crawl.run). Idempotent, so repeated builds are safe.
        register_intents(seo_intent_map())
    if getattr(settings, "ai_blog_enabled", False):
        # Additively register the blog capability intents (distinct `blog.*` keys —
        # never clobbers SEO or core intents). Idempotent.
        register_intents(blog_intent_map())
    if getattr(settings, "ai_research_enabled", False):
        # Additively register the deep-research capability intents (distinct
        # `research.*` keys — never clobbers SEO/Blog or core intents). Idempotent.
        register_intents(research_intent_map())
    agent_registry = AgentRegistry([DEFAULT_AGENT, *effective_agents(settings)])
    skill_registry = SkillRegistry(effective_skills(settings))
    orchestrator = Orchestrator(
        resolver=resolver,
        registry=agent_registry,
        settings=settings,
        skills=skill_registry,
    )
    return orchestrator, skill_registry
