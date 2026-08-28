"""Blog Assistant — catalogue integrity, distinct-from-SEO registration, activation
routing, and the skill honesty/render guards. Hermetic; no network, no Convex."""

from __future__ import annotations

import re

from app.blog.capabilities import (
    BLOG_CAPABILITIES,
    BLOG_TOOL_IDS,
    blog_intent_map,
    capability_summary,
)
from app.blog.skill import BLOG_SKILL
from app.models.tools import SideEffect
from app.runtime.roster import (
    PRODUCTION_SKILLS,
    build_live_runtime,
    effective_skills,
)
from app.seo.capabilities import seo_intent_map
from app.skills.registry import SkillRegistry, render_skills_block
from tests.conftest import make_settings

# The op_ids verified against the live /v1/tools OpenAPI snapshot (2026-08-28). The
# test pins them so a typo or a silent drift is caught hermetically.
_VERIFIED = {
    "search_endpoint_v1_search_post",
    "scrape_endpoint_v1_scrape_post",
    "extract_clean_endpoint_v1_extract_clean_post",
    "extract_structured_endpoint_v1_extract_structured_post",
    "crawl_endpoint_v1_crawl_post",
    "seo_meta_audit_endpoint_v1_seo_meta_audit_post",
    "seo_schema_validate_endpoint_v1_seo_schema_validate_post",
    "seo_readability_endpoint_v1_seo_readability_post",
    "seo_keyword_extract_endpoint_v1_seo_keyword_extract_post",
    "seo_snippet_candidates_endpoint_v1_seo_snippet_candidates_post",
    "seo_anchor_text_audit_endpoint_v1_seo_anchor_text_audit_post",
    "seo_broken_links_endpoint_v1_seo_broken_links_audit_post",
    "aeo_citation_readiness_endpoint_v1_aeo_citation_readiness_post",
    "aeo_heading_hierarchy_endpoint_v1_aeo_heading_hierarchy_score_post",
    "aeo_page_audit_endpoint_v1_aeo_page_audit_post",
    "aeo_schema_coverage_endpoint_v1_aeo_schema_coverage_post",
    "aeo_snippet_format_detect_endpoint_v1_aeo_snippet_format_detect_post",
    "aeo_freshness_signal_endpoint_v1_aeo_freshness_signal_post",
    "aeo_competitor_diff_endpoint_v1_aeo_competitor_diff_post",
    "aeo_llms_txt_audit_endpoint_v1_aeo_llms_txt_audit_post",
    "aeo_llm_fetch_simulator_endpoint_v1_aeo_llm_fetch_simulator_post",
    "text_chunk_endpoint_v1_text_chunk_post",
    "text_similarity_endpoint_v1_text_similarity_post",
    "text_diff_endpoint_v1_text_diff_post",
    "pdf_to_markdown_endpoint_v1_convert_pdf_to_markdown_post",
    "docx_to_markdown_endpoint_v1_convert_docx_to_markdown_post",
    "pptx_to_markdown_endpoint_v1_convert_pptx_to_markdown_post",
    "xlsx_to_markdown_endpoint_v1_convert_xlsx_to_markdown_post",
    "csv_to_markdown_endpoint_v1_convert_csv_to_markdown_post",
    "html_to_markdown_endpoint_v1_convert_html_to_markdown_post",
    "convert_ocr_endpoint_v1_convert_ocr_post",
}


# --- catalogue integrity ---------------------------------------------------
def test_every_capability_is_well_formed():
    for c in BLOG_CAPABILITIES:
        assert c.intent.startswith("blog."), c.intent
        assert c.description.strip() and c.query.strip(), c.intent
        assert c.tool_ids, c.intent
        assert c.side_effect is SideEffect.READ_ONLY, c.intent  # read-only end to end


def test_no_invented_endpoints():
    # Every referenced tool_id is a real, verified op_id (no fabricated endpoint).
    assert BLOG_TOOL_IDS <= _VERIFIED, BLOG_TOOL_IDS - _VERIFIED
    # …and shaped like an operationId, defensively.
    for tid in BLOG_TOOL_IDS:
        assert re.fullmatch(r"[a-z0-9_]+_post", tid), tid


