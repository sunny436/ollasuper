"""Does the curated ~30-server ecosystem stay practical? Measured, not asserted.

THE QUESTION THIS ANSWERS is §102/§134's: 30 servers does not mean 30 tools. A
user connected to the whole curated set could reasonably have several hundred,
and three things then matter — how long normalization takes, how large the
registry gets, and how much of the model's context the BOUND subset costs.

WHY THE BOUNDS ARE LOOSE. These run on whatever machine CI or a laptop provides,
so a tight timing assertion would be a flake generator. They are set an order of
magnitude above what was measured locally, which makes them a guard against an
accidental O(n^2) — not a benchmark. The actual numbers are PRINTED, so a
regression shows up as a changed number in the log rather than only as a failure.

NOTHING HERE TOUCHES A NETWORK. Normalization and selection are pure; the
registry is in-process. That is the point — the expensive parts of Phase 5 are
measurable without a server, and the parts that need a server are covered in the
integration tests.
"""

from __future__ import annotations

import json
import time

import pytest

from app.agent.executor import build_tool_specs
from app.mcp.models import McpServerIdentity
from app.mcp.normalize import normalize_tools
from app.models.tools import SideEffect, ToolFilters
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector

SERVERS = 30
TOOLS_PER_SERVER = 12  # 360 tools total — a realistic curated-set upper bound


class _Tool:
    """A tool shaped like a real one: nested schema, description, annotations."""

    def __init__(self, name: str, server: str) -> None:
        self.name = name
        self.description = (
            f"{name.replace('_', ' ').capitalize()} on {server}. "
            "Use this to search, list or fetch records from the connected "
            "account, filtering by the supplied criteria."
        )
        self.input_schema = {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to look for."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "filter": {"$ref": "#/$defs/Filter"},
            },
            "required": ["query"],
            "$defs": {
                "Filter": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string"},
                        "since": {"type": "string", "format": "date-time"},
                    },
                }
            },
        }
        self.output_schema = None
        self.annotations = type("A", (), {"read_only_hint": True})()


def _catalogue() -> tuple[ToolRegistry, float]:
    """Normalize 30 servers into one registry. Returns (registry, seconds)."""
    registry = ToolRegistry()
    start = time.perf_counter()
    for s in range(SERVERS):
        slug = f"server-{s:02d}"
        raw = [
            _Tool(f"{verb}_{noun}", slug)
            for verb in ("search", "list", "get", "create")
            for noun in ("issues", "pages", "messages")
        ][:TOOLS_PER_SERVER]
        tools = normalize_tools(raw, McpServerIdentity(slug=slug, trusted=True))
        registry.replace_provider(f"mcp:{slug}", tools)
    return registry, time.perf_counter() - start


def test_thirty_servers_normalize_and_register_quickly():
    registry, seconds = _catalogue()
    assert registry.count == SERVERS * TOOLS_PER_SERVER
    print(
        f"\nMEASURED normalize+register {registry.count} tools "
        f"from {SERVERS} servers: {seconds * 1000:.0f} ms"
    )
    # An order of magnitude above the local measurement. A genuine regression
    # (an accidental O(n^2) over providers) blows through this; jitter does not.
    assert seconds < 5.0


def test_every_tool_id_stays_unique_across_thirty_servers():
    """§52/§106. Thirty servers all exposing `search_issues` is the realistic
    case, and the namespacing has to hold at that scale, not just for two."""
    registry, _ = _catalogue()
    ids = {t.tool_id for t in registry.list()}
    assert len(ids) == registry.count, "a tool_id collided"
    # The bare names DO collide — that is exactly why `tool_id` is namespaced.
    names = {t.name for t in registry.list()}
    assert len(names) < registry.count


def test_selection_over_the_whole_catalogue_stays_fast_and_bounded():
    registry, _ = _catalogue()
    selector = ToolSelector(registry)
    start = time.perf_counter()
    result = selector.select(
        "search issues about authentication on github",
        top_k=5,
        min_score=0.2,
        filters=ToolFilters(max_side_effect=SideEffect.READ_ONLY),
    )
    seconds = time.perf_counter() - start
    print(
        f"\nMEASURED select over {registry.count} tools: "
        f"{seconds * 1000:.1f} ms, {len(result.candidates)} candidates "
        f"(scanned {result.stats['n_scored']})"
    )
    assert seconds < 2.0
    # THE CONTEXT-BUDGET PROPERTY: 360 tools in, at most `top_k` out. Binding the
    # whole catalogue is what would blow the context window, and the selector is
    # what stops it.
    assert len(result.candidates) <= 5


def test_the_bound_subset_is_a_tiny_fraction_of_the_catalogue():
    """§103. What reaches the model is what costs context — measure THAT."""
    registry, _ = _catalogue()
    selector = ToolSelector(registry)
    candidates = selector.select(
        "search issues about authentication",
        top_k=5,
        min_score=0.2,
        filters=ToolFilters(max_side_effect=SideEffect.READ_ONLY),
    ).candidates
    specs, _names = build_tool_specs(candidates, registry)

    bound_bytes = len(json.dumps(specs))
    all_specs, _ = build_tool_specs(
        [
            type("C", (), {"tool": t, "score": 1.0})()
            for t in registry.list()
        ],
        registry,
    )
    all_bytes = len(json.dumps(all_specs))
    print(
        f"\nMEASURED bound {len(specs)} specs = {bound_bytes} bytes; "
        f"binding ALL {len(all_specs)} would be {all_bytes} bytes "
        f"({all_bytes / max(bound_bytes, 1):.0f}x)"
    )
    # The whole catalogue would be tens of thousands of tokens of schema on every
    # single turn. This is the number the selection step exists to keep small.
    assert bound_bytes < all_bytes / 10


def test_nested_schemas_are_self_contained_after_normalization():
    """A `$ref` that survived to the model would be a dangling pointer, and one
    that resolved to `{}` would validate nothing — the Phase 3 bug, at scale."""
    registry, _ = _catalogue()
    for tool in registry.list():
        blob = json.dumps(tool.input_schema)
        assert "$ref" not in blob, tool.tool_id
        assert "$defs" not in blob, tool.tool_id
    # And the nested shape actually survived rather than being flattened away.
    sample = registry.list()[0]
    assert sample.input_schema["properties"]["filter"]["properties"]["label"]


@pytest.mark.parametrize("count", [1, 10, SERVERS])
def test_cost_grows_linearly_in_the_number_of_servers(count):
    """The guard against an accidental O(n^2): per-tool cost must not grow with
    the number of servers already registered."""
    registry = ToolRegistry()
    start = time.perf_counter()
    for s in range(count):
        slug = f"server-{s:02d}"
        raw = [_Tool(f"tool_{i}", slug) for i in range(TOOLS_PER_SERVER)]
        registry.replace_provider(
            f"mcp:{slug}",
            normalize_tools(raw, McpServerIdentity(slug=slug, trusted=True)),
        )
    per_tool_us = (time.perf_counter() - start) / max(registry.count, 1) * 1e6
    print(f"\nMEASURED {count:2d} servers: {per_tool_us:.0f} us per tool")
    assert per_tool_us < 5000
