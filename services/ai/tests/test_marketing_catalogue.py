"""Marketing capability — catalogue integrity, no-invented-endpoints, distinct-intent
registration, skill render/no-truncation, and flag-gated wiring of the skill + both
reserved tools. Hermetic; no network, no Convex."""

from __future__ import annotations

import re

from app.blog.capabilities import blog_intent_map
from app.finance.capabilities import finance_intent_map
from app.hr.capabilities import hr_intent_map
from app.marketing.capabilities import (
    MARKETING_CAPABILITIES,
    MARKETING_TOOL_IDS,
    capability_summary,
    marketing_intent_map,
)
from app.marketing.skill import MARKETING_SKILL
from app.marketing.tool import MARKETING_CALC_TOOL_SPEC, MARKETING_REFERENCE_TOOL_SPEC
from app.models.tools import SideEffect
from app.research.capabilities import research_intent_map
from app.runtime.roster import PRODUCTION_SKILLS, build_live_runtime, effective_skills
from app.sales.capabilities import sales_intent_map
from app.seo.capabilities import seo_intent_map
from app.skills.registry import SkillRegistry, render_skills_block
from tests.conftest import make_settings

_VERIFIED = {
    "search_endpoint_v1_search_post",
    "scrape_endpoint_v1_scrape_post",
    "extract_clean_endpoint_v1_extract_clean_post",
    "extract_structured_endpoint_v1_extract_structured_post",
    "crawl_endpoint_v1_crawl_post",
    "pdf_to_markdown_endpoint_v1_convert_pdf_to_markdown_post",
    "docx_to_markdown_endpoint_v1_convert_docx_to_markdown_post",
    "pptx_to_markdown_endpoint_v1_convert_pptx_to_markdown_post",
    "xlsx_to_markdown_endpoint_v1_convert_xlsx_to_markdown_post",
    "csv_to_markdown_endpoint_v1_convert_csv_to_markdown_post",
    "html_to_markdown_endpoint_v1_convert_html_to_markdown_post",
    "convert_ocr_endpoint_v1_convert_ocr_post",
}
_FORBIDDEN = {
    "extract_tables_endpoint_v1_extract_tables_post",
    "extract_contacts_endpoint_v1_extract_contacts_post",
    "extract_document_endpoint_v1_extract_document_post",
}


def test_every_capability_is_well_formed():
    for c in MARKETING_CAPABILITIES:
        assert c.intent.startswith("marketing."), c.intent
        assert c.description.strip() and c.query.strip(), c.intent
        assert c.tool_ids and c.side_effect is SideEffect.READ_ONLY, c.intent


def test_no_invented_endpoints():
    assert MARKETING_TOOL_IDS <= _VERIFIED, MARKETING_TOOL_IDS - _VERIFIED
    assert MARKETING_TOOL_IDS.isdisjoint(_FORBIDDEN)
    for tid in MARKETING_TOOL_IDS:
        assert re.fullmatch(r"[a-z0-9_]+_post", tid), tid


def test_intent_map_read_only_and_no_collision():
    m = marketing_intent_map()
    assert set(m) == {c.intent for c in MARKETING_CAPABILITIES}
    for spec in m.values():
        assert spec["max_side_effect"].value == "read_only"
    keys = set(m)
    for other in (
        seo_intent_map(),
        blog_intent_map(),
        research_intent_map(),
        sales_intent_map(),
        hr_intent_map(),
        finance_intent_map(),
    ):
        assert keys & set(other) == set()


def test_capability_summary_lists_intents():
    s = capability_summary()
    assert "marketing.web_research" in s and "marketing.convert_document" in s


def test_reserved_tool_specs_well_formed():
    for spec in (MARKETING_CALC_TOOL_SPEC, MARKETING_REFERENCE_TOOL_SPEC):
        fn = spec["function"]
        assert spec["type"] == "function" and fn["name"] and fn["description"]
    assert MARKETING_CALC_TOOL_SPEC["function"]["name"] == "marketing_calc"
    assert MARKETING_REFERENCE_TOOL_SPEC["function"]["name"] == "marketing_reference"
    kinds = MARKETING_CALC_TOOL_SPEC["function"]["parameters"]["properties"]["kind"][
        "enum"
    ]
    for k in (
        "sample_size",
        "ab_test",
        "funnel",
        "roas",
        "attribution",
        "cac",
        "budget_allocation",
    ):
        assert k in kinds, k


def test_skill_renders_within_budget_and_not_truncated():
    settings = make_settings("http://x", ai_marketing_enabled=True)
    budget = settings.ai_skill_instructions_budget_chars
    assert len(MARKETING_SKILL.render()) <= budget - 1000
    reg = SkillRegistry(effective_skills(settings))
    active = reg.discover(
        "build a go-to-market strategy and positioning for our product"
    )
    assert active and active[0].manifest.skill_id == "marketing"
    block = render_skills_block(active[:1], char_budget=budget)
    assert "marketing_calc" in block and "marketing_reference" in block
    assert "no false automation" in block.lower() or "hubspot" in block.lower()


def _resolver():
    from app.orchestrator.capabilities import CapabilityResolver
    from app.tools.registry import ToolRegistry
    from app.tools.selection import ToolSelector

    reg = ToolRegistry()
    return CapabilityResolver(reg, ToolSelector(reg))


def test_build_live_runtime_registers_when_on_omits_off():
    from app.orchestrator.intents import is_intent

    _o, reg = build_live_runtime(
        make_settings("http://x", ai_marketing_enabled=True), _resolver()
    )
    assert reg.get("marketing") is not None
    assert is_intent("marketing.web_research")
    _o2, reg2 = build_live_runtime(
        make_settings("http://x", ai_marketing_enabled=False), _resolver()
    )
    assert reg2.get("marketing") is None


def test_flag_off_is_byte_identical():
    off = make_settings("http://x", ai_marketing_enabled=False)
    assert effective_skills(off) == list(PRODUCTION_SKILLS)
