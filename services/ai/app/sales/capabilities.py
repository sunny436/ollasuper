"""Sales capability catalogue — maps Sales capability INTENTS to the EXACT read-only
OllaGraph tools (operationIds verified against the live /v1/tools OpenAPI snapshot,
2026-08-28 — the same snapshot the SEO/Blog catalogues pin), and derives (a) the sales
intent map merged into the runtime intent resolver and (b) a capability summary rendered
into the Sales skill guidance.

Distinct intent keys (`sales.*`) so registering these NEVER clobbers the SEO / Blog /
Research intent maps when several capability flags are on. Only READ-ONLY tools; the
Sales skill runs on the main agent (read-only ceiling), so nothing here can mutate.
Every tool overlaps the SEO/Blog catalogues (search / scrape / extract / convert) — the
SAME verified operationIds, REUSED, never duplicated.

Numeric forecast/pipeline work does NOT appear here: it reuses the Data-Analysis compute
tools (bound by the runner when a CSV is uploaded and `ai_data_analysis_enabled` is on)
plus the pure methodology in `app/sales/forecast.py`. Asset generation reuses the
reserved `generate_file` tool. Neither is an OllaGraph endpoint, so neither belongs in
this OllaGraph catalogue.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models.tools import SideEffect


@dataclass(frozen=True, slots=True)
class SalesCapability:
    intent: str
    description: str
    tool_ids: tuple[str, ...]
    query: str  # canonical selector query for intent resolution / seeding
    inputs: str = "url"  # "text" | "html" | "url" | "query" | "file"
    side_effect: SideEffect = SideEffect.READ_ONLY


# The catalogue — read-only sales-research capabilities only.
SALES_CAPABILITIES: tuple[SalesCapability, ...] = (
    SalesCapability(
        "sales.web_research",
        "Search the web for company/prospect/competitor intel, news, funding and "
        "hiring signals.",
        ("search_endpoint_v1_search_post",),
        "web search company prospect competitor news funding hiring for a query",
        inputs="query",
    ),
    SalesCapability(
        "sales.read_source",
        "Fetch a company/competitor/prospect page's content (site, product, pricing, "
        "leadership, news).",
        (
            "scrape_endpoint_v1_scrape_post",
            "extract_clean_endpoint_v1_extract_clean_post",
        ),
        "scrape fetch read a company competitor page content html for a url",
        inputs="url",
    ),
    SalesCapability(
        "sales.extract_firmographics",
        "Extract structured firmographics / key people / contacts / tables from a "
        "page.",
        ("extract_structured_endpoint_v1_extract_structured_post",),
        "extract structured firmographics people contacts tables from a company page",
        inputs="url",
    ),
    SalesCapability(
        "sales.crawl_site",
        "Crawl a competitor/prospect site to discover product, pricing and release "
        "pages.",
        ("crawl_endpoint_v1_crawl_post",),
        "crawl competitor prospect website discover product pricing release pages",
        inputs="url",
    ),
    SalesCapability(
        "sales.convert_document",
        "Convert an uploaded call transcript / CRM export / deck / sales doc "
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
        "convert transcript crm export deck document pdf docx pptx xlsx csv markdown",
        inputs="file",
    ),
)


def sales_intent_map() -> dict[str, dict]:
    """The `{intent: {query, max_side_effect}}` entries to merge into the runtime
    INTENT_MAP. Distinct `sales.*` keys — additive, never clobbers SEO/Blog/Research."""
    return {
        c.intent: {"query": c.query, "max_side_effect": c.side_effect}
        for c in SALES_CAPABILITIES
    }


def capability_summary(limit: int = 0) -> str:
    """A compact `intent — description` list for the Sales skill guidance."""
    lines = [f"- {c.intent}: {c.description}" for c in SALES_CAPABILITIES]
    if limit:
        lines = lines[:limit]
    return "\n".join(lines)


# Every tool_id the sales catalogue references — for the no-invented-endpoint test.
SALES_TOOL_IDS: frozenset[str] = frozenset(
    tid for c in SALES_CAPABILITIES for tid in c.tool_ids
)
