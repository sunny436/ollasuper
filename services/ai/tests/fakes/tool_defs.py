"""Synthetic ToolDefinitions for hermetic Phase-2 discovery tests (no network,
no live spec). Spans the categories the §17 eval queries target, plus disabled/
high-impact/unavailable tools for filtering tests."""

from __future__ import annotations

from app.models.tools import (
    Availability,
    SideEffect,
    ToolDefinition,
    ToolPermissions,
)
from app.tools.registry import ToolRegistry


def _tool(tool_id, name, path, category, description, **kw) -> ToolDefinition:
    return ToolDefinition(
        tool_id=tool_id,
        name=name,
        path=path,
        category=category,
        description=description,
        method=kw.get("method", "post"),
        side_effect=kw.get("side_effect", SideEffect.READ_ONLY),
        enabled=kw.get("enabled", True),
        availability=kw.get("availability", Availability.AVAILABLE),
        permissions=kw.get("permissions", ToolPermissions()),
    )


def sample_tools() -> list[ToolDefinition]:
    return [
        _tool("scrape", "Scrape Endpoint", "/v1/scrape", "Scraping",
              "Scrape a web page and return its content"),
        _tool("extract_clean", "Extract Clean", "/v1/extract/clean", "Extraction",
              "Extract the main article body information from a webpage"),
        _tool("broken_links", "Broken Links Audit", "/v1/seo/broken-links-audit",
              "SEO", "Find broken links on a website"),
        _tool("meta_audit", "Meta Audit", "/v1/seo/meta-audit", "SEO",
              "Analyze the title and meta description of a page for SEO"),
        _tool("convert_pdf", "PDF To Markdown", "/v1/convert/pdf-to-markdown",
              "Conversion", "Convert a PDF document to markdown"),
        _tool("crawl", "Crawl", "/v1/crawl", "Crawling",
              "Crawl a website and follow its links"),
        _tool("search", "Search", "/v1/search", "Other",
              "Search the web for a query"),
        # high-impact + disabled (Phase 1 defaults for account ops)
        _tool("create_key", "Create My Key", "/v1/keys", "Account",
              "Create an API key",
              side_effect=SideEffect.HIGH_IMPACT, enabled=False,
              permissions=ToolPermissions(approval_required=True, user_scope=True)),
        # external side-effect + disabled
        _tool("session", "Create Session", "/v1/session", "Automation",
              "Create a persistent browser session",
              side_effect=SideEffect.EXTERNAL_SIDE_EFFECT, enabled=False,
              permissions=ToolPermissions(approval_required=True)),
        # unavailable (should be filtered by default)
        _tool("legacy_scrape", "Legacy Scrape", "/v1/legacy/scrape", "Other",
              "Deprecated scrape endpoint",
              availability=Availability.UNAVAILABLE),
    ]


def sample_registry() -> ToolRegistry:
    reg = ToolRegistry()
    reg.replace_all(sample_tools())
    return reg
