"""Which activated skills make a turn a tool loop, as the router sees it.

A skill researches the web when it DECLARES a web-research capability; the router
reads that before the skills block is composed (runner._skill_researches).
"""

from __future__ import annotations

from app.config import Settings
from app.runtime.roster import effective_skills
from app.runtime.runner import _skill_researches
from app.skills.manifest import ActiveSkill
from app.skills.registry import researches

K1 = "Write a 3-email cold outreach sequence to sell SD-WAN to mid-size Indian banks."


def _all_skills() -> Settings:
    return Settings(
        ai_orchestrated_runtime_enabled=True,
        ai_sales_enabled=True,
        ai_data_analysis_enabled=True,
        ai_documents_enabled=True,
        ai_research_enabled=True,
        ai_blog_enabled=True,
    )


def _active(skill_id: str) -> list[ActiveSkill]:
    (m,) = [s for s in effective_skills(_all_skills()) if s.skill_id == skill_id]
    return [ActiveSkill(manifest=m, score=1.0)]


def test_declared_web_research_is_research():
    for skill_id in ("sales", "deep-research", "blog-assist"):
        assert researches(_active(skill_id)), skill_id


def test_skills_that_do_not_read_the_web_are_not():
    # documents reads a URL the user gave it; that is not a research loop.
    for skill_id in ("data-analysis", "documents", "research-methodology"):
        assert not researches(_active(skill_id)), skill_id


def test_the_router_sees_the_sales_skill_on_a_cold_email_request():
    assert _skill_researches(_all_skills(), K1) is True
    assert _skill_researches(_all_skills(), "What is a mutex?") is False


def test_no_skill_research_without_the_orchestrated_runtime():
    # Built-in skills compose only on that runtime, so none can activate.
    s = Settings(ai_orchestrated_runtime_enabled=False, ai_sales_enabled=True)
    assert _skill_researches(s, K1) is False