def test_intent_map_covers_every_capability_and_is_read_only():
    m = blog_intent_map()
    assert set(m) == {c.intent for c in BLOG_CAPABILITIES}
    for intent, spec in m.items():
        assert spec["query"].strip()
        assert spec["max_side_effect"].value == "read_only", intent


def test_blog_intents_never_collide_with_seo():
    # Distinct `blog.*` keys — registering both flags must not clobber either map.
    assert set(blog_intent_map()) & set(seo_intent_map()) == set()


# --- skill honesty + render guard ------------------------------------------
def test_skill_encodes_the_non_negotiable_rules():
    low = (
        BLOG_SKILL.constraints
        + BLOG_SKILL.instructions
        + BLOG_SKILL.output_expectations
    ).lower()
    assert "never fabricate" in low
    assert "not a google ranking" in low  # score is not a ranking guarantee
    assert "one clarifying question" in low  # intent handling
    assert "max 3 fix cycles" in low or "3 fix cycles" in low  # bounded loop
    assert "untrusted" in low  # scraped content is untrusted
    assert "final" in low and "qa" in low  # the mandatory final QA pass


def test_activated_blog_skill_is_not_truncated():
    settings = make_settings("http://x", ai_blog_enabled=True)
    budget = settings.ai_skill_instructions_budget_chars
    reg = SkillRegistry(effective_skills(settings))
    active = reg.discover("write a blog post about AI SEO tools")
    assert active and active[0].manifest.skill_id == "blog-assist"
    block = render_skills_block(active, char_budget=budget)
    # A constraints-tail marker AND an output-tail marker both survive → no truncation.
    assert "not a google ranking" in block.lower()
    assert "sources & evidence" in block.lower()
    assert len(BLOG_SKILL.render()) <= budget - 1000


def test_capability_summary_lists_intents():
    s = capability_summary()
    assert s.strip() and "blog.serp_research" in s and "blog.readability" in s


# --- activation routing (blog vs SEO coexist, flag-gated) ------------------
def _on():
    return make_settings("http://x", ai_blog_enabled=True)


def test_flag_off_blog_skill_never_activates():
    off = make_settings("http://x", ai_blog_enabled=False)
    assert effective_skills(off) == list(PRODUCTION_SKILLS)
    reg = SkillRegistry(effective_skills(off))
    top = reg.discover("write a blog about SaaS onboarding")
    assert "blog-assist" not in {a.manifest.skill_id for a in top}


def test_blog_skill_is_top_for_blog_requests():
    reg = SkillRegistry(effective_skills(_on()))
    for q in (
        "write a blog post about AI SEO tools",
        "analyze this blog and tell me why it won't rank",
        "rewrite this article to rank better",
        "create a content brief for this keyword",
        "give me a blog strategy for SaaS SEO",
    ):
        top = reg.discover(q)
        assert top and top[0].manifest.skill_id == "blog-assist", q


def test_blog_and_seo_coexist_independently():
    # Both flags on: blog activates on blog asks, SEO on SEO asks — neither crowds out.
    settings = make_settings("http://x", ai_blog_enabled=True, ai_seo_enabled=True)
    reg = SkillRegistry(effective_skills(settings))
    blog_top = reg.discover("write a blog post about kubernetes")
    seo_top = reg.discover("audit the technical SEO of example.com robots canonical")
    assert blog_top and blog_top[0].manifest.skill_id == "blog-assist"
    assert seo_top and seo_top[0].manifest.skill_id == "seo-audit"


def test_build_live_runtime_registers_blog_intents_when_on():
    from app.orchestrator.capabilities import CapabilityResolver
    from app.orchestrator.intents import is_intent
    from app.tools.registry import ToolRegistry
    from app.tools.selection import ToolSelector

    reg = ToolRegistry()
    resolver = CapabilityResolver(reg, ToolSelector(reg))
    _orch, skill_reg = build_live_runtime(_on(), resolver)
    assert skill_reg.get("blog-assist") is not None
    assert is_intent("blog.serp_research") and is_intent("blog.readability")
