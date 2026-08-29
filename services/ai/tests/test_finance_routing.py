"""Finance capability — autonomous, jargon-free routing + flag-gated registration.
Routing is model-driven but its INPUTS are deterministic: the corporate-Finance skill
and
the Equity-Research skill must activate on plain-language finance/stock questions (no
jargon required), add NO delegated agent, never hijack the siblings, and the whole
surface
must be byte-identical when the flag is off."""

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
    return make_settings("http://x", ai_finance_enabled=True, **extra)


def _off():
    return make_settings("http://x", ai_finance_enabled=False)


def _delegate_roles(settings) -> list[str]:
    return build_delegate_spec(settings)["function"]["parameters"]["properties"][
        "role"
    ]["enum"]


# --- flag OFF is byte-identical --------------------------------------------
def test_flag_off_roster_is_unchanged():
    assert effective_agents(_off()) == PRODUCTION_AGENTS
    assert effective_skills(_off()) == PRODUCTION_SKILLS
    assert "finance" not in _delegate_roles(_off())
    assert "equity-research" not in _delegate_roles(_off())


# --- flag ON registers exactly TWO skills, NO agent ------------------------
def test_flag_on_appends_two_skills_and_no_agent():
    agents = effective_agents(_on())
    skills = effective_skills(_on())
    assert agents == list(PRODUCTION_AGENTS)  # roster unchanged by the flag
    ids = [s.skill_id for s in skills]
    assert ids.count("finance") == 1 and ids.count("equity-research") == 1
    assert len(skills) == len(PRODUCTION_SKILLS) + 2
    assert "finance" not in _delegate_roles(_on())
    assert "equity-research" not in _delegate_roles(_on())


def _top(query: str, settings=None) -> str | None:
    reg = SkillRegistry(effective_skills(settings or _on()))
    top = reg.discover(query)
    return top[0].manifest.skill_id if top else None


# --- the corporate-Finance skill routes on JARGON-FREE questions -----------
def test_finance_skill_is_top_for_plain_language():
    cases = {
        "financial_health": "is my business financially healthy",
        "statement_analysis": "analyze these financial statements for me",
        "ratios": "compute our key financial ratios",
        "dcf": "value my company with a dcf",
        "worth": "how much is this company worth",
        "profit_vs_revenue": "why are we making more sales but still losing money",
        "variance": "compare our budget vs actual and flag the big variances",
        "revenue_forecast": "forecast our revenue for next year",
        "cashflow_forecast": "forecast our cash flow and runway",
        "affordability": "can we afford to hire 20 people",
        "capex": "should we buy this new machine for 200k",
        "saas_health": "is our saas business healthy",
        "arr_mrr": "whats our arr and mrr growth",
        "unit_economics": "calculate our cac ltv nrr and churn",
    }
    for name, q in cases.items():
        assert _top(q) == "finance", f"{name}: {q!r} -> {_top(q)}"


# --- the Equity-Research skill routes on stock/company analysis ------------
def test_equity_skill_is_top_for_stock_analysis():
    cases = {
        "analyze_stock": "analyze this stock for me",
        "forensic": "is this company's reported profit real",
        "listed_valuation": "value this listed company",
        "ipo": "assess this ipo from the drhp",
        "report": "build an equity research report on this ticker with a bear case",
    }
    for name, q in cases.items():
        assert _top(q) == "equity-research", f"{name}: {q!r} -> {_top(q)}"


# --- Finance does NOT hijack the sibling capabilities ----------------------
def test_finance_does_not_hijack_other_capabilities():
    settings = _on(
        ai_seo_enabled=True,
        ai_blog_enabled=True,
        ai_research_enabled=True,
        ai_data_analysis_enabled=True,
        ai_sales_enabled=True,
        ai_hr_enabled=True,
    )

    def top(q):
        t = SkillRegistry(effective_skills(settings)).discover(q)
        return t[0].manifest.skill_id if t else None

    assert top("analyze this csv and show me the trends") == "data-analysis"
    assert top("write a blog post about corporate finance") == "blog-assist"
    assert top("run an seo audit of example.com robots canonical") == "seo-audit"
    assert top("research the fintech market deeply with sources") == "deep-research"
    assert top("analyze this sales pipeline and forecast my quota") == "sales"
    # a greeting activates no skill at all
    assert not SkillRegistry(effective_skills(settings)).discover("say hello to me")


def test_flag_off_finance_never_activates():
    reg = SkillRegistry(effective_skills(_off()))
    top = reg.discover("value my company with a dcf and analyze this stock")
    ids = {a.manifest.skill_id for a in top}
    assert "finance" not in ids and "equity-research" not in ids


# --- Finance coexists with every sibling flag on ---------------------------
def test_finance_coexists_with_all_flags_on():
    settings = _on(
        ai_seo_enabled=True,
        ai_blog_enabled=True,
        ai_research_enabled=True,
        ai_data_analysis_enabled=True,
        ai_sales_enabled=True,
        ai_hr_enabled=True,
    )
    reg = SkillRegistry(effective_skills(settings))
    assert (
        reg.discover("value my business with a dcf")[0].manifest.skill_id == "finance"
    )
    assert reg.discover("analyze this stock ticker")[0].manifest.skill_id == (
        "equity-research"
    )
    assert reg.discover("audit example.com technical seo")[0].manifest.skill_id == (
        "seo-audit"
    )
