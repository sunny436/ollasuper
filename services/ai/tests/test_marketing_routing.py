"""Marketing capability — autonomous jargon-free routing + flag-gated registration. The
Marketing router must activate on plain-language marketing questions (no jargon needed),
add NO delegated agent, never hijack the siblings, and be byte-identical when off."""

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
    return make_settings("http://x", ai_marketing_enabled=True, **extra)


def _off():
    return make_settings("http://x", ai_marketing_enabled=False)


def _roles(settings):
    return build_delegate_spec(settings)["function"]["parameters"]["properties"][
        "role"
    ]["enum"]


def test_flag_off_roster_unchanged():
    assert effective_agents(_off()) == PRODUCTION_AGENTS
    assert effective_skills(_off()) == PRODUCTION_SKILLS
    assert "marketing" not in _roles(_off())


def test_flag_on_adds_one_skill_no_agent():
    agents, skills = effective_agents(_on()), effective_skills(_on())
    assert agents == list(PRODUCTION_AGENTS)
    assert [s.skill_id for s in skills].count("marketing") == 1
    assert len(skills) == len(PRODUCTION_SKILLS) + 1
    assert "marketing" not in _roles(_on())


def _top(q, settings=None):
    t = SkillRegistry(effective_skills(settings or _on())).discover(q)
    return t[0].manifest.skill_id if t else None


def test_plain_language_routes_to_marketing():
    cases = {
        "acquisition": "how do I get more customers",
        "cro_visit": "why are people visiting but not signing up",
        "cro_signup": "why aren't people signing up",
        "launch": "how should I launch this product",
        "icp": "who should we sell to",
        "competitive": "how are competitors beating us",
        "social": "how should I promote this on linkedin",
        "pricing": "should we lower our price",
        "market_entry": "how do we enter germany",
        "growth": "how should we grow next quarter",
        "campaign": "why isn't our campaign working",
        "budget": "where should we spend our marketing budget",
        "gtm": "create a go-to-market strategy for our product",
        "positioning": "how should we position this product",
        "demand": "design a demand generation plan",
        "funnel": "optimize our signup funnel conversion",
        "competitor_analysis": "analyze our competitors positioning",
    }
    for name, q in cases.items():
        assert _top(q) == "marketing", f"{name}: {q!r} -> {_top(q)}"


def test_marketing_does_not_hijack_siblings():
    s = _on(
        ai_seo_enabled=True,
        ai_blog_enabled=True,
        ai_research_enabled=True,
        ai_data_analysis_enabled=True,
        ai_sales_enabled=True,
        ai_hr_enabled=True,
        ai_finance_enabled=True,
    )

    def top(q):
        t = SkillRegistry(effective_skills(s)).discover(q)
        return t[0].manifest.skill_id if t else None

    assert top("write a blog post about saas marketing") == "blog-assist"
    assert top("run an seo audit of my landing page") == "seo-audit"
    assert top("research the b2b saas market deeply with sources") == "deep-research"
    assert top("analyze this campaign csv") == "data-analysis"
    assert top("analyze this sales pipeline and forecast quota") == "sales"
    assert top("value this company with a dcf") == "finance"
    assert top("draft a cold outreach email to this prospect") == "sales"
    assert not SkillRegistry(effective_skills(s)).discover("say hello to me")


def test_flag_off_never_activates():
    t = SkillRegistry(effective_skills(_off())).discover(
        "create a go-to-market strategy and marketing plan"
    )
    assert "marketing" not in {a.manifest.skill_id for a in t}


def test_marketing_coexists_with_all_flags_on():
    s = _on(
        ai_seo_enabled=True,
        ai_blog_enabled=True,
        ai_research_enabled=True,
        ai_data_analysis_enabled=True,
        ai_sales_enabled=True,
        ai_hr_enabled=True,
        ai_finance_enabled=True,
    )
    reg = SkillRegistry(effective_skills(s))
    assert reg.discover("how do we get more customers next quarter")[
        0
    ].manifest.skill_id == ("marketing")
    assert (
        reg.discover("audit example.com technical seo")[0].manifest.skill_id
        == "seo-audit"
    )


def test_qa_report_phrasings_route_to_marketing():
    """Measured before the vocabulary fix: 'a/b' tokenizes to nothing, so an A/B
    test request scored 0 and a landing-page review scored below the floor."""
    cases = [
        "Design an A/B test with hypothesis, variants, and the sample size needed "
        "for significance.",
        "Analyse this landing page: headline, value proposition, CTA, trust signals "
        "and conversion friction.",
        "Plan a Google Ads campaign structure with ad groups, keywords, negative "
        "keywords and budget.",
    ]
    for q in cases:
        assert _top(q) == "marketing", f"{q!r} -> {_top(q)}"
