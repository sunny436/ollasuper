"""Compatibility: what Phase 3 refuses to dial, decided without a network.

PURE, and that is the security property rather than a convenience. The brief
requires a stdio-only or packages-only server to be refused WITHOUT a connection
attempt, and the only way to guarantee that is for the decision to live in a
module that has no transport and cannot dial anything. These tests would still
pass with the network unplugged and the MCP SDK uninstalled.

MEASURED CONTEXT for why this matters: a full registry sync counted 100,198
version records -- stdio 68,019, streamable-http 41,155, sse 2,631. Most of the
ecosystem is local-only, so "no usable remote" is the COMMON path, not an edge
case, and it deserves a real answer rather than a timeout.
"""

from __future__ import annotations

import pytest

from app.mcp.compat import assess, select_remote

HTTP = {"type": "streamable-http", "url": "https://a.test/mcp"}
SSE = {"type": "sse", "url": "https://a.test/sse"}
NPM = {"registryType": "npm", "identifier": "some-pkg", "transport": {"type": "stdio"}}


# --------------------------------------------------- deterministic selection
def test_streamable_http_is_preferred_over_sse_regardless_of_order():
    """Deterministic means deterministic: picking "the first one" is only stable
    if the registry's ordering is, and it is not ours to rely on."""
    assert select_remote([SSE, HTTP]) == ("streamable-http", HTTP["url"])
    assert select_remote([HTTP, SSE]) == ("streamable-http", HTTP["url"])


def test_sse_is_chosen_when_it_is_the_only_remote():
    assert select_remote([SSE]) == ("sse", SSE["url"])


def test_ties_break_on_the_registrys_own_order():
    first = {"type": "streamable-http", "url": "https://one.test/mcp"}
    second = {"type": "streamable-http", "url": "https://two.test/mcp"}
    assert select_remote([first, second]) == ("streamable-http", first["url"])
    assert select_remote([second, first]) == ("streamable-http", second["url"])


def test_selection_is_stable_across_repeated_calls():
    remotes = [SSE, HTTP, {"type": "sse", "url": "https://b.test/sse"}]
    assert len({select_remote(remotes) for _ in range(20)}) == 1


@pytest.mark.parametrize(
    "spelling", ["streamable-http", "streamable_http", "streamablehttp", "HTTP"]
)
def test_known_registry_spellings_all_resolve(spelling):
    """A record written before a rename must not read as "no usable remote"."""
    got = select_remote([{"type": spelling, "url": "https://a.test/mcp"}])
    assert got == ("streamable-http", "https://a.test/mcp")


def test_stdio_is_never_selected():
    assert select_remote([{"type": "stdio", "url": "x"}]) is None


def test_an_unknown_future_transport_is_skipped_not_guessed():
    assert select_remote([{"type": "quic-mcp", "url": "https://a.test"}]) is None


def test_one_malformed_entry_does_not_hide_a_good_one():
    remotes = [{"nonsense": True}, None, "string", HTTP]
    assert select_remote(remotes) == ("streamable-http", HTTP["url"])


def test_an_entry_without_a_url_is_skipped():
    assert select_remote([{"type": "streamable-http"}, HTTP]) == (
        "streamable-http",
        HTTP["url"],
    )
    assert select_remote([{"type": "streamable-http", "url": "   "}]) is None


def test_a_non_list_remotes_field_is_survivable():
    assert select_remote(None) is None
    assert select_remote({"type": "streamable-http"}) is None
    assert select_remote("https://a.test") is None


# ---------------------------------------------------------------- verdicts
def test_a_remote_no_auth_server_is_connectable():
    verdict = assess({"remotes": [HTTP], "auth_kind": "none"})
    assert verdict.ok
    assert verdict.transport == "streamable-http"
    assert verdict.endpoint_url == HTTP["url"]


def test_a_packages_only_server_is_refused_by_name():
    """The single most common case in the catalogue. Saying so plainly beats a
    connection timeout."""
    verdict = assess({"remotes": [], "packages": [NPM], "auth_kind": "none"})
    assert not verdict.ok
    assert not verdict.auth_required
    assert "local execution is not supported" in verdict.reason


def test_a_server_with_neither_remotes_nor_packages_is_refused():
    verdict = assess({"remotes": [], "packages": [], "auth_kind": "none"})
    assert not verdict.ok
    assert "no remote endpoint" in verdict.reason


def test_a_stdio_only_server_reads_as_having_no_remote():
    verdict = assess(
        {"remotes": [{"type": "stdio", "url": "x"}], "packages": [NPM]}
    )
    assert not verdict.ok
    assert "local execution is not supported" in verdict.reason


@pytest.mark.parametrize("auth_kind", ["oauth", "api_key", "bearer", "unknown"])
def test_every_auth_kind_but_none_needs_a_credential(auth_kind):
    """`unknown` is NOT optimistically treated as `none`. Phase 2's parser
    refuses to guess auth, and guessing here would undo that: an
    unauthenticated attempt against a server that needs credentials yields a
    confusing 401 instead of a clear instruction."""
    verdict = assess({"remotes": [HTTP], "auth_kind": auth_kind})
    assert not verdict.ok
    assert verdict.auth_required
    assert auth_kind in verdict.reason


@pytest.mark.parametrize("auth_kind", ["oauth", "api_key", "bearer", "unknown"])
def test_a_credential_makes_the_same_server_connectable(auth_kind):
    """The Phase 4 handoff in one assertion: only the credential changes."""
    verdict = assess(
        {"remotes": [HTTP], "auth_kind": auth_kind}, credentials_available=True
    )
    assert verdict.ok
    assert verdict.endpoint_url == HTTP["url"]


def test_auth_required_still_reports_the_endpoint_it_would_have_used():
    """So a UI can say "connect your GitHub account to reach api.github.com"
    rather than "something is wrong"."""
    verdict = assess({"remotes": [HTTP], "auth_kind": "oauth"})
    assert verdict.auth_required
    assert verdict.endpoint_url == HTTP["url"]
    assert verdict.transport == "streamable-http"


def test_auth_is_checked_only_after_a_usable_remote_is_found():
    """A packages-only server needs a clearer answer than "you need
    credentials" -- credentials would not help."""
    verdict = assess({"remotes": [], "packages": [NPM], "auth_kind": "oauth"})
    assert not verdict.auth_required
    assert "local execution" in verdict.reason


def test_a_missing_auth_kind_defaults_to_unknown_not_to_none():
    verdict = assess({"remotes": [HTTP]})
    assert verdict.auth_kind == "unknown"
    assert verdict.auth_required


def test_a_garbage_row_does_not_raise():
    """The row ultimately comes from a stranger's registry publication."""
    for row in (None, "nonsense", 42, [], {"remotes": "no"}):
        verdict = assess(row)
        assert not verdict.ok


def test_the_module_imports_no_transport_and_no_network_client():
    """Structural: a module that could dial could not guarantee "refused
    without a connection attempt"."""
    import ast
    import pathlib

    tree = ast.parse(pathlib.Path("app/mcp/compat.py").read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add((node.module or "").split(".")[0])
    assert not imported & {"httpx", "httpx2", "mcp", "socket", "asyncio"}
