"""Documents capability — catalogue integrity, no-invented-endpoints, distinct-intent
registration, skill render/no-truncation, tool spec, and flag-gated wiring. Hermetic."""

from __future__ import annotations

import re

from app.blog.capabilities import blog_intent_map
from app.documents.capabilities import (
    DOCUMENTS_CAPABILITIES,
    DOCUMENTS_TOOL_IDS,
    capability_summary,
    documents_intent_map,
)
from app.documents.skill import DOCUMENTS_SKILL
from app.documents.tool import (
    DOCUMENT_OPERATIONS,
    DOCUMENT_OPS_TOOL_NAME,
    DOCUMENT_OPS_TOOL_SPEC,
    PDF_OPS,
    PPTX_OPS,
)
from app.finance.capabilities import finance_intent_map
from app.hr.capabilities import hr_intent_map
from app.marketing.capabilities import marketing_intent_map
from app.models.tools import SideEffect
from app.operations.capabilities import operations_intent_map
from app.research.capabilities import research_intent_map
from app.runtime.roster import PRODUCTION_SKILLS, build_live_runtime, effective_skills
from app.sales.capabilities import sales_intent_map
from app.seo.capabilities import seo_intent_map
from app.skills.registry import SkillRegistry, render_skills_block
from tests.conftest import make_settings

# The convert/scrape endpoints every sibling catalogue pins (verified bound in runtime).
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


def test_every_capability_well_formed():
    for c in DOCUMENTS_CAPABILITIES:
        assert c.intent.startswith("documents."), c.intent
        assert c.description.strip() and c.query.strip(), c.intent
        assert c.tool_ids and c.side_effect is SideEffect.READ_ONLY, c.intent


def test_no_invented_endpoints():
    assert DOCUMENTS_TOOL_IDS <= _VERIFIED, DOCUMENTS_TOOL_IDS - _VERIFIED
    for tid in DOCUMENTS_TOOL_IDS:
        assert re.fullmatch(r"[a-z0-9_]+_post", tid), tid


def test_intent_map_read_only_and_no_collision():
    m = documents_intent_map()
    assert set(m) == {c.intent for c in DOCUMENTS_CAPABILITIES}
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
        marketing_intent_map(),
        operations_intent_map(),
    ):
        assert keys & set(other) == set()


def test_capability_summary_lists_intents():
    s = capability_summary()
    assert "documents.read_web_source" in s
    assert "documents.convert_url_document" in s


def test_tool_spec_operations_cover_pdf_and_pptx():
    assert DOCUMENT_OPS_TOOL_SPEC["function"]["name"] == DOCUMENT_OPS_TOOL_NAME
    enum = set(
        DOCUMENT_OPS_TOOL_SPEC["function"]["parameters"]["properties"]["operation"][
            "enum"
        ]
    )
    assert enum == set(DOCUMENT_OPERATIONS) == (PDF_OPS | PPTX_OPS)
    # the core capabilities the brief requires all exist
    for op in (
        "pdf_read",
        "pdf_extract_tables",
        "pdf_ocr",
        "pdf_merge",
        "pdf_split",
        "pdf_encrypt",
        "pdf_decrypt",
        "pdf_fill_form",
        "pdf_to_pptx",
        "pptx_read",
        "pptx_edit",
        "pptx_duplicate_slide",
        "pptx_reorder_slides",
        "pptx_to_pdf",
    ):
        assert op in enum, op


def test_skill_renders_within_budget_and_not_truncated():
    settings = make_settings("http://x", ai_documents_enabled=True)
    budget = settings.ai_skill_instructions_budget_chars
    assert len(DOCUMENTS_SKILL.render()) <= budget - 1000
    reg = SkillRegistry(effective_skills(settings))
    active = reg.discover("create a pitch deck and show me the slides here")
    assert active and active[0].manifest.skill_id == "documents"
    block = render_skills_block(active[:1], char_budget=budget)
    assert "generate_file" in block.lower()  # steers to create
    assert "document_ops" in block.lower()  # steers to process
    assert "approximate" in block.lower()  # preview honesty is in the guidance


def _resolver():
    from app.orchestrator.capabilities import CapabilityResolver
    from app.tools.registry import ToolRegistry
    from app.tools.selection import ToolSelector

    reg = ToolRegistry()
    return CapabilityResolver(reg, ToolSelector(reg))


def test_build_live_runtime_registers_when_on_omits_off():
    from app.orchestrator.intents import is_intent

    on = make_settings("http://x", ai_documents_enabled=True)
    build_live_runtime(on, _resolver())
    assert is_intent("documents.read_web_source")
    assert is_intent("documents.convert_url_document")


def test_flag_off_is_byte_identical():
    off = make_settings("http://x", ai_documents_enabled=False)
    assert effective_skills(off) == list(PRODUCTION_SKILLS)
