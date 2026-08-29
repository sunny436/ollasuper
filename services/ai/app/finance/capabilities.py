"""Finance capability catalogue — maps Finance/Equity INTENTS to the EXACT read-only
OllaGraph tools. Every operationId is VERIFIED bound in OllaSuper's runtime (the same
ids
the SEO/Blog/Research/Sales/HR catalogues pin). The public ollagraph.com/docs lists a
SUPERSET (extract_tables / extract_contacts / extract_document, scrape
async/batch/smart)
that is NOT bound here — grep proves none are referenced anywhere in services/ai — so
structured tables/filings go through the ONE `extract_structured`, exactly as HR does.

Distinct `finance.*` intent keys so registering these NEVER clobbers the SEO / Blog /
Research / Sales / HR intent maps. Only READ-ONLY tools; both Finance skills run on the
main agent (read-only ceiling), so nothing here can mutate.

Numeric finance math does NOT appear here: it is the reserved `finance_calc` tool backed
by `app/finance/calc.py`. Bundled sector/valuation methodology is the reserved
`finance_reference` tool. Generic CSV/XLSX aggregation reuses the Data-Analysis compute
tools; report/asset generation reuses `generate_file`. None of those are OllaGraph
endpoints, so none belong in this catalogue.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models.tools import SideEffect


@dataclass(frozen=True, slots=True)
class FinanceCapability:
    intent: str
    description: str
    tool_ids: tuple[str, ...]
    query: str
    inputs: str = "url"
    side_effect: SideEffect = SideEffect.READ_ONLY


FINANCE_CAPABILITIES: tuple[FinanceCapability, ...] = (
    FinanceCapability(
        "finance.web_research",
        "Search the web for company financials, filings, market/industry data, "
        "benchmarks, competitor and macro context.",
        ("search_endpoint_v1_search_post",),
        "web search company financials filings market benchmark for a query",
        inputs="query",
    ),
    FinanceCapability(
        "finance.read_source",
        "Fetch a filing / investor-relations / financial-news page's content.",
        (
            "scrape_endpoint_v1_scrape_post",
            "extract_clean_endpoint_v1_extract_clean_post",
        ),
        "scrape fetch read a filing investor relations financial page for a url",
        inputs="url",
    ),
    FinanceCapability(
        "finance.extract_structured",
        "Extract structured data / financial tables (statements, KPI tables, "
        "shareholding) from a page.",
        ("extract_structured_endpoint_v1_extract_structured_post",),
        "extract structured financial statements tables kpis from a filing page",
        inputs="url",
    ),
    FinanceCapability(
        "finance.crawl_site",
        "Crawl a company's investor-relations / filings site to discover reports and "
        "statements.",
        ("crawl_endpoint_v1_crawl_post",),
        "crawl company investor relations filings site discover reports statements",
        inputs="url",
    ),
    FinanceCapability(
        "finance.convert_document",
        "Convert an uploaded annual report / 10-K / financial statement / model "
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
        "convert annual report 10-K financial statement model pdf docx xlsx "
        "csv markdown",
        inputs="file",
    ),
)


def finance_intent_map() -> dict[str, dict]:
    """The `{intent: {query, max_side_effect}}` entries to merge into the runtime
    INTENT_MAP. Distinct `finance.*` keys — additive, never clobbers other
    capabilities."""
    return {
        c.intent: {"query": c.query, "max_side_effect": c.side_effect}
        for c in FINANCE_CAPABILITIES
    }


def capability_summary(limit: int = 0) -> str:
    """A compact `intent — description` list for the Finance skill guidance."""
    lines = [f"- {c.intent}: {c.description}" for c in FINANCE_CAPABILITIES]
    if limit:
        lines = lines[:limit]
    return "\n".join(lines)


# Every tool_id the finance catalogue references — for the no-invented-endpoint test.
FINANCE_TOOL_IDS: frozenset[str] = frozenset(
    tid for c in FINANCE_CAPABILITIES for tid in c.tool_ids
)
