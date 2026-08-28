"""Human-readable action labels for the live execution-status UI.

`action_label(tool_name, tool_id)` turns a raw tool identity into a
present-progressive phrase ("Auditing page metadata") for the unified execution
pill, so the chat never shows an endpoint name. It is injected ONCE at the emit
chokepoint (`writer.emit_event`) onto every `TOOL_CALL`, so it covers the generic
Ollagraph path AND every reserved built-in with one insertion point.

Resolution order (all generic — no per-tool frontend logic, works for future
tools): curated map (keyed on a normalized slug) → verb-family derivation →
"Running <Nice Name>". Pure and exception-safe: a label must never break a call.
"""

from __future__ import annotations

import re

# Strip the OpenAPI version/method tail (`..._v1_..._post`), the `_endpoint`/
# `_api`/`_tool` suffix, and the provider prefix, so both the short summary name
# and the long operationId normalize to the same key.
_TAIL = re.compile(r"_v\d+_.*$")
_SUFFIX = re.compile(r"(?:_endpoint|_api|_tool)$")
_PREFIX = re.compile(r"^(?:seo_|intel_|aeo_|ollagraph_|web_)")


def _slug(s: str) -> str:
    s = (s or "").strip().lower().replace("-", "_").replace(".", "_")
    s = _TAIL.sub("", s)
    s = _SUFFIX.sub("", s)
    s = _PREFIX.sub("", s)
    return s.strip("_")


# Curated backend metadata: precise wording for today's user-facing tools +
# reserved built-ins. Keyed on the normalized slug. Any tool can be given a
# precise phrase by adding one entry; everything else falls through to derivation.
_CURATED: dict[str, str] = {
    # web / scraping
    "search": "Searching the web",
    "serp_search": "Searching the web",
    "scrape": "Fetching the page",
    "batch_scrape": "Fetching pages",
    "crawl": "Crawling the website",
    "sitemap": "Inspecting the sitemap",
    "sitemap_inspect": "Inspecting the sitemap",
    # extraction
    "extract_clean": "Reading the page content",
    "clean_extract": "Reading the page content",
    "content_extract": "Reading the page content",
    "scrape_llm_ready": "Reading the source",
    "extract_structured": "Extracting structured data",
    "structured_extract": "Extracting structured data",
    "keyword_extract": "Extracting keywords",
    "keywords_extract": "Extracting keywords",
    # SEO audits
    "meta_audit": "Auditing page metadata",
    "metadata_audit": "Auditing page metadata",
    "page_audit": "Auditing the page",
    "broken_links": "Checking for broken links",
    "mixed_content": "Checking for mixed content",
    "schema_validate": "Validating structured data",
    "anchor_text_audit": "Analyzing anchor text",
    "anchor_text": "Analyzing anchor text",
    "readability": "Measuring readability",
    "redirect_chain": "Mapping redirects",
    "redirects_map": "Mapping redirects",
    # intel
    "robots": "Checking robots.txt",
    "robots_analyze": "Checking robots.txt",
    "headers": "Analyzing response headers",
    "headers_analyze": "Analyzing response headers",
    "ssl": "Checking the SSL certificate",
    "ssl_check": "Checking the SSL certificate",
    # blog: research / GEO / originality / conversion (stage-readable wording)
    "snippet_candidates": "Finding snippet candidates",
    "citation_readiness": "Checking AI-citation readiness",
    "heading_hierarchy": "Checking heading structure",
    "schema_coverage": "Checking schema coverage",
    "snippet_format_detect": "Detecting the answer format",
    "freshness_signal": "Checking content freshness",
    "competitor_diff": "Comparing competitors",
    "llms_txt_audit": "Auditing llms.txt",
    "llm_fetch_simulator": "Simulating an AI fetch",
    "chunk": "Chunking the text",
    "similarity": "Checking originality",
    "diff": "Comparing text",
    "pdf_to_markdown": "Converting the document",
    "docx_to_markdown": "Converting the document",
    "pptx_to_markdown": "Converting the document",
    "xlsx_to_markdown": "Converting the document",
    "csv_to_markdown": "Converting the document",
    "html_to_markdown": "Converting the document",
    "convert_ocr": "Reading the document (OCR)",
    # reserved built-ins
    "search_knowledge": "Reading your documents",
    "search_memory": "Recalling memory",
    "remember": "Saving to memory",
    "forget": "Updating memory",
    "generate_file": "Generating a file",
    "find_capabilities": "Finding the right tools",
    "delegate_to_agent": "Delegating to a specialist",
    "request_clarification": "Asking a follow-up",
    # deep research
    "record_research": "Recording a finding",
}

# Verb-family derivation (generic), word → present-progressive. Matched against
# the slug's WORDS (underscores are separators; `\b` regex fails across `_`).
_VERB_WORD: dict[str, str] = {
    "audit": "Auditing",
    "analyze": "Analyzing",
    "analyse": "Analyzing",
    "inspect": "Analyzing",
    "review": "Analyzing",
    "measure": "Analyzing",
    "validate": "Checking",
    "verify": "Checking",
    "check": "Checking",
    "crawl": "Crawling",
    "scrape": "Fetching",
    "fetch": "Fetching",
    "read": "Fetching",
    "browse": "Fetching",
    "download": "Fetching",
    "extract": "Extracting",
    "parse": "Extracting",
    "search": "Searching",
    "find": "Searching",
    "lookup": "Searching",
    "query": "Searching",
    "map": "Mapping",
    "trace": "Mapping",
    "generate": "Generating",
    "create": "Generating",
    "render": "Generating",
    "build": "Generating",
    "convert": "Converting",
    "transform": "Converting",
    "compare": "Comparing",
    "diff": "Comparing",
    "summarize": "Summarizing",
    "summarise": "Summarizing",
}


def _title(slug: str) -> str:
    words = [w for w in slug.split("_") if w]
    return " ".join(w[:1].upper() + w[1:] for w in words) if words else "a tool"


def action_label(tool_name: str, tool_id: str | None = None) -> str:
    """A human-readable present-progressive action phrase. Never raises; never
    returns a raw endpoint name."""
    try:
        name_slug = _slug(tool_name)
        id_slug = _slug(tool_id or "")
        for key in (name_slug, id_slug):
            if key and key in _CURATED:
                return _CURATED[key]
        # Verb-family derivation on whichever slug carries a known verb word.
        for slug in (name_slug, id_slug):
            words = [w for w in slug.split("_") if w]
            for i, w in enumerate(words):
                verb = _VERB_WORD.get(w)
                if verb:
                    obj = " ".join(words[:i] + words[i + 1 :]).strip()
                    return f"{verb} {obj}".strip() if obj else verb
        # Last resort — cleaned, never raw ("Running Redirect Chain").
        return f"Running {_title(name_slug or id_slug)}"
    except Exception:  # noqa: BLE001 — a label must never break a tool call
        return "Working"
