"""HR Assistant — catalogue integrity, distinct-from-others registration, and the skill
render guard. Hermetic; no network, no Convex."""

from __future__ import annotations

import re

from app.blog.capabilities import blog_intent_map
from app.hr.capabilities import (
    HR_CAPABILITIES,
    HR_TOOL_IDS,
    capability_summary,
    hr_intent_map,
)
from app.hr.skill import HR_SKILL
from app.models.tools import SideEffect
from app.research.capabilities import research_intent_map
from app.runtime.roster import (
    PRODUCTION_SKILLS,
    build_live_runtime,
    effective_skills,
)
from app.sales.capabilities import sales_intent_map
from app.seo.capabilities import seo_intent_map
from app.skills.registry import SkillRegistry, render_skills_block
from tests.conftest import make_settings

# op_ids verified against the live tool registry (the same ids the SEO/Blog/Sales
# catalogues pin). Reused, never invented. NOTE: OllaSuper has NO contacts/tables/
# document extraction endpoint — structured data goes through extract_structured.
_VERIFIED = {
    "search_endpoint_v1_search_post",
    "scrape_endpoint_v1_scrape_post",
    "extract_clean_endpoint_v1_extract_clean_post",
    "extract_structured_endpoint_v1_extract_structured_post",
    "pdf_to_markdown_endpoint_v1_convert_pdf_to_markdown_post",
    "docx_to_markdown_endpoint_v1_convert_docx_to_markdown_post",
    "pptx_to_markdown_endpoint_v1_convert_pptx_to_markdown_post",
    "xlsx_to_markdown_endpoint_v1_convert_xlsx_to_markdown_post",
    "csv_to_markdown_endpoint_v1_convert_csv_to_markdown_post",
    "html_to_markdown_endpoint_v1_convert_html_to_markdown_post",
    "convert_ocr_endpoint_v1_convert_ocr_post",
}


def test_every_capability_is_well_formed():
    for c in HR_CAPABILITIES:
        assert c.intent.startswith("hr."), c.intent
        assert c.description.strip() and c.query.strip(), c.intent
        assert c.tool_ids, c.intent
        assert c.side_effect is SideEffect.READ_ONLY, c.intent


def test_no_invented_endpoints():
    assert HR_TOOL_IDS <= _VERIFIED, HR_TOOL_IDS - _VERIFIED
    for tid in HR_TOOL_IDS:
        assert re.fullmatch(r"[a-z0-9_]+_post", tid), tid


def test_intent_map_covers_every_capability_and_is_read_only():
    m = hr_intent_map()
    assert set(m) == {c.intent for c in HR_CAPABILITIES}
    for intent, spec in m.items():
        assert spec["query"].strip()
        assert spec["max_side_effect"].value == "read_only", intent


def test_hr_intents_never_collide_with_other_capabilities():
    keys = set(hr_intent_map())
    assert keys & set(seo_intent_map()) == set()
    assert keys & set(blog_intent_map()) == set()
    assert keys & set(research_intent_map()) == set()
    assert keys & set(sales_intent_map()) == set()


def test_capability_summary_lists_intents():
    s = capability_summary()
    assert "hr.web_research" in s and "hr.convert_document" in s


def test_activated_hr_skill_is_not_truncated():
    settings = make_settings("http://x", ai_hr_enabled=True)
    budget = settings.ai_skill_instructions_budget_chars
    reg = SkillRegistry(effective_skills(settings))
    active = reg.discover("build an onboarding plan and interview scorecard for a hire")
    assert active and active[0].manifest.skill_id == "hr"
    block = render_skills_block(active, char_budget=budget)
    assert "generate_file" in block  # from _OUTPUT (last section)
    assert "no new storage" in block.lower()  # from _CONSTRAINTS
    assert len(HR_SKILL.render()) <= budget - 1000


def _resolver():
    from app.orchestrator.capabilities import CapabilityResolver
    from app.tools.registry import ToolRegistry
    from app.tools.selection import ToolSelector

    reg = ToolRegistry()
    return CapabilityResolver(reg, ToolSelector(reg))


def test_build_live_runtime_registers_hr_when_on():
    from app.orchestrator.intents import is_intent

    _orch, skill_reg = build_live_runtime(
        make_settings("http://x", ai_hr_enabled=True), _resolver()
    )
    assert skill_reg.get("hr") is not None
    assert is_intent("hr.web_research") and is_intent("hr.convert_document")


def test_build_live_runtime_off_omits_hr():
    _orch, skill_reg = build_live_runtime(
        make_settings("http://x", ai_hr_enabled=False), _resolver()
    )
    assert skill_reg.get("hr") is None


def test_flag_off_is_byte_identical():
    off = make_settings("http://x", ai_hr_enabled=False)
    assert effective_skills(off) == list(PRODUCTION_SKILLS)
