"""Documents capability catalogue — maps Documents INTENTS to the EXACT read-only
OllaGraph tools, for the OPTIONAL case of reading a document that lives at a URL. Every
operationId is VERIFIED bound in OllaSuper's runtime (the same ids the SEO/Blog/Sales/
HR/Finance/Marketing/Operations catalogues pin).

IMPORTANT: document GENERATION and local file processing NEVER depend on OllaGraph — the
skill creates/reads/edits PPTX+PDF from the user's prompt, uploaded files, and existing
OllaSuper context. These intents exist only so "read the PDF at <url>" / "turn this web
page into a deck" can reach the shared web/convert tools; they are additive and never
clobber a sibling map.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models.tools import SideEffect


@dataclass(frozen=True, slots=True)
class DocumentsCapability:
    intent: str
    description: str
    tool_ids: tuple[str, ...]
    query: str
    inputs: str = "url"
    side_effect: SideEffect = SideEffect.READ_ONLY


DOCUMENTS_CAPABILITIES: tuple[DocumentsCapability, ...] = (
    DocumentsCapability(
        "documents.read_web_source",
        "Fetch a web page's content when the user wants it turned into a PDF or a "
        "presentation (optional; local files and prompts need no web access).",
        (
            "scrape_endpoint_v1_scrape_post",
            "extract_clean_endpoint_v1_extract_clean_post",
        ),
        "read fetch scrape a web page article url to turn into a pdf or presentation",
        inputs="url",
    ),
    DocumentsCapability(
        "documents.convert_url_document",
        "Convert a document that lives at a URL (PDF/DOCX/PPTX/XLSX/CSV/HTML) to "
        "Markdown so it can be read, summarised, or reworked into a new document.",
        (
            "pdf_to_markdown_endpoint_v1_convert_pdf_to_markdown_post",
            "docx_to_markdown_endpoint_v1_convert_docx_to_markdown_post",
            "pptx_to_markdown_endpoint_v1_convert_pptx_to_markdown_post",
            "xlsx_to_markdown_endpoint_v1_convert_xlsx_to_markdown_post",
            "csv_to_markdown_endpoint_v1_convert_csv_to_markdown_post",
            "html_to_markdown_endpoint_v1_convert_html_to_markdown_post",
            "convert_ocr_endpoint_v1_convert_ocr_post",
        ),
        "convert a pdf docx pptx document at a url to markdown to read or rework",
        inputs="file",
    ),
)


def documents_intent_map() -> dict[str, dict]:
    """The `{intent: {query, max_side_effect}}` entries to merge into the runtime
    INTENT_MAP. Distinct `documents.*` keys — additive, never clobbers other maps."""
    return {
        c.intent: {"query": c.query, "max_side_effect": c.side_effect}
        for c in DOCUMENTS_CAPABILITIES
    }


def capability_summary(limit: int = 0) -> str:
    """A compact `intent — description` list for the Documents skill guidance."""
    lines = [f"- {c.intent}: {c.description}" for c in DOCUMENTS_CAPABILITIES]
    if limit:
        lines = lines[:limit]
    return "\n".join(lines)


# Every tool_id the catalogue references — for the no-invented-endpoint test.
DOCUMENTS_TOOL_IDS: frozenset[str] = frozenset(
    tid for c in DOCUMENTS_CAPABILITIES for tid in c.tool_ids
)
