"""`$defs` resolution — the difference between validating nested MCP args and
only appearing to.

WHY THIS FILE EXISTS. MCP tool schemas come from pydantic, so a nested model is
emitted as `$defs` plus `{"$ref": "#/$defs/Filter"}`. OllaSuper's executor
dereferences the OpenAPI form (`#/components/schemas/X`) and resolves anything
else to `{}`. An empty schema node validates NOTHING, and it does so silently —
so before this resolver, every top-level check fired while an undeclared nested
field, a missing nested required field and a wrong nested type all passed.

The table in `test_nested_validation_before_and_after` is the regression: remove
`resolve_local_refs` from `_schema` and the three "after" rows flip to ACCEPT.

Pure: no server, no network, no clock.
"""

from __future__ import annotations

import pytest

from app.mcp.models import McpServerIdentity
from app.mcp.normalize import (
    MAX_SCHEMA_BYTES,
    normalize_tool,
    normalize_tools,
    resolve_local_refs,
)
from app.tools.errors import ToolError
from app.tools.validate import validate_args

IDENTITY = McpServerIdentity(slug="fake", display_name="Fake", trusted=True)

# Exactly the shape a pydantic-backed MCP server emits for
# `def search(query: str, filters: Filter, tags: list[str] = [])`.
PYDANTIC_SCHEMA = {
    "type": "object",
    "$defs": {
        "Filter": {
            "type": "object",
            "title": "Filter",
            "properties": {
                "label": {"type": "string", "title": "Label"},
                "limit": {
                    "anyOf": [{"type": "integer"}, {"type": "null"}],
                    "default": None,
                },
            },
            "required": ["label"],
        }
    },
    "properties": {
        "query": {"type": "string", "title": "Query"},
        "filters": {"$ref": "#/$defs/Filter"},
        "tags": {"type": "array", "items": {"type": "string"}, "default": []},
    },
    "required": ["query", "filters"],
}


class _Tool:
    """The duck-typed shape `normalize_tool` reads. Not an SDK import: this
    module must stay importable without the transport stack."""

    def __init__(self, name, schema, description="d", annotations=None):
        self.name = name
        self.input_schema = schema
        self.description = description
        self.annotations = annotations
        self.output_schema = None


def _accepts(schema: dict, payload: dict) -> bool:
    try:
        validate_args(payload, schema)
        return True
    except ToolError:
        return False


# --------------------------------------------------------------- the table
@pytest.mark.parametrize(
    ("label", "payload", "accepted"),
    [
        ("valid nested", {"query": "x", "filters": {"label": "a", "limit": 3}}, True),
        (
            "valid optional null",
            {"query": "x", "filters": {"label": "a", "limit": None}},
            True,
        ),
        (
            "valid list of str",
            {"query": "x", "filters": {"label": "a"}, "tags": ["a"]},
            True,
        ),
        (
            "undeclared NESTED field",
            {"query": "x", "filters": {"label": "a", "evil": 1}},
            False,
        ),
        ("missing NESTED required", {"query": "x", "filters": {"limit": 3}}, False),
        ("wrong NESTED type", {"query": "x", "filters": {"label": 999}}, False),
    ],
)
def test_nested_validation_before_and_after(label, payload, accepted):
    """THE regression. Unresolved, the three hostile rows are ACCEPTED."""
    unresolved = PYDANTIC_SCHEMA
    resolved = normalize_tool(_Tool("search", PYDANTIC_SCHEMA), IDENTITY).input_schema

    assert _accepts(resolved, payload) is accepted, label
    if not accepted:
        # Proof this test would pass vacuously without the resolver.
        assert _accepts(unresolved, payload) is True, (
            f"{label}: the unresolved schema should have let this through — "
            "if it no longer does, this test has stopped being a regression test"
        )


def test_top_level_validation_was_never_the_broken_part():
    resolved = normalize_tool(_Tool("search", PYDANTIC_SCHEMA), IDENTITY).input_schema
    assert not _accepts(resolved, {"query": "x", "filters": {"label": "a"}, "evil": 1})
    assert not _accepts(resolved, {"query": "x"})
    assert not _accepts(resolved, {"query": 5, "filters": {"label": "a"}})


# ------------------------------------------------------------- the bounds
def test_a_self_referential_ref_terminates():
    """A server that models a tree must not hang discovery."""
    cyclic = {
        "type": "object",
        "$defs": {
            "Node": {
                "type": "object",
                "properties": {"child": {"$ref": "#/$defs/Node"}},
            }
        },
        "properties": {"root": {"$ref": "#/$defs/Node"}},
    }
    out = resolve_local_refs(cyclic)
    assert out["properties"]["root"]["type"] == "object"
    # The recursion stops at the cycle; that node is open, which is the honest
    # trade against dropping an otherwise-usable tool.
    assert out["properties"]["root"]["properties"]["child"] == {}


def test_defs_is_stripped_from_the_stored_schema():
    out = normalize_tool(_Tool("search", PYDANTIC_SCHEMA), IDENTITY).input_schema
    assert "$defs" not in out
    assert "$ref" not in str(out)


def test_openapi_style_refs_are_left_alone():
    """`#/components/schemas/X` belongs to Ollagraph's resolver. Rewriting it
    here would break the other provider."""
    schema = {"type": "object", "properties": {"a": {"$ref": "#/components/schemas/A"}}}
    assert resolve_local_refs(schema)["properties"]["a"] == {
        "$ref": "#/components/schemas/A"
    }


def test_a_dangling_ref_becomes_empty_not_a_crash():
    schema = {"type": "object", "properties": {"a": {"$ref": "#/$defs/Missing"}}}
    assert resolve_local_refs(schema)["properties"]["a"] == {}


def test_an_oversized_resolved_schema_drops_only_that_tool():
    """Inlining a `$defs` entry used in many places MULTIPLIES it, so the cap is
    applied after resolution, not before."""
    big = {"type": "string", "description": "A" * 4000}  # noqa: E501
    fat = {
        "type": "object",
        "$defs": {"Big": big},
        "properties": {f"f{i}": {"$ref": "#/$defs/Big"} for i in range(40)},
    }
    assert len(str(fat)) < MAX_SCHEMA_BYTES, "the UNRESOLVED schema is small"
    with pytest.raises(ValueError, match="too large"):
        normalize_tool(_Tool("fat", fat), IDENTITY)

    ok = _Tool("ok", {"type": "object", "properties": {}})
    out = normalize_tools([_Tool("fat", fat), ok], IDENTITY)
    assert [t.name for t in out] == ["ok"], "one fat tool must not cost the others"


def test_tool_count_is_capped_because_the_server_chooses_it():
    tools = [_Tool(f"t{i}", {"type": "object", "properties": {}}) for i in range(300)]
    assert len(normalize_tools(tools, IDENTITY, max_tools=256)) == 256
    assert len(normalize_tools(tools, IDENTITY, max_tools=10)) == 10


def test_a_non_object_schema_still_falls_back_to_empty_object():
    """Phase 1 behaviour preserved: offering a tool with no arguments beats
    dropping it silently."""
    assert normalize_tool(_Tool("x", "nonsense"), IDENTITY).input_schema == {
        "type": "object",
        "properties": {},
    }
