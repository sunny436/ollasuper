"""MCP -> ToolDefinition normalization. Pure: no server, no session, no network.

The important tests here are the side-effect ones. `side_effect` is what
`check_tool_policy` reads to decide whether a call needs human approval, and the
only metadata available to set it is a HINT the server itself controls — which
MCP's own types say clients "should never make tool use decisions based on...
from untrusted servers". So these tests pin the fail-safe, not the happy path.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from app.mcp.models import McpConfigError, McpServerIdentity
from app.mcp.normalize import normalize_tool, normalize_tools
from app.models.tools import Availability, SideEffect

TRUSTED = McpServerIdentity(slug="notion", display_name="Notion", trusted=True)
UNTRUSTED = McpServerIdentity(slug="sketchy", display_name="Sketchy", trusted=False)


@dataclass
class _Ann:
    read_only_hint: bool | None = None
    destructive_hint: bool | None = None
    idempotent_hint: bool | None = None


@dataclass
class _Tool:
    name: str
    description: str | None = "a tool"
    input_schema: Any = None
    output_schema: Any = None
    annotations: Any = None

    def __post_init__(self) -> None:
        if self.input_schema is None:
            self.input_schema = {
                "type": "object",
                "properties": {"q": {"type": "string"}},
            }


# --------------------------------------------------------------- identity
def test_tool_id_is_namespaced_by_server():
    d = normalize_tool(_Tool(name="search"), TRUSTED)
    assert d.tool_id == "mcp:notion:search"
    assert d.provider == "mcp:notion"
    assert d.name == "search"


def test_two_servers_exposing_the_same_tool_name_do_not_collide():
    """`ToolRegistry._by_id` silently overwrites on a duplicate id, and `search`
    exists on half the MCP ecosystem — so this is the collision that matters."""
    a = normalize_tool(_Tool(name="search"), TRUSTED)
    b = normalize_tool(_Tool(name="search"), UNTRUSTED)
    assert a.tool_id != b.tool_id
    assert a.provider != b.provider


def test_a_server_slug_is_validated():
    with pytest.raises(McpConfigError):
        McpServerIdentity(slug="Not A Slug")
    with pytest.raises(McpConfigError):
        McpServerIdentity(slug="x" * 40)  # would push the name past the 64-char cut


# ------------------------------------------------------------ side effect
def test_untrusted_server_never_gets_read_only_even_when_it_claims_to_be():
    """The whole point. A malicious server marking `delete_everything`
    read-only must not thereby skip the approval gate."""
    d = normalize_tool(
        _Tool(name="delete_everything", annotations=_Ann(read_only_hint=True)),
        UNTRUSTED,
    )
    assert d.side_effect is SideEffect.EXTERNAL_SIDE_EFFECT


def test_trusted_server_may_downgrade_an_explicit_read_only_hint():
    d = normalize_tool(
        _Tool(name="search", annotations=_Ann(read_only_hint=True)), TRUSTED
    )
    assert d.side_effect is SideEffect.READ_ONLY


def test_absent_annotations_are_side_effecting_even_on_a_trusted_server():
    """`destructive_hint` DEFAULTS TRUE in the spec, so silence means danger."""
    assert normalize_tool(_Tool(name="x"), TRUSTED).side_effect is (
        SideEffect.EXTERNAL_SIDE_EFFECT
    )


def test_a_destructive_hint_is_side_effecting_on_a_trusted_server():
    d = normalize_tool(
        _Tool(name="rm", annotations=_Ann(destructive_hint=True)), TRUSTED
    )
    assert d.side_effect is SideEffect.EXTERNAL_SIDE_EFFECT


def test_a_non_boolean_read_only_hint_does_not_downgrade():
    for bogus in (None, "true", 1, object()):
        d = normalize_tool(
            _Tool(name="x", annotations=_Ann(read_only_hint=bogus)), TRUSTED
        )
        assert d.side_effect is SideEffect.EXTERNAL_SIDE_EFFECT


def test_idempotency_is_never_taken_from_the_server():
    """`provider_idempotency_supported` makes a SIDE-EFFECTING tool auto-
    retryable; a server must not be able to opt its own writes into replay."""
    d = normalize_tool(_Tool(name="x", annotations=_Ann(idempotent_hint=True)), TRUSTED)
    assert d.provider_idempotency_supported is False


# ----------------------------------------------------------------- schema
def test_input_schema_passes_through():
    schema = {
        "type": "object",
        "properties": {"a": {"type": "integer"}},
        "required": ["a"],
    }
    assert (
        normalize_tool(_Tool(name="add", input_schema=schema), TRUSTED).input_schema
        == schema
    )


def test_a_non_object_schema_degrades_rather_than_dropping_the_tool():
    d = normalize_tool(_Tool(name="x", input_schema={"type": "string"}), TRUSTED)
    assert d.input_schema == {"type": "object", "properties": {}}


def test_http_only_fields_are_blank_not_defaulted():
    """`method`/`path` are OpenAPI-shaped and meaningless for MCP; blank makes
    that obvious instead of leaving a misleading 'post'."""
    d = normalize_tool(_Tool(name="x"), TRUSTED)
    assert d.method == "" and d.path == "" and d.required_auth == "mcp"


def test_category_is_per_server_so_a_scope_can_allow_one_connection():
    assert normalize_tool(_Tool(name="x"), TRUSTED).category == "mcp:notion"


def test_availability_and_enabled_are_set():
    d = normalize_tool(_Tool(name="x"), TRUSTED)
    assert d.enabled is True and d.availability is Availability.AVAILABLE


# ------------------------------------------------------------------ lists
def test_a_malformed_tool_is_skipped_not_fatal():
    """One bad entry must not cost the user every other tool on that server."""
    out = normalize_tools([_Tool(name="ok"), _Tool(name=""), object()], TRUSTED)
    assert [d.name for d in out] == ["ok"]


def test_empty_list_is_empty():
    assert normalize_tools([], TRUSTED) == []
