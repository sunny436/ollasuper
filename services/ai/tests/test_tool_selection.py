from __future__ import annotations

from pathlib import Path

from app.models.tools import SideEffect, ToolFilters
from app.tools.selection import discover_tools
from tests.fakes.tool_defs import sample_registry

REG = sample_registry()


def _ids(result):
    return [c.tool.tool_id for c in result.candidates]


def test_relevant_query_returns_relevant_tool():
    r = discover_tools(REG, "find broken links on a website")
    assert not r.no_match
    assert r.candidates[0].tool.tool_id == "broken_links"
    assert "path" in r.candidates[0].matched_signals


def test_description_and_category_match():
    r = discover_tools(REG, "analyze this text for SEO")
    assert not r.no_match
    assert r.candidates[0].tool.category == "SEO"


def test_exact_name_query():
    r = discover_tools(REG, "crawl")
    assert not r.no_match
    assert r.candidates[0].tool.tool_id == "crawl"


def test_irrelevant_query_is_no_match():
    r = discover_tools(REG, "explain gradient descent")
    assert r.no_match
    assert r.candidates == []


def test_disabled_tools_filtered_by_default():
    # create_key is high_impact + enabled=False → must not appear by default.
    r = discover_tools(REG, "create an api key")
    assert "create_key" not in _ids(r)


def test_include_disabled_surfaces_marked_high_impact():
    r = discover_tools(
        REG, "create an api key", filters=ToolFilters(include_disabled=True)
    )
    ids = _ids(r)
    assert "create_key" in ids
    cand = next(c for c in r.candidates if c.tool.tool_id == "create_key")
    assert cand.tool.enabled is False
    assert cand.tool.side_effect == SideEffect.HIGH_IMPACT
    assert cand.tool.permissions.approval_required is True


def test_unavailable_tools_filtered_by_default():
    r = discover_tools(REG, "scrape a web page")
    assert "legacy_scrape" not in _ids(r)
    assert "scrape" in _ids(r)


def test_max_side_effect_ceiling_excludes_high_impact_and_external():
    r = discover_tools(
        REG,
        "create an api key or a browser session",
        filters=ToolFilters(
            include_disabled=True, max_side_effect=SideEffect.READ_ONLY
        ),
    )
    ids = _ids(r)
    assert "create_key" not in ids  # high_impact
    assert "session" not in ids  # external_side_effect


def test_top_k_is_respected():
    r = discover_tools(REG, "scrape extract page content web", top_k=2)
    assert len(r.candidates) <= 2


def test_results_sorted_by_score_then_tool_id():
    r = discover_tools(REG, "scrape extract page seo convert crawl search")
    keys = [(-c.score, c.tool.tool_id) for c in r.candidates]
    assert keys == sorted(keys)


def test_candidate_carries_status_metadata():
    r = discover_tools(REG, "scrape a web page")
    c = r.candidates[0]
    assert c.tool.enabled is True
    assert c.tool.availability.value == "available"
    assert 0.0 <= c.score <= 1.0
    assert c.reason


def test_scores_are_normalized_0_to_1():
    r = discover_tools(REG, "convert this pdf document to markdown")
    assert all(0.0 <= c.score <= 1.0 for c in r.candidates)


def test_selection_module_is_pure_no_network_no_llm():
    # Structural guarantee: discovery never executes/embeds/binds tools.
    src = (Path(__file__).parent.parent / "app" / "tools" / "selection.py").read_text()
    for forbidden in ("httpx", "bind_tools", "ToolNode", "openai", "embed"):
        assert forbidden not in src, f"selection.py must not reference {forbidden}"
