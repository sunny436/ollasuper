from __future__ import annotations

import json
from pathlib import Path

from app.models.tools import SideEffect
from app.tools.discovery import discover_from_spec

SPEC = json.loads(
    (Path(__file__).parent / "fakes" / "ollagraph_openapi.json").read_text()
)


def _by_id(result):
    return {d.tool_id: d for d in result.definitions}


def test_discovers_all_operations():
    r = discover_from_spec(SPEC, default_timeout=25.0)
    assert r.report["paths"] == 11
    assert r.report["operations_seen"] == 12  # >paths (one path has GET+POST)
    assert r.report["registered"] == 12
    assert r.report["version"] == "1.0.0"


def test_categories_counted():
    r = discover_from_spec(SPEC, default_timeout=25.0)
    cats = r.report["by_category"]
    assert cats == {
        "Scraping": 3,
        "Account": 3,
        "Other": 2,
        "Testing": 2,
        "Intelligence": 1,
        "Automation": 1,
    }


def test_duplicate_operation_id_deduped():
    r = discover_from_spec(SPEC, default_timeout=25.0)
    assert "dup_op" in r.report["duplicate_operation_ids"]
    ids = [d.tool_id for d in r.definitions]
    assert len(ids) == len(set(ids))  # unique after dedup
    assert ids.count("dup_op") == 1  # only the first keeps the bare id


def test_side_effect_classification():
    d = _by_id(discover_from_spec(SPEC, default_timeout=25.0))
    assert d["scrape_endpoint_v1_scrape_post"].side_effect == SideEffect.READ_ONLY
    assert d["scrape_endpoint_v1_scrape_post"].enabled is True
    assert d["whoami_v1_intel_whoami_get"].side_effect == SideEffect.READ_ONLY
    assert d["create_my_key_v1_keys_post"].side_effect == SideEffect.HIGH_IMPACT
    assert d["create_my_key_v1_keys_post"].enabled is False
    assert (
        d["delete_my_key_v1_keys_key_id_delete"].side_effect == SideEffect.HIGH_IMPACT
    )
    assert (
        d["create_session_v1_session_post"].side_effect
        == SideEffect.EXTERNAL_SIDE_EFFECT
    )
    assert (
        d["scrape_async_v1_scrape_async_post"].side_effect
        == SideEffect.EXTERNAL_SIDE_EFFECT
    )


def test_admin_token_ops_flagged_and_disabled():
    d = _by_id(discover_from_spec(SPEC, default_timeout=25.0))
    admin = d["admin_rotate_v1_admin_rotate_post"]
    assert admin.required_auth == "AdminToken"
    assert admin.side_effect == SideEffect.HIGH_IMPACT
    assert admin.enabled is False


def test_bearer_is_default_auth():
    d = _by_id(discover_from_spec(SPEC, default_timeout=25.0))
    assert d["scrape_endpoint_v1_scrape_post"].required_auth == "BearerAuth"


def test_timeout_from_schema_else_default():
    d = _by_id(discover_from_spec(SPEC, default_timeout=25.0))
    assert d["scrape_endpoint_v1_scrape_post"].timeout == 30.0  # schema default
    assert d["whoami_v1_intel_whoami_get"].timeout == 25.0  # config default


def test_output_schema_none_for_all():
    r = discover_from_spec(SPEC, default_timeout=25.0)
    assert all(d.output_schema is None for d in r.definitions)


def test_input_schema_preserved_as_ref():
    d = _by_id(discover_from_spec(SPEC, default_timeout=25.0))
    # Raw $ref is kept (not dereferenced) — resolution is the registry's job.
    assert d["scrape_endpoint_v1_scrape_post"].input_schema == {
        "$ref": "#/components/schemas/ScrapeRequest"
    }


def test_empty_spec_yields_nothing():
    r = discover_from_spec({}, default_timeout=25.0)
    assert r.report["registered"] == 0
    assert r.definitions == []


def test_garbage_operations_are_skipped_not_raised():
    r = discover_from_spec(
        {"paths": {"/x": "not-a-dict", "/y": {"post": 123}}}, default_timeout=25.0
    )
    assert r.report["registered"] == 0
