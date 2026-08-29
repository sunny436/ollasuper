"""Operations capability catalogue — maps Operations INTENTS to the EXACT read-only
OllaGraph tools. Every operationId is VERIFIED bound in OllaSuper's runtime (the same
ids
the SEO/Blog/Sales/HR/Finance/Marketing catalogues pin; re-verified live 12/12). The
public docs list a 147-endpoint superset that is NOT bound here — so structured
extraction
goes through the ONE `extract_structured`.

Distinct `operations.*` intent keys so registering these NEVER clobbers any sibling map.
Only READ-ONLY tools; the Operations skill runs on the main agent (read-only ceiling).
Operations has NO numeric tool — capacity/utilization math reuses the Data-Analysis
compute
tools, TCO/cost/affordability reuses `finance_calc`, both bound by their own flags.
Vendor
proposals, compliance sources and benchmarks come through these web/ingestion ops; SOPs/
runbooks/reports are produced with `generate_file`. NONE of those are OllaGraph
endpoints,
so none belong here.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models.tools import SideEffect


@dataclass(frozen=True, slots=True)
class OperationsCapability:
    intent: str
    description: str
    tool_ids: tuple[str, ...]
    query: str
    inputs: str = "url"
    side_effect: SideEffect = SideEffect.READ_ONLY


OPERATIONS_CAPABILITIES: tuple[OperationsCapability, ...] = (
    OperationsCapability(
        "operations.web_research",
        "Search the web for vendor information, current compliance/regulatory "
        "requirements, and operations best-practice benchmarks.",
        ("search_endpoint_v1_search_post",),
        "web search vendor compliance regulatory requirement operations "
        "benchmark query",
        inputs="query",
    ),
    OperationsCapability(
        "operations.read_source",
        "Fetch a vendor / product / pricing / regulatory / standards page's content.",
        (
            "scrape_endpoint_v1_scrape_post",
            "extract_clean_endpoint_v1_extract_clean_post",
        ),
        "scrape fetch read a vendor pricing regulatory standards page content "
        "for a url",
        inputs="url",
    ),
    OperationsCapability(
        "operations.extract_structured",
        "Extract structured data / tables (vendor pricing tiers, SLAs, compliance "
        "control tables) from a page.",
        ("extract_structured_endpoint_v1_extract_structured_post",),
        "extract structured vendor pricing sla compliance control table from a page",
        inputs="url",
    ),
    OperationsCapability(
        "operations.crawl_site",
        "Crawl a vendor / regulator site to discover pricing, security, and policy "
        "pages.",
        ("crawl_endpoint_v1_crawl_post",),
        "crawl vendor regulator website discover pricing security policy pages",
        inputs="url",
    ),
    OperationsCapability(
        "operations.convert_document",
        "Convert an uploaded vendor proposal / contract / SOP / workload export / "
        "compliance evidence (PDF/DOCX/PPTX/XLSX/CSV/HTML) to Markdown for analysis.",
        (
            "pdf_to_markdown_endpoint_v1_convert_pdf_to_markdown_post",
            "docx_to_markdown_endpoint_v1_convert_docx_to_markdown_post",
            "pptx_to_markdown_endpoint_v1_convert_pptx_to_markdown_post",
            "xlsx_to_markdown_endpoint_v1_convert_xlsx_to_markdown_post",
            "csv_to_markdown_endpoint_v1_convert_csv_to_markdown_post",
            "html_to_markdown_endpoint_v1_convert_html_to_markdown_post",
            "convert_ocr_endpoint_v1_convert_ocr_post",
        ),
        "convert vendor proposal contract sop workload compliance pdf docx "
        "xlsx markdown",
        inputs="file",
    ),
)


def operations_intent_map() -> dict[str, dict]:
    """The `{intent: {query, max_side_effect}}` entries to merge into the runtime
    INTENT_MAP. Distinct `operations.*` keys — additive, never clobbers other
    capabilities."""
    return {
        c.intent: {"query": c.query, "max_side_effect": c.side_effect}
        for c in OPERATIONS_CAPABILITIES
    }


def capability_summary(limit: int = 0) -> str:
    """A compact `intent — description` list for the Operations skill guidance."""
    lines = [f"- {c.intent}: {c.description}" for c in OPERATIONS_CAPABILITIES]
    if limit:
        lines = lines[:limit]
    return "\n".join(lines)


# Every tool_id the operations catalogue references — for the no-invented-endpoint test.
OPERATIONS_TOOL_IDS: frozenset[str] = frozenset(
    tid for c in OPERATIONS_CAPABILITIES for tid in c.tool_ids
)
