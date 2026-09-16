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
from collections.abc import Callable
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
from app.data.skill import DATA_SKILL
from app.documents.capabilities import documents_intent_map
from app.documents.skill import DOCUMENTS_SKILL
from app.finance.capabilities import finance_intent_map
from app.finance.equity import EQUITY_SKILL
from app.finance.skill import FINANCE_SKILL
from app.hr.capabilities import hr_intent_map
from app.hr.skill import HR_SKILL
from app.marketing.capabilities import marketing_intent_map
from app.marketing.skill import MARKETING_SKILL
from app.operations.capabilities import operations_intent_map
from app.operations.skill import OPERATIONS_SKILL
from app.orchestrator.capabilities import CapabilityResolver
from app.orchestrator.intents import register_intents
from app.orchestrator.orchestrator import AgentRegistry, Orchestrator
from app.research.capabilities import research_intent_map
from app.research.skill import RESEARCH_SKILL
from app.sales.capabilities import sales_intent_map
from app.sales.skill import SALES_SKILL
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
        metadata={"category": "Research"},
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
        metadata={"category": "Data & Analytics"},
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
        metadata={"category": "Content & Writing"},
        name="Report Writing",
        purpose="clear, structured, actionable reporting",
        when_to_use="producing a report, summary, comparison, or recommendation",
        tags=frozenset(
            {"report", "summary", "recommendation", "compare", "brief", "actionable"}
        ),
        methodology=(
            "Lead with the conclusion; support it with evidence; structure with short "
            "headings or lists; end with clear, actionable next steps. Before "
            "delivering, run the internal writing-quality pass on the finished text "
            "(`humanize_check` detect, then revise-and-verify only if it says "
            "'revise'); it changes voice, never facts, and is never mentioned in the "
            "answer."
        ),
    ),
    SkillManifest(
        skill_id="software-engineering",
        metadata={"category": "Coding"},
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
    # Data Analysis: when enabled, the full compute-backed DATA_SKILL REPLACES the
    # tiny generic "data-analysis" methodology (same skill_id) so routing isn't split.
    # OFF => the generic one stays (no regression).
    if settings is not None and getattr(settings, "ai_data_analysis_enabled", False):
        skills = [s for s in skills if s.skill_id != DATA_SKILL.skill_id]
        skills.append(DATA_SKILL)
    # The Sales Assistant is a SEPARATE flag-gated skill (never merged with the others).
    if settings is not None and getattr(settings, "ai_sales_enabled", False):
        skills.append(SALES_SKILL)
    # The HR Assistant is a SEPARATE flag-gated skill (never merged with the others).
    if settings is not None and getattr(settings, "ai_hr_enabled", False):
        skills.append(HR_SKILL)
    # Finance = TWO separate flag-gated skills under ONE flag (corporate FP&A/SaaS/
    # investment + listed-stock Equity Research); never merged with the others.
    if settings is not None and getattr(settings, "ai_finance_enabled", False):
        skills.append(FINANCE_SKILL)
        skills.append(EQUITY_SKILL)
    # Marketing = ONE flag-gated router skill that composes with the siblings.
    if settings is not None and getattr(settings, "ai_marketing_enabled", False):
        skills.append(MARKETING_SKILL)
    # Operations = ONE flag-gated router skill; composes with the siblings (HR pattern).
    if settings is not None and getattr(settings, "ai_operations_enabled", False):
        skills.append(OPERATIONS_SKILL)
    # Documents = ONE flag-gated router skill (PPTX + PDF create/read/edit/process with
    # inline preview); composes with the siblings, steers generate_file + document_ops.
    if settings is not None and getattr(settings, "ai_documents_enabled", False):
        skills.append(DOCUMENTS_SKILL)
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
    role["description"] = f"The specialist to delegate to — MUST be one of: {hints}."
    return spec


# (flag, intent-map builder) — ONE table, because there are now two readers.
#
# Every domain's intents live under a distinct prefix (`blog.*`, `seo.*`, …) and
# `register_intents` never overwrites an existing key, so registration is
# additive and idempotent whatever the order. That was already true; what is new
# is that the PICKER needs the same list to tell a user which capabilities their
# skill may name. Two hand-maintained copies of "which flag turns on which
# intents" would drift the moment a capability is added, and the symptom would
# be a capability that works at runtime but is missing from the menu.
_INTENT_SOURCES: tuple[tuple[str, Callable[[], dict]], ...] = (
    ("ai_seo_enabled", seo_intent_map),
    ("ai_blog_enabled", blog_intent_map),
    ("ai_research_enabled", research_intent_map),
    ("ai_sales_enabled", sales_intent_map),
    ("ai_hr_enabled", hr_intent_map),
    ("ai_finance_enabled", finance_intent_map),
    ("ai_marketing_enabled", marketing_intent_map),
    ("ai_operations_enabled", operations_intent_map),
    ("ai_documents_enabled", documents_intent_map),
)


def effective_intent_maps(settings: Settings | None) -> dict[str, dict]:
    """Every intent this deployment has, WITHOUT touching the global map.

    Pure on purpose: the catalogue is served from a GET route that may run
    before any generation has, so reading the global `INTENT_MAP` would report
    an empty deployment until the first chat happened to populate it. Composing
    it here is deterministic and has no startup order to get wrong.
    """
    out: dict[str, dict] = {}
    for flag, build in _INTENT_SOURCES:
        if settings is not None and getattr(settings, flag, False):
            out.update(build())
    return out


def build_live_runtime(
    settings: Settings, resolver: CapabilityResolver
) -> tuple[Orchestrator, SkillRegistry]:
    """Assemble the orchestrator (for its tested delegator) + skill registry from
    the production roster. The orchestrator is used ONLY for `_make_delegator` and
    skill discovery — the live runner keeps its own streaming graph; it never calls
    `orchestrator.run` (which is batch)."""
    # Additive and idempotent: distinct per-domain prefixes, and
    # `register_intents` never clobbers an existing key (so a core intent like
    # `crawl.run` cannot be redefined by a feature). Repeated builds are safe.
    for name, spec in effective_intent_maps(settings).items():
        register_intents({name: spec})
    agent_registry = AgentRegistry([DEFAULT_AGENT, *effective_agents(settings)])
    skill_registry = SkillRegistry(effective_skills(settings))
    orchestrator = Orchestrator(
        resolver=resolver,
        registry=agent_registry,
        settings=settings,
        skills=skill_registry,
    )
    return orchestrator, skill_registry
