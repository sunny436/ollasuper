"""Phase 2 (SEO) — autonomous routing + flag-gated registration. The routing is
model-driven, but its INPUTS are deterministic: the SEO skill must activate on SEO
requests (and only those), the SEO agent must be delegatable when the flag is on,
and the whole surface must be byte-identical (no skill, no agent, no delegate role)
when the flag is off.
"""

from __future__ import annotations

from app.orchestrator.capabilities import CapabilityResolver
from app.orchestrator.intents import INTENT_MAP, is_intent
from app.runtime.roster import (
    PRODUCTION_AGENTS,
    PRODUCTION_SKILLS,
    build_delegate_spec,
    build_live_runtime,
    effective_agents,
    effective_skills,
)
from app.skills.registry import SkillRegistry
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.conftest import make_settings


def _on():
    return make_settings("http://x", ai_seo_enabled=True)


def _off():
    return make_settings("http://x", ai_seo_enabled=False)


def _delegate_roles(settings) -> list[str]:
    spec = build_delegate_spec(settings)
    return spec["function"]["parameters"]["properties"]["role"]["enum"]


# --- flag OFF is byte-identical --------------------------------------------
def test_flag_off_roster_is_unchanged():
    assert effective_agents(_off()) == PRODUCTION_AGENTS
    assert effective_skills(_off()) == PRODUCTION_SKILLS
    assert "seo" not in _delegate_roles(_off())
    # No-arg call (existing behavior) is also unchanged.
    assert _delegate_roles(None) == [a.agent_id for a in PRODUCTION_AGENTS]


def test_flag_off_seo_skill_never_activates():
    reg = SkillRegistry(effective_skills(_off()))
    top = reg.discover("audit this website's SEO and check the robots.txt")
    ids = {a.manifest.skill_id for a in top}
    assert "seo-audit" not in ids


# --- flag ON registers exactly one skill + one agent -----------------------
def test_flag_on_appends_one_skill_and_one_agent():
    agents = effective_agents(_on())
    skills = effective_skills(_on())
    assert [a for a in agents if a.agent_id == "seo"], "SEO agent not registered"
    assert len(agents) == len(PRODUCTION_AGENTS) + 1  # exactly ONE agent added
    assert len([s for s in skills if s.skill_id == "seo-audit"]) == 1
    assert len(skills) == len(PRODUCTION_SKILLS) + 1  # exactly ONE skill added
    assert "seo" in _delegate_roles(_on())


# --- the SEO skill activates on SEO requests (and only those) --------------
def _discover_top(query: str) -> str | None:
    reg = SkillRegistry(effective_skills(_on()))
    top = reg.discover(query)
    return top[0].manifest.skill_id if top else None


def test_seo_skill_is_top_for_seo_requests():
    for q in (
        "run an SEO audit of example.com",
        "why is my page not indexing — check robots and canonical",
        "validate the structured data and check the redirect chain",
        "inspect the sitemap and find broken links on the site",
    ):
        assert _discover_top(q) == "seo-audit", q


def test_seo_skill_does_not_hijack_unrelated_requests():
    # A data/analysis request should NOT surface the SEO skill on top.
    reg = SkillRegistry(effective_skills(_on()))
    top = reg.discover("analyze this sales data and compute the statistics")
    assert top and top[0].manifest.skill_id == "data-analysis"
    # A greeting activates no skill at all.
    assert not reg.discover("say hello to me")


# --- the delegate enum resolves every offered role -------------------------
def test_every_delegate_role_is_registered_on():
    roles = set(_delegate_roles(_on()))
    registered = {a.agent_id for a in effective_agents(_on())}
    assert roles <= registered
    assert "seo" in roles


def test_delegate_description_names_the_seo_specialist_when_enabled():
    # The function-level description (not just the role enum) must advertise the
    # flag-gated SEO specialist, so the model delegates a whole-site audit to it
    # instead of doing the audit inline.
    desc = build_delegate_spec(_on())["function"]["description"]
    assert "seo" in desc and "SEO specialist" in desc
    assert "'document'" not in desc  # no stale hardcoded example list


# --- build_live_runtime wires the SEO surface + intents when the flag is on -
def _resolver() -> CapabilityResolver:
    reg = ToolRegistry()
    return CapabilityResolver(reg, ToolSelector(reg))


def test_build_live_runtime_on_registers_agent_skill_and_intents():
    orch, skill_reg = build_live_runtime(_on(), _resolver())
    # the SEO agent is delegatable through the orchestrator registry...
    assert orch._registry.get("seo") is not None
    # ...the SEO skill is discoverable...
    assert skill_reg.get("seo-audit") is not None
    # ...and the SEO capability intents resolved into the global map WITHOUT
    # clobbering the pre-existing core `crawl.run` (still external-side-effect).
    assert is_intent("metadata.audit")
    assert INTENT_MAP["crawl.run"]["max_side_effect"].value == "external_side_effect"


def test_build_live_runtime_off_omits_seo():
    orch, skill_reg = build_live_runtime(_off(), _resolver())
    assert orch._registry.get("seo") is None
    assert skill_reg.get("seo-audit") is None
