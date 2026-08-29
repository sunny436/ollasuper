"""HR capability catalogue — maps HR capability INTENTS to the EXACT read-only OllaGraph
tools. Every operationId is VERIFIED against the live tool registry (the same ids the
SEO/Blog/Research/Sales catalogues pin) — NOTHING invented. OllaSuper has NO dedicated
contacts/tables/document extraction endpoint; structured data, tables and contacts all
go through the ONE `extract_structured` op-id.

Distinct `hr.*` intent keys so registering these NEVER clobbers the SEO / Blog /
Research / Sales intent maps. Only READ-ONLY tools; the HR skill runs on the main agent
(read-only ceiling), so nothing here can mutate. All ids overlap the shared catalogues —
REUSED, never duplicated.

Numeric people-analytics and comp-CSV computation does NOT appear here: it reuses the
Data-Analysis compute tools (bound by the runner when a CSV is uploaded and
`ai_data_analysis_enabled` is on) plus the documented formulas in `app/hr/comp.py`.
Document generation (offer letters, reports) reuses the reserved `generate_file` tool.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models.tools import SideEffect


@dataclass(frozen=True, slots=True)
class HRCapability:
    intent: str
    description: str
    tool_ids: tuple[str, ...]
    query: str  # canonical selector query for intent resolution / seeding
    inputs: str = "url"  # "text" | "html" | "url" | "query" | "file"
    side_effect: SideEffect = SideEffect.READ_ONLY


# The catalogue — read-only HR-research + ingestion capabilities only.
HR_CAPABILITIES: tuple[HRCapability, ...] = (
    HRCapability(
        "hr.web_research",
        "Search the web for market compensation, salary benchmarks, employment/HR "
        "trends, or company/candidate background.",
        ("search_endpoint_v1_search_post",),
        "web search compensation salary benchmark market hr trend for a query",
        inputs="query",
    ),
    HRCapability(
        "hr.read_source",
        "Fetch a page's content (a salary-survey page, a company careers/comp page, a "
        "candidate profile).",
        (
            "scrape_endpoint_v1_scrape_post",
            "extract_clean_endpoint_v1_extract_clean_post",
        ),
        "scrape fetch read a compensation careers profile page content for a url",
        inputs="url",
    ),
    HRCapability(
        "hr.extract_structured",
        "Extract structured data / tables (salary bands, benchmark tables, contacts) "
        "from a page.",
        ("extract_structured_endpoint_v1_extract_structured_post",),
        "extract structured salary band benchmark table contacts from a page",
        inputs="url",
    ),
    HRCapability(
        "hr.convert_document",
        "Convert an uploaded handbook / policy / comp sheet / roster "
        "(PDF/DOCX/XLSX/CSV/HTML) to Markdown for analysis.",
        (
            "pdf_to_markdown_endpoint_v1_convert_pdf_to_markdown_post",
            "docx_to_markdown_endpoint_v1_convert_docx_to_markdown_post",
            "pptx_to_markdown_endpoint_v1_convert_pptx_to_markdown_post",
            "xlsx_to_markdown_endpoint_v1_convert_xlsx_to_markdown_post",
            "csv_to_markdown_endpoint_v1_convert_csv_to_markdown_post",
            "html_to_markdown_endpoint_v1_convert_html_to_markdown_post",
            "convert_ocr_endpoint_v1_convert_ocr_post",
        ),
        "convert handbook policy compensation roster pdf docx xlsx csv markdown",
        inputs="file",
    ),
)


def hr_intent_map() -> dict[str, dict]:
    """The `{intent: {query, max_side_effect}}` entries to merge into the runtime
    INTENT_MAP. Distinct `hr.*` keys — additive, never clobbers other capabilities."""
    return {
        c.intent: {"query": c.query, "max_side_effect": c.side_effect}
        for c in HR_CAPABILITIES
    }


def capability_summary(limit: int = 0) -> str:
    """A compact `intent — description` list for the HR skill guidance."""
    lines = [f"- {c.intent}: {c.description}" for c in HR_CAPABILITIES]
    if limit:
        lines = lines[:limit]
    return "\n".join(lines)


# Every tool_id the HR catalogue references — for the no-invented-endpoint test.
HR_TOOL_IDS: frozenset[str] = frozenset(
    tid for c in HR_CAPABILITIES for tid in c.tool_ids
)
