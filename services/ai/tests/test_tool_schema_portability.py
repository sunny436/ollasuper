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
