"""Registry parsing, against fixtures CAPTURED FROM THE LIVE API.

The fixtures in tests/fakes/registry/ are real responses, including two genuine
`deleted` tombstones — so tombstone handling is tested against what the registry
actually sends rather than a hand-written approximation of it.

Pure module: no DB, no network, no clock.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from app.mcp.registry.parse import parse_entry, parse_page

FIXTURES = Path(__file__).parent / "fakes" / "registry"


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def _entry(**server) -> dict:
    meta = server.pop("_official", {})
    return {
        "server": server,
        "_meta": {"io.modelcontextprotocol.registry/official": meta},
    }


# ------------------------------------------------------------ real fixtures
def test_real_page_parses_with_nothing_skipped():
    page = parse_page(_fixture("page_basic"))
    assert len(page.servers) == 5
    assert page.skipped == 0
    assert page.next_cursor


def test_a_real_multi_version_server_yields_one_row_per_version():
    """A single page carries EVERY version of a server — three of
    ac.inference.sh/mcp in the captured page — which is why the server upsert
    must not let a non-latest row blank `latest_version`."""
    page = parse_page(_fixture("page_basic"))
    names = [v.server_name for v in page.versions]
    assert names.count("ac.inference.sh/mcp") >= 2
    versions = {
        v.version for v in page.versions if v.server_name == "ac.inference.sh/mcp"
    }
    assert len(versions) >= 2


def test_a_real_tombstone_is_parsed_not_dropped():
    """The registry sends deletions on every incremental page. Dropping them
    would leave a deleted server connectable forever."""
    page = parse_page(_fixture("page_deleted"))
    deleted = [v for v in page.versions if v.status == "deleted"]
    assert deleted, "fixture should contain real tombstones"
    assert all(v.raw for v in deleted), "tombstones keep their upstream payload"


def test_a_real_package_server_derives_stdio_and_a_declared_secret():
    page = parse_page(_fixture("page_packages"))
    pkg = [v for v in page.versions if v.packages]
    assert pkg, "fixture should contain package servers"
    v = pkg[0]
    assert "stdio" in v.transports
    # The GCS server declares isSecret env vars, so auth is DECLARED, not guessed.
    assert v.auth_kind == "api_key"


def test_remote_servers_derive_their_transport():
    page = parse_page(_fixture("page_basic"))
    remote = [v for v in page.versions if v.remotes]
    assert remote
    assert "streamable-http" in remote[0].transports


def test_publisher_is_the_reverse_dns_namespace():
    page = parse_page(_fixture("page_basic"))
    by_name = {s.name: s for s in page.servers}
    srv = by_name["ac.inference.sh/mcp"]
    assert srv.publisher == "ac.inference.sh"


def test_upstream_payload_is_preserved_verbatim():
    """We are not the publisher. `raw` must survive untouched so provenance is
    answerable and a changed derivation can be recomputed without a re-sync."""
    payload = _fixture("page_basic")
    page = parse_page(payload)
    original = payload["servers"][0]["server"]
    assert page.versions[0].raw == original


# ------------------------------------------------------- identity & versions
def test_two_versions_of_one_server_are_distinct_rows():
    a = parse_entry(_entry(name="x/y", version="1.0.0", _official={"isLatest": False}))
    b = parse_entry(_entry(name="x/y", version="2.0.0", _official={"isLatest": True}))
    assert a and b
    assert (a[1].server_name, a[1].version) != (b[1].server_name, b[1].version)
    assert b[0].latest_version == "2.0.0"
    # A non-latest row supplies NO latest_version, so the store must COALESCE
    # rather than overwrite — otherwise page ordering decides the field.
    assert a[0].latest_version is None


def test_two_servers_sharing_a_version_string_do_not_collide():
    a = parse_entry(_entry(name="pub.a/srv", version="1.0.0"))
    b = parse_entry(_entry(name="pub.b/srv", version="1.0.0"))
    assert a and b and a[1].server_name != b[1].server_name


# -------------------------------------------------------------- robustness
def test_a_record_without_name_or_version_is_skipped_not_fatal():
    page = parse_page(
        {
            "servers": [
                _entry(name="ok/x", version="1.0.0"),
                _entry(name="", version="1"),
            ]
        }
    )
    assert len(page.servers) == 1 and page.skipped == 1


def test_non_dict_entries_are_skipped():
    page = parse_page({"servers": ["nonsense", 42, None]})
    assert page.servers == [] and page.skipped == 3


def test_a_malformed_timestamp_does_not_lose_the_record():
    got = parse_entry(
        _entry(name="x/y", version="1", _official={"updatedAt": "not-a-date"})
    )
    assert got is not None and got[1].upstream_updated_at is None


def test_control_characters_are_stripped_from_untrusted_text():
    """Registry descriptions are published by strangers. A crafted string must
    not be able to forge log structure or carry terminal escapes."""
    got = parse_entry(
        _entry(name="x/y", version="1", description="hello\x00\x1b[31mworld\x07")
    )
    assert got is not None
    assert "\x00" not in got[0].description and "\x07" not in got[0].description


def test_oversized_text_is_bounded():
    got = parse_entry(_entry(name="x/y", version="1", description="A" * 50_000))
    assert got is not None and len(got[0].description) <= 8_000


def test_an_unknown_status_falls_back_to_active_rather_than_propagating():
    got = parse_entry(_entry(name="x/y", version="1", _official={"status": "???"}))
    assert got is not None and got[1].status == "active"


def test_unknown_upstream_fields_are_ignored_not_fatal():
    got = parse_entry(_entry(name="x/y", version="1", somethingNew={"a": 1}))
    assert got is not None
    assert got[1].raw["somethingNew"] == {"a": 1}  # preserved in raw


# ------------------------------------------------------------- auth honesty
def test_auth_is_unknown_when_the_registry_says_nothing():
    """An honest "unknown" beats a confident guess: Phase 4 picks a credential
    flow from this, and a wrong guess sends a user down an OAuth flow the
    server does not speak."""
    got = parse_entry(
        _entry(name="x/y", version="1", remotes=[{"type": "sse", "url": "u"}])
    )
    assert got is not None and got[1].auth_kind == "unknown"


def test_a_bearer_header_is_reported_as_bearer_not_oauth():
    got = parse_entry(
        _entry(
            name="x/y",
            version="1",
            remotes=[
                {
                    "type": "streamable-http",
                    "url": "u",
                    "headers": [
                        {
                            "name": "Authorization",
                            "value": "Bearer {k}",
                            "isSecret": True,
                        }
                    ],
                }
            ],
        )
    )
    # A static bearer token is NOT an OAuth flow. Calling it oauth would be
    # exactly the inference the parser refuses to make.
    assert got is not None and got[1].auth_kind == "bearer"


def test_a_package_with_no_secrets_is_confidently_unauthenticated():
    got = parse_entry(
        _entry(
            name="x/y",
            version="1",
            packages=[
                {
                    "registryType": "npm",
                    "identifier": "p",
                    "transport": {"type": "stdio"},
                }
            ],
        )
    )
    assert got is not None and got[1].auth_kind == "none"


def test_oldest_updated_at_is_tracked_for_the_ignored_filter_detector():
    old = datetime(2020, 1, 1, tzinfo=UTC).isoformat()
    new = datetime(2026, 1, 1, tzinfo=UTC).isoformat()
    page = parse_page(
        {
            "servers": [
                _entry(name="a/x", version="1", _official={"updatedAt": new}),
                _entry(name="b/x", version="1", _official={"updatedAt": old}),
            ]
        }
    )
    assert page.oldest_updated_at == datetime(2020, 1, 1, tzinfo=UTC)
