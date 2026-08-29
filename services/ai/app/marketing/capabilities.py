"""Marketing capability catalogue — maps Marketing INTENTS to the EXACT read-only
OllaGraph tools. Every operationId is VERIFIED bound in OllaSuper's runtime (the same
ids
the SEO/Blog/Sales/HR/Finance catalogues pin). The public docs list a 147-endpoint
superset (incl. the source's own aeo/seo/intelligence endpoints +
extract_tables/contacts/
document, scrape async/batch/smart) that is NOT bound here — grep-proven — so structured
extraction goes through the ONE `extract_structured`.

Distinct `marketing.*` intent keys so registering these NEVER clobbers the other
capabilities' maps. Only READ-ONLY tools; the Marketing skill runs on the main agent
(read-only ceiling). Numeric marketing math is the reserved `marketing_calc` tool; the
bundled specialist playbooks are the reserved `marketing_reference` tool; campaign-CSV
aggregation reuses Data-Analysis; CAC/LTV/ROI reuse `finance_calc`; content writing /
SEO
/ deep market research are DELEGATED to the existing Blog / SEO / Deep-Research skills.
None of those are OllaGraph endpoints, so none belong in this catalogue.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models.tools import SideEffect


@dataclass(frozen=True, slots=True)
class MarketingCapability:
    intent: str
    description: str
    tool_ids: tuple[str, ...]
    query: str
    inputs: str = "url"
    side_effect: SideEffect = SideEffect.READ_ONLY


MARKETING_CAPABILITIES: tuple[MarketingCapability, ...] = (
    MarketingCapability(
        "marketing.web_research",
        "Search the web for market, competitor, audience, pricing, channel and "
        "campaign intelligence.",
        ("search_endpoint_v1_search_post",),
        "web search market competitor audience pricing channel intelligence "
        "for a query",
        inputs="query",
    ),
    MarketingCapability(
        "marketing.read_source",
        "Fetch a competitor / market / product / pricing / landing page's content.",
        (
            "scrape_endpoint_v1_scrape_post",
            "extract_clean_endpoint_v1_extract_clean_post",
        ),
        "scrape fetch read a competitor product pricing landing page content for a url",
        inputs="url",
    ),
    MarketingCapability(
        "marketing.extract_structured",
        "Extract structured data / tables (pricing tiers, feature comparisons, "
        "audience stats) from a page.",
        ("extract_structured_endpoint_v1_extract_structured_post",),
        "extract structured pricing tiers feature comparison audience stats "
        "from a page",
        inputs="url",
    ),
    MarketingCapability(
        "marketing.crawl_site",
        "Crawl a competitor / market site to discover product, pricing, blog and "
        "channel "
        "pages.",
        ("crawl_endpoint_v1_crawl_post",),
        "crawl competitor market website discover product pricing blog channel pages",
        inputs="url",
    ),
    MarketingCapability(
        "marketing.convert_document",
        "Convert an uploaded campaign export / brief / deck / analytics export "
        "(PDF/DOCX/PPTX/XLSX/CSV/HTML) to Markdown for analysis.",
        (
            "pdf_to_markdown_endpoint_v1_convert_pdf_to_markdown_post",
            "docx_to_markdown_endpoint_v1_convert_docx_to_markdown_post",
            "pptx_to_markdown_endpoint_v1_convert_pptx_to_markdown_post",
            "xlsx_to_markdown_endpoint_v1_convert_xlsx_to_markdown_post",
            "csv_to_markdown_endpoint_v1_convert_csv_to_markdown_post",
            "html_to_markdown_endpoint_v1_convert_html_to_markdown_post",
            "convert_ocr_endpoint_v1_convert_ocr_post",
        ),
        "convert campaign export brief deck analytics pdf docx pptx xlsx csv markdown",
        inputs="file",
    ),
)


def marketing_intent_map() -> dict[str, dict]:
    """The `{intent: {query, max_side_effect}}` entries to merge into the runtime
    INTENT_MAP. Distinct `marketing.*` keys — additive, never clobbers other
    capabilities."""
    return {
        c.intent: {"query": c.query, "max_side_effect": c.side_effect}
        for c in MARKETING_CAPABILITIES
    }


def capability_summary(limit: int = 0) -> str:
    """A compact `intent — description` list for the Marketing skill guidance."""
    lines = [f"- {c.intent}: {c.description}" for c in MARKETING_CAPABILITIES]
    if limit:
        lines = lines[:limit]
    return "\n".join(lines)


# Every tool_id the marketing catalogue references — for the no-invented-endpoint test.
MARKETING_TOOL_IDS: frozenset[str] = frozenset(
    tid for c in MARKETING_CAPABILITIES for tid in c.tool_ids
)
