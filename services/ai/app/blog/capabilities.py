"""Blog capability catalogue — maps Blog-Assistant capability INTENTS to the EXACT
read-only OllaGraph tools (operationIds verified against the live /v1/tools OpenAPI
snapshot on 2026-08-28), and derives (a) the blog intent map merged into the runtime
intent resolver and (b) a capability summary rendered into the blog skill guidance.

Distinct intent keys (`blog.*`) so registering these NEVER clobbers the SEO intent
map when both `ai_seo_enabled` and `ai_blog_enabled` are on. Only read-only tools;
the blog skill runs on the main agent (read-only ceiling), so nothing here can
mutate. Several tools overlap the SEO catalogue (search / text.* / meta-audit /
schema-validate / extract.*) — reused, never duplicated.

INPUT NOTE (verified, load-bearing for draft scoring): a fresh unpublished draft can
be scored with the TEXT/HTML-capable tools — readability{text}, keyword-extract
{text}, schema-validate{html}, heading-hierarchy{html}, text.similarity{a,b}; the
URL-only audits (meta-audit, page-audit, citation-readiness, schema-coverage,
broken-links, competitor-diff, freshness) apply to the ANALYZE / existing-URL paths.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models.tools import SideEffect


@dataclass(frozen=True, slots=True)
class BlogCapability:
    intent: str
    description: str
    tool_ids: tuple[str, ...]
    query: str  # canonical selector query for intent resolution / seeding
    inputs: str = "url"  # "text" | "html" | "url" | "query" | "file"
    side_effect: SideEffect = SideEffect.READ_ONLY


# The catalogue — read-only blog-lifecycle capabilities only.
BLOG_CAPABILITIES: tuple[BlogCapability, ...] = (
    # --- research (evidence-driven) --------------------------------------------
    BlogCapability(
        "blog.serp_research",
        "Search the web / SERP for a topic to find ranking pages and sources.",
        ("search_endpoint_v1_search_post",),
        "web search serp results ranking pages sources for a query",
        inputs="query",
    ),
    BlogCapability(
        "blog.read_source",
        "Fetch a competitor/source page's content for analysis.",
        (
            "scrape_endpoint_v1_scrape_post",
            "extract_clean_endpoint_v1_extract_clean_post",
        ),
        "scrape fetch read a page content html for a url",
        inputs="url",
    ),
    BlogCapability(
        "blog.crawl_site",
        "Crawl a site to discover posts/URLs for a blog audit or cluster map.",
        ("crawl_endpoint_v1_crawl_post",),
        "crawl website discover blog posts urls site-wide",
        inputs="url",
    ),
    BlogCapability(
        "blog.competitor_diff",
        "Diff a page against competitors for coverage/citation gaps (AEO).",
        ("aeo_competitor_diff_endpoint_v1_aeo_competitor_diff_post",),
        "compare page vs competitors content coverage gap diff",
        inputs="url",
    ),
    BlogCapability(
        "blog.freshness",
        "Assess freshness/decay signals of an existing page.",
        ("aeo_freshness_signal_endpoint_v1_aeo_freshness_signal_post",),
        "content freshness recency decay signal for a url",
        inputs="url",
    ),
    # --- file / URL ingestion --------------------------------------------------
    BlogCapability(
        "blog.convert_document",
        "Convert an uploaded document (PDF/DOCX/PPTX/XLSX/CSV/HTML) to Markdown.",
        (
            "pdf_to_markdown_endpoint_v1_convert_pdf_to_markdown_post",
            "docx_to_markdown_endpoint_v1_convert_docx_to_markdown_post",
            "pptx_to_markdown_endpoint_v1_convert_pptx_to_markdown_post",
            "xlsx_to_markdown_endpoint_v1_convert_xlsx_to_markdown_post",
            "csv_to_markdown_endpoint_v1_convert_csv_to_markdown_post",
            "html_to_markdown_endpoint_v1_convert_html_to_markdown_post",
            "convert_ocr_endpoint_v1_convert_ocr_post",
        ),
        "convert document pdf docx pptx xlsx html to markdown ocr",
        inputs="file",
    ),
    BlogCapability(
        "blog.extract_structured",
        "Extract structured data (JSON-LD/OG/tables) from a page.",
        ("extract_structured_endpoint_v1_extract_structured_post",),
        "extract structured data json-ld open graph tables from a page",
        inputs="url",
    ),
    # --- draft-scorable quality signals (TEXT / HTML) --------------------------
    BlogCapability(
        "blog.readability",
        "Measure content readability of a draft (accepts raw text).",
        ("seo_readability_endpoint_v1_seo_readability_post",),
        "measure content readability score of text editorial quality",
        inputs="text",
    ),
    BlogCapability(
        "blog.keywords",
        "Extract keywords/target-term coverage from a draft (accepts text).",
        ("seo_keyword_extract_endpoint_v1_seo_keyword_extract_post",),
        "extract keywords phrases coverage from text or a page",
        inputs="text",
    ),
    BlogCapability(
        "blog.originality",
        "Compare a draft against source texts for originality / overlap.",
        (
            "text_similarity_endpoint_v1_text_similarity_post",
            "text_diff_endpoint_v1_text_diff_post",
        ),
        "text similarity diff originality overlap between texts",
        inputs="text",
    ),
    BlogCapability(
        "blog.chunk",
        "Chunk long text for bounded processing.",
        ("text_chunk_endpoint_v1_text_chunk_post",),
        "chunk split long text into segments",
        inputs="text",
    ),
    BlogCapability(
        "blog.schema_validate",
        "Validate a draft's JSON-LD/schema (accepts raw html).",
        ("seo_schema_validate_endpoint_v1_seo_schema_validate_post",),
        "validate structured data schema json-ld rich results from html",
        inputs="html",
    ),
    BlogCapability(
        "blog.heading_hierarchy",
        "Score heading hierarchy of a draft (accepts raw html).",
        ("aeo_heading_hierarchy_endpoint_v1_aeo_heading_hierarchy_score_post",),
        "heading hierarchy h1 h2 h3 structure score from html",
        inputs="html",
    ),
    BlogCapability(
        "blog.snippet_candidates",
        "Find featured-snippet candidate blocks in content.",
        ("seo_snippet_candidates_endpoint_v1_seo_snippet_candidates_post",),
        "featured snippet candidate answer blocks in content",
        inputs="url",
    ),
    # --- on-page / SEO of an EXISTING url --------------------------------------
    BlogCapability(
        "blog.onpage_audit",
        "Audit title/meta/H1/canonical/indexability of an existing page.",
        ("seo_meta_audit_endpoint_v1_seo_meta_audit_post",),
        "audit title meta description h1 canonical indexability of a page",
        inputs="url",
    ),
    BlogCapability(
        "blog.internal_links",
        "Audit anchor text + find broken links on a page.",
        (
            "seo_anchor_text_audit_endpoint_v1_seo_anchor_text_audit_post",
            "seo_broken_links_endpoint_v1_seo_broken_links_audit_post",
        ),
        "anchor text internal links broken links audit for a page",
        inputs="url",
    ),
    # --- GEO / AI-citation of an EXISTING url -----------------------------------
    BlogCapability(
        "blog.geo_citation",
        "AI-citation readiness of an existing page (AEO).",
        ("aeo_citation_readiness_endpoint_v1_aeo_citation_readiness_post",),
        "ai citation readiness llm answer evidence for a url",
        inputs="url",
    ),
    BlogCapability(
        "blog.geo_page_audit",
        "Full AEO/GEO page audit of an existing page.",
        ("aeo_page_audit_endpoint_v1_aeo_page_audit_post",),
        "aeo geo page audit ai search readiness for a url",
        inputs="url",
    ),
    BlogCapability(
        "blog.geo_schema_coverage",
        "Schema coverage for AI search of an existing page.",
        ("aeo_schema_coverage_endpoint_v1_aeo_schema_coverage_post",),
        "schema coverage for ai search geo of a url",
        inputs="url",
    ),
    BlogCapability(
        "blog.geo_snippet_format",
        "Detect answer/snippet formatting for AI search.",
        ("aeo_snippet_format_detect_endpoint_v1_aeo_snippet_format_detect_post",),
        "answer snippet format detect ai search of content",
        inputs="url",
    ),
    BlogCapability(
        "blog.geo_llms_txt",
        "Audit llms.txt for AI-crawler guidance.",
        ("aeo_llms_txt_audit_endpoint_v1_aeo_llms_txt_audit_post",),
        "llms.txt audit ai crawler guidance for a domain",
        inputs="url",
    ),
    BlogCapability(
        "blog.geo_llm_fetch",
        "Simulate how an LLM fetches/reads a page.",
        ("aeo_llm_fetch_simulator_endpoint_v1_aeo_llm_fetch_simulator_post",),
        "llm fetch simulate how an ai reads a page url",
        inputs="url",
    ),
)


def blog_intent_map() -> dict[str, dict]:
    """The `{intent: {query, max_side_effect}}` entries to merge into the runtime
    INTENT_MAP. Distinct `blog.*` keys — additive, never clobbers SEO."""
    return {
        c.intent: {"query": c.query, "max_side_effect": c.side_effect}
        for c in BLOG_CAPABILITIES
    }


def capability_summary(limit: int = 0) -> str:
    """A compact `intent — description` list for the blog skill guidance."""
    lines = [f"- {c.intent}: {c.description}" for c in BLOG_CAPABILITIES]
    if limit:
        lines = lines[:limit]
    return "\n".join(lines)


# Every tool_id the blog catalogue references — for the scope/no-invented-endpoint test.
BLOG_TOOL_IDS: frozenset[str] = frozenset(
    tid for c in BLOG_CAPABILITIES for tid in c.tool_ids
)
