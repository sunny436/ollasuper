"""Finance capability — catalogue integrity, no-invented-endpoints, distinct-intent
registration, skill render/no-truncation, and flag-gated wiring of BOTH skills + BOTH
reserved tools. Hermetic; no network, no Convex."""

from __future__ import annotations

import re

from app.blog.capabilities import blog_intent_map
from app.finance.capabilities import (
    FINANCE_CAPABILITIES,
    FINANCE_TOOL_IDS,
    capability_summary,
    finance_intent_map,
)
from app.finance.equity import EQUITY_SKILL
from app.finance.skill import FINANCE_SKILL
from app.finance.tool import FINANCE_CALC_TOOL_SPEC, FINANCE_REFERENCE_TOOL_SPEC
from app.hr.capabilities import hr_intent_map
from app.models.tools import SideEffect
from app.research.capabilities import research_intent_map
from app.runtime.roster import PRODUCTION_SKILLS, build_live_runtime, effective_skills
from app.sales.capabilities import sales_intent_map
from app.seo.capabilities import seo_intent_map
from app.skills.registry import SkillRegistry, render_skills_block
from tests.conftest import make_settings

# op_ids VERIFIED bound in OllaSuper's runtime — the SAME set the SEO/Blog/Sales/HR
# catalogues pin. The public ollagraph.com/docs lists a superset (extract_tables/
# extract_contacts/extract_document, scrape async/batch/smart) that is NOT bound here.
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
# The superset endpoints that exist in the docs but are NOT bound — must never appear.
_FORBIDDEN = {
    "extract_tables_endpoint_v1_extract_tables_post",
    "extract_contacts_endpoint_v1_extract_contacts_post",
    "extract_document_endpoint_v1_extract_document_post",
}


def test_every_capability_is_well_formed():
    for c in FINANCE_CAPABILITIES:
        assert c.intent.startswith("finance."), c.intent
        assert c.description.strip() and c.query.strip(), c.intent
        assert c.tool_ids, c.intent
        assert c.side_effect is SideEffect.READ_ONLY, c.intent


def test_no_invented_endpoints():
    assert FINANCE_TOOL_IDS <= _VERIFIED, FINANCE_TOOL_IDS - _VERIFIED
    assert FINANCE_TOOL_IDS.isdisjoint(_FORBIDDEN)
    for tid in FINANCE_TOOL_IDS:
        assert re.fullmatch(r"[a-z0-9_]+_post", tid), tid


def test_intent_map_is_read_only_and_complete():
    m = finance_intent_map()
    assert set(m) == {c.intent for c in FINANCE_CAPABILITIES}
    for intent, spec in m.items():
        assert spec["query"].strip()
        assert spec["max_side_effect"].value == "read_only", intent


def test_finance_intents_never_collide_with_siblings():
    keys = set(finance_intent_map())
    for other in (
        seo_intent_map(),
        blog_intent_map(),
        research_intent_map(),
        sales_intent_map(),
        hr_intent_map(),
    ):
        assert keys & set(other) == set()


def test_capability_summary_lists_intents():
    s = capability_summary()
    assert "finance.web_research" in s and "finance.convert_document" in s


# --- reserved tool specs are well-formed -----------------------------------
def test_reserved_tool_specs_are_well_formed():
    for spec in (FINANCE_CALC_TOOL_SPEC, FINANCE_REFERENCE_TOOL_SPEC):
        fn = spec["function"]
        assert spec["type"] == "function" and fn["name"] and fn["description"]
        assert fn["parameters"]["type"] == "object"
    assert FINANCE_CALC_TOOL_SPEC["function"]["name"] == "finance_calc"
    assert FINANCE_REFERENCE_TOOL_SPEC["function"]["name"] == "finance_reference"
    kinds = FINANCE_CALC_TOOL_SPEC["function"]["parameters"]["properties"]["kind"][
        "enum"
    ]
    for k in (
        "ratios",
        "dcf",
        "equity_valuation",
        "reverse_dcf",
        "npv_irr",
        "saas_metrics",
        "variance",
        "forecast",
    ):
        assert k in kinds, k


# --- skill render / no-truncation for BOTH skills --------------------------
def test_both_skills_render_within_budget():
    settings = make_settings("http://x", ai_finance_enabled=True)
    budget = settings.ai_skill_instructions_budget_chars
    assert len(FINANCE_SKILL.render()) <= budget - 1000
    assert len(EQUITY_SKILL.render()) <= budget - 1000


def test_activated_finance_skill_is_not_truncated():
    settings = make_settings("http://x", ai_finance_enabled=True)
    budget = settings.ai_skill_instructions_budget_chars
    reg = SkillRegistry(effective_skills(settings))
    active = reg.discover("value my business with a dcf and check our financial ratios")
    assert active and active[0].manifest.skill_id == "finance"
    block = render_skills_block(active[:1], char_budget=budget)
    assert "finance_calc" in block  # from _INSTRUCTIONS
    assert "not licensed investment" in block.lower()  # from _CONSTRAINTS


# --- build_live_runtime wires both skills + intents when the flag is on -----
def _resolver():
    from app.orchestrator.capabilities import CapabilityResolver
    from app.tools.registry import ToolRegistry
    from app.tools.selection import ToolSelector

    reg = ToolRegistry()
    return CapabilityResolver(reg, ToolSelector(reg))


def test_build_live_runtime_registers_finance_when_on():
    from app.orchestrator.intents import is_intent

    _orch, skill_reg = build_live_runtime(
        make_settings("http://x", ai_finance_enabled=True), _resolver()
    )
    assert skill_reg.get("finance") is not None
    assert skill_reg.get("equity-research") is not None
    assert is_intent("finance.web_research") and is_intent("finance.convert_document")


def test_build_live_runtime_off_omits_finance():
    _orch, skill_reg = build_live_runtime(
        make_settings("http://x", ai_finance_enabled=False), _resolver()
    )
    assert skill_reg.get("finance") is None
    assert skill_reg.get("equity-research") is None


def test_flag_off_is_byte_identical():
    off = make_settings("http://x", ai_finance_enabled=False)
    assert effective_skills(off) == list(PRODUCTION_SKILLS)
