"""Every tool schema must be accepted by EVERY routed provider.

THE PRODUCTION FAILURE (2026-09-16): the Master Model Router moved simple and
complex work onto Gemini. `generate_file` declared its table rows as
`{"type": "array", "items": {"type": "array"}}` — an inner array with no
`items`. Gemini's validator rejects that outright
(`400 ...rows.items.items: missing field`), and because the spec is bound on
every agentic turn, EVERY Gemini turn failed before a single token: two of the
router's three tiers, dead. DeepSeek and the OpenAI-compatible providers had
been accepting the omission silently for months, which is why no test noticed.

This walks every reserved spec the runner can bind, so the next tool added with
the same omission fails here instead of on production.
"""

from __future__ import annotations

import pytest

import app.runtime.runner as runner


def _specs() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for name in dir(runner):
        value = getattr(runner, name)
        if name.endswith("_TOOL_SPEC") and isinstance(value, dict):
            out[name] = value
        elif name.endswith("_TOOL_SPECS") and isinstance(value, list | tuple):
            for i, spec in enumerate(value):
                out[f"{name}[{i}]"] = spec
    return out


def _arrays_without_items(node: object, path: str = "") -> list[str]:
    found: list[str] = []
    if isinstance(node, dict):
        if node.get("type") == "array" and "items" not in node:
            found.append(path or "<root>")
        for key, child in node.items():
            found += _arrays_without_items(child, f"{path}.{key}")
    elif isinstance(node, list):
        for i, child in enumerate(node):
            found += _arrays_without_items(child, f"{path}[{i}]")
    return found


def test_the_scan_actually_sees_the_specs():
    """Guards against a vacuous pass if the runner's naming ever changes."""
    specs = _specs()
    assert len(specs) >= 10, sorted(specs)
    assert "GENERATE_FILE_TOOL_SPEC" in specs


@pytest.mark.parametrize("name", sorted(_specs()))
def test_every_array_declares_its_items(name):
    missing = _arrays_without_items(_specs()[name])
    assert not missing, f"{name}: arrays with no `items` (Gemini rejects): {missing}"


def test_table_cells_still_allow_real_numbers():
    """The fix must not trade one breakage for another: forcing string cells
    would satisfy Gemini and silently break native spreadsheet charts."""
    from app.agent.filegen_tool import GENERATE_FILE_TOOL_SPEC

    sheets = GENERATE_FILE_TOOL_SPEC["function"]["parameters"]["properties"]["sheets"]
    cell = sheets["items"]["properties"]["rows"]["items"]["items"]
    types = {branch["type"] for branch in cell["anyOf"]}
    assert types == {"string", "number"}


# ------------------------------------------ dynamic (registry) tool schemas
#
# The static scan above cannot see these: Ollagraph and MCP tools arrive with
# their schemas at runtime. Measured on production after the Gemini router
# change: a tool schema carrying `readOnly` failed every Gemini turn for a real
# user with `400 Unknown name "readOnly"`. Probing the live gateway keyword by
# keyword found Gemini rejects exactly `readOnly` and `writeOnly`.
def test_registry_tool_schemas_are_made_portable():
    from app.agent.executor import build_tool_specs
    from app.models.tools import SideEffect, ToolCandidate, ToolDefinition
    from app.tools.registry import ToolRegistry

    schema = {
        "type": "object",
        "properties": {
            "urls": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "format": "uri"},
                        "id": {"type": "string", "readOnly": True},
                        "secret": {"type": "string", "writeOnly": True},
                        # A PARAMETER literally named readOnly is real input.
                        "readOnly": {"type": "boolean", "description": "flag"},
                    },
                    "additionalProperties": False,
                },
            },
            "mode": {
                "type": "string",
                "enum": ["a", "b"],
                # Data, not schema: must survive untouched.
                "default": "a",
                "examples": [{"readOnly": True}],
            },
        },
        "required": ["urls"],
    }
    tool = ToolDefinition(
        tool_id="crawl_endpoint_v1_crawl_post",
        name="crawl",
        description="Crawl.",
        provider="ollagraph",
        input_schema=schema,
        side_effect=SideEffect.READ_ONLY,
    )
    reg = ToolRegistry()
    reg.register(tool)
    specs, _ = build_tool_specs([ToolCandidate(tool=tool, score=1.0)], reg)
    params = specs[0]["function"]["parameters"]

    import json

    blob = json.dumps(params)
    item = params["properties"]["urls"]["items"]
    assert "readOnly" not in item["properties"]["id"], "keyword not stripped"
    assert "writeOnly" not in item["properties"]["secret"], "keyword not stripped"
    assert "readOnly" in item["properties"], "a parameter NAMED readOnly was deleted"
    assert item["properties"]["url"]["format"] == "uri", "a portable keyword was lost"
    assert item["additionalProperties"] is False
    assert params["properties"]["mode"]["examples"] == [{"readOnly": True}], (
        "example DATA was rewritten"
    )
    assert params["properties"]["mode"]["default"] == "a"
    assert params["required"] == ["urls"]
    assert '"readOnly": true' not in blob.replace(
        '"examples": [{"readOnly": true}]', ""
    )
