"""Sales Assistant — autonomous routing + flag-gated registration. Routing is
model-driven but its INPUTS are deterministic: the Sales skill must activate on sales
requests (each of the 10 workflows) and only those, add NO delegated agent, and the
whole surface must be byte-identical when the flag is off.
"""

from __future__ import annotations

from app.runtime.roster import (
    PRODUCTION_AGENTS,
    PRODUCTION_SKILLS,
    build_delegate_spec,
    effective_agents,
    effective_skills,
)
from app.skills.registry import SkillRegistry
from tests.conftest import make_settings


def _on(**extra):
    return make_settings("http://x", ai_sales_enabled=True, **extra)


def _off():
    return make_settings("http://x", ai_sales_enabled=False)


def _delegate_roles(settings) -> list[str]:
    spec = build_delegate_spec(settings)
    return spec["function"]["parameters"]["properties"]["role"]["enum"]


# --- flag OFF is byte-identical --------------------------------------------
def test_flag_off_roster_is_unchanged():
    assert effective_agents(_off()) == PRODUCTION_AGENTS
    assert effective_skills(_off()) == PRODUCTION_SKILLS
    assert "sales" not in _delegate_roles(_off())


# --- flag ON registers the SKILL only (Sales is NOT a delegated agent) ------
def test_flag_on_appends_the_skill_and_no_agent():
    agents = effective_agents(_on())
    skills = effective_skills(_on())
    assert not [a for a in agents if a.agent_id == "sales"], "Sales is not an agent"
    assert agents == list(PRODUCTION_AGENTS)  # roster unchanged by the flag
    assert len([s for s in skills if s.skill_id == "sales"]) == 1
    assert len(skills) == len(PRODUCTION_SKILLS) + 1  # exactly ONE skill added
    assert "sales" not in _delegate_roles(_on())


# --- the Sales skill activates on EACH of the 10 workflow intents -----------
def _top(query: str, settings=None) -> str | None:
    reg = SkillRegistry(effective_skills(settings or _on()))
    top = reg.discover(query)
    return top[0].manifest.skill_id if top else None


def test_sales_skill_is_top_for_each_workflow():
    # One natural-language phrasing per capability (Section-7 style).
    cases = {
        "account_research": "research this company before my sales call",
        "call_prep": "prepare me for a discovery call with Acme Corp",
        "outreach": "write a personalized cold outreach email to this prospect",
        "call_summary": "summarize this sales call transcript and pull action items",
        "pipeline_review": "review my pipeline and tell me which deals to focus on",
        "forecast": "forecast my quarter from this pipeline and will I hit quota",
        "competitive_intel": "create a competitive battlecard versus Competitor X",
        "asset": "create a sales one-pager for this prospect",
        "daily_briefing": "give me my daily sales briefing",
        "deal_strategy": "why is this deal at risk and what should I do next",
    }
    for name, q in cases.items():
        assert _top(q) == "sales", f"{name}: {q!r} -> {_top(q)}"


# --- the Sales skill does NOT hijack the sibling capabilities ---------------
def test_sales_does_not_hijack_other_capabilities():
    settings = _on(
        ai_seo_enabled=True,
        ai_blog_enabled=True,
        ai_research_enabled=True,
        ai_data_analysis_enabled=True,
    )
    reg = SkillRegistry(effective_skills(settings))

    def top(q):
        t = reg.discover(q)
        return t[0].manifest.skill_id if t else None

    assert top("analyze this sales data and compute the statistics") == "data-analysis"
    assert top("write a blog post about sales enablement") == "blog-assist"
    assert top("run an SEO audit of example.com robots canonical") == "seo-audit"
    assert top("research the AI agent market deeply with sources") == "deep-research"
    assert top("analyze this csv and show me the trends") == "data-analysis"
    # a greeting activates no skill at all
    assert not reg.discover("say hello to me")


def test_flag_off_sales_skill_never_activates():
    reg = SkillRegistry(effective_skills(_off()))
    top = reg.discover("research this prospect and draft outreach for my sales call")
    assert "sales" not in {a.manifest.skill_id for a in top}


# --- Sales coexists with every sibling flag on ------------------------------
def test_sales_coexists_with_all_flags_on():
    settings = _on(
        ai_seo_enabled=True,
        ai_blog_enabled=True,
        ai_research_enabled=True,
        ai_data_analysis_enabled=True,
    )
    reg = SkillRegistry(effective_skills(settings))
    assert reg.discover("draft a cold email to this prospect")[0].manifest.skill_id == (
        "sales"
    )
    assert reg.discover("audit example.com technical SEO")[0].manifest.skill_id == (
        "seo-audit"
    )
    assert reg.discover("write a blog about kubernetes")[0].manifest.skill_id == (
        "blog-assist"
    )
