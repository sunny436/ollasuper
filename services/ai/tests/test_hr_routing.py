"""HR Assistant — routing + flag-gated registration. All 12 named capabilities are
tested individually (the 3 folders that carry two names each are asserted under BOTH),
plus anti-hijack against Data/Blog/SEO/Research and the correct composition cases."""

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
    return make_settings("http://x", ai_hr_enabled=True, **extra)


def _off():
    return make_settings("http://x", ai_hr_enabled=False)


def _delegate_roles(settings) -> list[str]:
    spec = build_delegate_spec(settings)
    return spec["function"]["parameters"]["properties"]["role"]["enum"]


def _reg(settings=None):
    return SkillRegistry(effective_skills(settings or _on()))


def _top(query, settings=None):
    t = _reg(settings).discover(query)
    return t[0].manifest.skill_id if t else None


def _activates(query, settings=None):
    return "hr" in {a.manifest.skill_id for a in _reg(settings).discover(query)}


# --- flag OFF is byte-identical --------------------------------------------
def test_flag_off_roster_is_unchanged():
    assert effective_agents(_off()) == PRODUCTION_AGENTS
    assert effective_skills(_off()) == PRODUCTION_SKILLS
    assert "hr" not in _delegate_roles(_off())


def test_flag_on_appends_the_skill_and_no_agent():
    agents = effective_agents(_on())
    skills = effective_skills(_on())
    assert not [a for a in agents if a.agent_id == "hr"], "HR is not an agent"
    assert agents == list(PRODUCTION_AGENTS)
    assert len([s for s in skills if s.skill_id == "hr"]) == 1
    assert len(skills) == len(PRODUCTION_SKILLS) + 1
    assert "hr" not in _delegate_roles(_on())


# --- the HR skill is TOP for the 10 clearly-HR capability phrasings ---------
def test_hr_is_top_for_each_workflow():
    cases = {
        "recruiting-pipeline": "analyze my hiring pipeline and find the bottlenecks",
        "candidate-eval": "evaluate and compare these candidates for the role",
        "interview-prep": "prepare interview questions and a scorecard for a Staff "
        "Engineer",
        "draft-offer": "draft a job offer for this candidate",
        "onboarding": "build a 30/60/90 onboarding plan for a new hire",
        "performance-review": "write a performance review from these notes",
        "policy-lookup": "what is our PTO policy",
        "employee-handbook": "explain the remote work section of our employee handbook",
        "people-report": "generate a headcount and attrition report",
        "people-analytics": "which teams have the highest attrition",
        "org-planning": "design an org structure and headcount plan for this team",
        "comp-band": "review our salary bands and flag underpaid employees",
    }
    for name, q in cases.items():
        assert _top(q) == "hr", f"{name}: {q!r} -> {_top(q)}"


# --- the two COMPOSITIONAL comp capabilities: HR must ACTIVATE (compose) ----
def test_comp_analysis_and_benchmarking_activate_hr():
    # A comp CSV composes HR + Data Analysis; a market benchmark composes HR + Research.
    # HR need not be #1, but it MUST activate so its methodology is in the prompt.
    assert _activates(
        "analyze this compensation data for outliers and band placement",
        _on(ai_data_analysis_enabled=True),
    )
    assert _activates(
        "benchmark a Staff Engineer's total compensation in SF against the market",
        _on(ai_research_enabled=True),
    )


# --- HR does NOT hijack the sibling capabilities ---------------------------
def test_hr_does_not_hijack_others():
    settings = _on(
        ai_seo_enabled=True,
        ai_blog_enabled=True,
        ai_research_enabled=True,
        ai_data_analysis_enabled=True,
        ai_sales_enabled=True,
    )
    assert _top("analyze this csv and show trends", settings) == "data-analysis"
    assert _top("analyze the quarterly revenue data", settings) == "data-analysis"
    assert _top("write a blog about employee onboarding", settings) == "blog-assist"
    assert _top("run an seo audit of our careers page", settings) == "seo-audit"
    assert (
        _top("research employment law trends deeply with sources", settings)
        == "deep-research"
    )
    assert not _reg(settings).discover("say hello to me")


def test_flag_off_hr_skill_never_activates():
    top = _reg(_off()).discover("draft a job offer and an onboarding plan for a hire")
    assert "hr" not in {a.manifest.skill_id for a in top}


def test_qa_report_phrasings_route_to_hr():
    """Measured before the vocabulary fix: a job-description request scored hr at
    0.05; a remote-work policy, a career ladder and a termination decision
    activated no skill at all."""
    cases = [
        "Write a job description for a Senior Backend Engineer.",
        "Create a remote work policy covering eligibility, hours, communication, "
        "equipment and security.",
        "Create a software engineering career ladder from junior to principal "
        "with promotion criteria.",
        "Should we terminate this employee based on two missed deadlines?",
    ]
    for q in cases:
        assert _top(q) == "hr", f"{q!r} -> {_top(q)}"
