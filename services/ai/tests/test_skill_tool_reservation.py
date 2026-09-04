"""A skill's DECLARED tools must survive discovery and the schema-budget trim.

The production failure: the blog skill declares 34 `blog.*` capabilities, lexical
discovery scored a single unrelated tool (`seo_mixed_content`, 0.202), and the
real blog turn bound none of the declared ones — falling back to 12 generic web
searches. Relevance scoring is a poor proxy for "the methodology names this tool".

The trim keeps a score-ordered PREFIX, so the fix is two-part: seed what
discovery missed, and order declared tools first so the cut can only reach
undeclared ones.
"""

from __future__ import annotations

import pytest

from app.models.tools import (
    SideEffect,
    ToolCandidate,
    ToolDefinition,
    ToolFilters,
    ToolPermissions,
)
from app.runtime.runner import reserve_skill_tools
from app.tools.registry import ToolRegistry

pytestmark = pytest.mark.anyio


def _tool(
    tool_id: str,
    *,
    side_effect: SideEffect = SideEffect.READ_ONLY,
    permissions: list[str] | None = None,
) -> ToolDefinition:
    return ToolDefinition(
        tool_id=tool_id,
        provider="ollagraph",
        name=tool_id,
        description=tool_id,
        input_schema={"type": "object"},
        side_effect=side_effect,
        permissions=ToolPermissions(required_permissions=permissions or []),
    )


class _Registry(ToolRegistry):
    """A registry standing in for the live Ollagraph catalogue."""

    def __init__(self, tools: list[ToolDefinition]) -> None:
        super().__init__()
        self._fake = {t.tool_id: t for t in tools}

    def get(self, tool_id: str):  # type: ignore[override]
        return self._fake.get(tool_id)


READ_ONLY = ToolFilters(max_side_effect=SideEffect.READ_ONLY)


def test_a_declared_tool_discovery_missed_is_added():
    """The core failure: blog.keywords exists, scored nothing, was never bound."""
    reg = _Registry([_tool("blog.keywords"), _tool("unrelated")])
    candidates = [ToolCandidate(tool=_tool("unrelated"), score=0.9)]

    out, added = reserve_skill_tools(
        candidates, {"blog.keywords"}, reg, READ_ONLY
    )

    assert added == 1
    assert "blog.keywords" in {c.tool.tool_id for c in out}


def test_declared_tools_sort_ahead_of_higher_scoring_ones():
    """The trim cuts a score-ordered PREFIX from the tail, so ordering IS the
    protection — a declared tool must never be the casualty."""
    reg = _Registry([_tool("blog.keywords")])
    candidates = [
        ToolCandidate(tool=_tool("high"), score=0.95),
        ToolCandidate(tool=_tool("mid"), score=0.55),
    ]

    out, _ = reserve_skill_tools(candidates, {"blog.keywords"}, reg, READ_ONLY)

    assert out[0].tool.tool_id == "blog.keywords"
    # Truncating to ANY prefix length keeps the declared tool.
    assert "blog.keywords" in {c.tool.tool_id for c in out[:1]}


def test_an_already_discovered_declared_tool_is_not_duplicated():
    reg = _Registry([_tool("blog.keywords")])
    candidates = [ToolCandidate(tool=_tool("blog.keywords"), score=0.4)]

    out, added = reserve_skill_tools(
        candidates, {"blog.keywords"}, reg, READ_ONLY
    )

    assert added == 0
    ids = [c.tool.tool_id for c in out]
    assert ids.count("blog.keywords") == 1


def test_a_skill_cannot_widen_authorization():
    """A skill may widen what is RELEVANT, never what is ALLOWED. Seeding runs
    through the selector's own `_passes`, so the side-effect ceiling still binds
    even when a skill explicitly declares the tool."""
    reg = _Registry(
        [
            _tool("safe.read"),
            _tool("dangerous.write", side_effect=SideEffect.EXTERNAL_SIDE_EFFECT),
            _tool("nuclear", side_effect=SideEffect.HIGH_IMPACT),
        ]
    )

    out, added = reserve_skill_tools(
        [], {"safe.read", "dangerous.write", "nuclear"}, reg, READ_ONLY
    )

    ids = {c.tool.tool_id for c in out}
    assert ids == {"safe.read"}
    assert added == 1


def test_a_declared_tool_the_user_lacks_permission_for_is_not_seeded():
    reg = _Registry([_tool("needs.admin", permissions=["admin"])])
    filters = ToolFilters(
        max_side_effect=SideEffect.READ_ONLY, granted_permissions=set()
    )

    out, added = reserve_skill_tools([], {"needs.admin"}, reg, filters)

    assert added == 0
    assert not out


def test_a_declared_tool_missing_from_the_registry_is_skipped():
    """A stale capability id must degrade quietly, never raise mid-turn."""
    reg = _Registry([])
    out, added = reserve_skill_tools([], {"gone.away"}, reg, READ_ONLY)
    assert added == 0
    assert not out


def test_no_declared_tools_leaves_the_candidate_order_untouched():
    """The no-skill path — every simple request — must be byte-identical."""
    reg = _Registry([])
    candidates = [
        ToolCandidate(tool=_tool("a"), score=0.9),
        ToolCandidate(tool=_tool("b"), score=0.5),
    ]
    out, added = reserve_skill_tools(candidates, set(), reg, READ_ONLY)
    assert added == 0
    assert [c.tool.tool_id for c in out] == ["a", "b"]
