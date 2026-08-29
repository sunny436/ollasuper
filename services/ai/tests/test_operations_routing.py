"""Operations capability — autonomous jargon-free routing + flag-gated registration.
The Operations router must activate on plain-language operations questions, add NO
delegated agent, never hijack the siblings, and be byte-identical when off."""

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
    return make_settings("http://x", ai_operations_enabled=True, **extra)


def _off():
    return make_settings("http://x", ai_operations_enabled=False)


def _roles(settings):
    return build_delegate_spec(settings)["function"]["parameters"]["properties"][
        "role"
    ]["enum"]


def test_flag_off_roster_unchanged():
    assert effective_agents(_off()) == PRODUCTION_AGENTS
    assert effective_skills(_off()) == PRODUCTION_SKILLS
    assert "operations" not in _roles(_off())


def test_flag_on_adds_one_skill_no_agent():
    agents, skills = effective_agents(_on()), effective_skills(_on())
    assert agents == list(PRODUCTION_AGENTS)
    assert [s.skill_id for s in skills].count("operations") == 1
    assert len(skills) == len(PRODUCTION_SKILLS) + 1
    assert "operations" not in _roles(_on())


def _top(q, settings=None):
    t = SkillRegistry(effective_skills(settings or _on())).discover(q)
    return t[0].manifest.skill_id if t else None


def test_plain_language_routes_to_operations():
    cases = {
        "vendor_eval": "evaluate this vendor proposal",
        "vendor_renew": "is this vendor worth renewing",
        "vendor_choose": "which vendor should we choose",
        "sop": "turn this process into an SOP",
        "slow_process": "why is our onboarding process so slow",
        "bottleneck": "where are our biggest bottlenecks",
        "change": "we're changing our deployment workflow, what could go wrong",
        "change_req": "create a change request for this migration",
        "capacity": "how many people do we need next quarter",
        "overloaded": "is my team overloaded",
        "understaffed": "are we understaffed",
        "risk": "what are our biggest operational risks",
        "compliance": "create a compliance tracker",
        "status": "make a weekly operations report",
        "runbook": "create a runbook for monthly close",
        "waste": "how can we reduce operational waste",
        "raci": "build a RACI for our offboarding process",
    }
    for name, q in cases.items():
        assert _top(q) == "operations", f"{name}: {q!r} -> {_top(q)}"


def test_operations_does_not_hijack_siblings():
    s = _on(
        ai_seo_enabled=True,
        ai_blog_enabled=True,
        ai_research_enabled=True,
        ai_data_analysis_enabled=True,
        ai_sales_enabled=True,
        ai_hr_enabled=True,
        ai_finance_enabled=True,
        ai_marketing_enabled=True,
    )

    def top(q):
        t = SkillRegistry(effective_skills(s)).discover(q)
        return t[0].manifest.skill_id if t else None

    assert top("create a financial forecast") == "finance"
    assert top("analyze employee attrition") == "hr"
    assert top("analyze our sales pipeline and forecast quota") == "sales"
    assert top("analyze this csv") == "data-analysis"
    assert top("write a blog about operational efficiency") == "blog-assist"
    assert top("research itsm best practices deeply with sources") == "deep-research"
    assert top("create a go-to-market strategy") == "marketing"
    assert not SkillRegistry(effective_skills(s)).discover("say hello to me")


def test_flag_off_never_activates():
    t = SkillRegistry(effective_skills(_off())).discover(
        "evaluate this vendor and create a runbook"
    )
    assert "operations" not in {a.manifest.skill_id for a in t}


def test_operations_coexists_with_all_flags_on():
    s = _on(
        ai_seo_enabled=True,
        ai_blog_enabled=True,
        ai_research_enabled=True,
        ai_data_analysis_enabled=True,
        ai_sales_enabled=True,
        ai_hr_enabled=True,
        ai_finance_enabled=True,
        ai_marketing_enabled=True,
    )
    reg = SkillRegistry(effective_skills(s))
    assert (
        reg.discover("evaluate this vendor proposal")[0].manifest.skill_id
        == "operations"
    )
    assert (
        reg.discover("audit example.com technical seo")[0].manifest.skill_id
        == "seo-audit"
    )
