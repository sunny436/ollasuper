"""Hermetic version of the §17 discovery evaluation — the representative queries
against the synthetic registry. Asserts sensible top candidates + correct
no-match. (The live-223 eval is a separate read-only verification report.)"""

from __future__ import annotations

import pytest

from app.tools.selection import discover_tools
from tests.fakes.tool_defs import sample_registry

REG = sample_registry()


@pytest.mark.parametrize(
    "query,expected_top_id",
    [
        ("Search the web for the latest LangGraph release.", "search"),
        ("Extract the main information from this webpage.", "extract_clean"),
        ("Crawl this website and find pricing pages.", "crawl"),
        ("Convert this document.", "convert_pdf"),
        ("Find broken links on this website.", "broken_links"),
    ],
)
def test_query_selects_expected_tool(query, expected_top_id):
    r = discover_tools(REG, query)
    assert not r.no_match, f"{query!r} unexpectedly no-match"
    assert r.candidates[0].tool.tool_id == expected_top_id


def test_seo_query_selects_seo_category():
    r = discover_tools(REG, "Analyze this text for SEO.")
    assert not r.no_match
    assert r.candidates[0].tool.category == "SEO"


@pytest.mark.parametrize(
    "query",
    [
        "Explain what gradient descent is.",
        "Find today's NVIDIA stock price.",  # no stock-quote tool exists
    ],
)
def test_no_relevant_tool_is_no_match(query):
    r = discover_tools(REG, query)
    assert r.no_match
    assert r.candidates == []
