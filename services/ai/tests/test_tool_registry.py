from __future__ import annotations

import json
from pathlib import Path

from app.models.tools import ToolDefinition
from app.tools.discovery import discover_from_spec
from app.tools.registry import ToolRegistry

SPEC = json.loads(
    (Path(__file__).parent / "fakes" / "ollagraph_openapi.json").read_text()
)


def _reg() -> ToolRegistry:
    reg = ToolRegistry()
    r = discover_from_spec(SPEC, default_timeout=25.0)
    reg.replace_all(r.definitions, r.components, r.report)
    return reg


def test_count_and_lookup_by_id():
    reg = _reg()
    assert reg.count == 12
    t = reg.get("scrape_endpoint_v1_scrape_post")
    assert t is not None and t.category == "Scraping"
    assert reg.get("does-not-exist") is None


def test_lookup_by_name():
    reg = _reg()
    t = reg.get_by_name("Scrape Endpoint")
    assert t is not None and t.tool_id == "scrape_endpoint_v1_scrape_post"
    assert reg.get_by_name("no such tool") is None


def test_lookup_by_category():
    reg = _reg()
    account = reg.by_category("Account")
    assert len(account) == 3
    assert all(t.category == "Account" for t in account)
    assert reg.by_category("Nonexistent") == []


def test_snapshot_counts():
    reg = _reg()
    snap = reg.snapshot()
    assert snap["count"] == 12
    assert snap["enabled"] == 7  # the read-only tools
    assert snap["categories"]["Scraping"] == 3


def test_register_is_idempotent():
    reg = ToolRegistry()
    t = ToolDefinition(tool_id="x", name="X", category="C")
    reg.register(t)
    reg.register(t)
    assert reg.count == 1


def test_replace_all_atomic_swap():
    reg = _reg()
    assert reg.count == 12
    reg.replace_all(
        [ToolDefinition(tool_id="only", name="Only", category="C")], {}, {}
    )
    assert reg.count == 1
    assert reg.get("scrape_endpoint_v1_scrape_post") is None
    assert reg.get("only") is not None


def test_resolve_schema_normal_ref():
    reg = _reg()
    resolved = reg.resolve_schema({"$ref": "#/components/schemas/ScrapeRequest"})
    assert resolved.get("required") == ["url"]


def test_resolve_schema_cycle_terminates():
    reg = _reg()
    # SelfRef -> SelfRef (bare self-reference). Must return, not hang/recurse.
    resolved = reg.resolve_schema({"$ref": "#/components/schemas/SelfRef"})
    assert isinstance(resolved, dict)
