"""Deep-Research capability catalogue — maps research capability INTENTS to the
EXACT read-only OllaGraph tools (operationIds verified against the live /v1/tools
OpenAPI snapshot on 2026-08-28: search, scrape, scrape/batch, scrape/llm-ready,
extract/clean, extract/structured, crawl, text/similarity, text/diff, text/chunk,
aeo/freshness_signal).

Distinct intent keys (`research.*`) so registering these NEVER clobbers the SEO
(`seo.*`) or Blog (`blog.*`) intent maps when several flags are on. Only read-only
tools — Deep Research runs on the main agent (read-only ceiling), so nothing here
can mutate. Several tools overlap the SEO/Blog catalogues (search / scrape /
extract / text.* / freshness) — reused via the shared registry, never duplicated.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models.tools import SideEffect


@dataclass(frozen=True, slots=True)
class ResearchCapability:
    intent: str
    description: str
    tool_ids: tuple[str, ...]
    query: str  # canonical selector query for intent resolution / seeding
    inputs: str = "url"  # "text" | "html" | "url" | "query" | "file"
    side_effect: SideEffect = SideEffect.READ_ONLY


# The catalogue — read-only web/data acquisition + cross-check capabilities only.
RESEARCH_CAPABILITIES: tuple[ResearchCapability, ...] = (
    # --- acquisition: find + read sources --------------------------------------
    ResearchCapability(
        "research.web_search",
        "Search the web to discover candidate sources for a sub-question.",
        ("search_endpoint_v1_search_post",),
        "web search results sources for a query question",
        inputs="query",
    ),
    ResearchCapability(
        "research.read_source",
        "Read ONE source page as clean, LLM-ready content for evidence.",
        (
            "scrape_endpoint_v1_scrape_post",
            "scrape_llm_ready_endpoint_v1_scrape_llm_ready_post",
            "extract_clean_endpoint_v1_extract_clean_post",
        ),
        "scrape read a page content clean llm-ready for a url",
        inputs="url",
    ),
    ResearchCapability(
        "research.batch_sources",
        "Read MANY sources at once (parallel acquisition for a research branch).",
        ("batch_scrape_endpoint_v1_scrape_batch_post",),
        "batch scrape read multiple pages sources at once in parallel",
        inputs="url",
    ),
    ResearchCapability(
        "research.extract_structured",
        "Extract structured data (specs/pricing tables/JSON-LD) from a source.",
        ("extract_structured_endpoint_v1_extract_structured_post",),
        "extract structured data tables json-ld specs pricing from a page",
        inputs="url",
    ),
    ResearchCapability(
        "research.crawl",
        "Crawl a site/docs to discover the relevant pages for a sub-question.",
        ("crawl_endpoint_v1_crawl_post",),
        "crawl website docs discover relevant pages urls site-wide",
        inputs="url",
    ),
    # --- verification: cross-check, conflict, chunk, freshness -----------------
    ResearchCapability(
        "research.compare",
        "Cross-check two texts for support/overlap or conflict (claim vs source).",
        (
            "text_similarity_endpoint_v1_text_similarity_post",
            "text_diff_endpoint_v1_text_diff_post",
        ),
        "text similarity diff compare two sources claim support conflict overlap",
        inputs="text",
    ),
    ResearchCapability(
        "research.chunk",
        "Chunk a long source into bounded segments before extracting evidence.",
        ("text_chunk_endpoint_v1_text_chunk_post",),
        "chunk split long source text into segments",
        inputs="text",
    ),
    ResearchCapability(
        "research.freshness",
        "Assess a source's recency/decay for time-sensitive research.",
        ("aeo_freshness_signal_endpoint_v1_aeo_freshness_signal_post",),
        "content freshness recency decay signal date for a url",
        inputs="url",
    ),
)


def research_intent_map() -> dict[str, dict]:
    """The `{intent: {query, max_side_effect}}` entries to merge into the runtime
    INTENT_MAP. Distinct `research.*` keys — additive, never clobbers SEO/Blog."""
    return {
        c.intent: {"query": c.query, "max_side_effect": c.side_effect}
        for c in RESEARCH_CAPABILITIES
    }


def capability_summary(limit: int = 0) -> str:
    """A compact `intent — description` list for the research skill guidance."""
    lines = [f"- {c.intent}: {c.description}" for c in RESEARCH_CAPABILITIES]
    if limit:
        lines = lines[:limit]
    return "\n".join(lines)


# Every tool_id the research catalogue references — for the scope/no-invented-
# endpoint test. Must stay a subset of the live registry (pinned + tested).
RESEARCH_TOOL_IDS: frozenset[str] = frozenset(
    tid for c in RESEARCH_CAPABILITIES for tid in c.tool_ids
)
