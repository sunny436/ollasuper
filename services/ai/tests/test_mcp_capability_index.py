"""The capability index: collisions, isolation, staleness, and the refusals.

WHAT THIS FILE IS ABOUT. `resolve_resource` and `resolve_prompt` are the two
authorization gates for everything that is not a tool. A URI or a prompt name
arrives from the model or from a route, and the ONLY thing that makes acting on
it safe is that it must match something this turn discovered for this user.

So every test here is one of three shapes:
  * two servers offering the same thing stay distinguishable (§107/§108);
  * one user's index cannot reach another user's connection (§111/§112);
  * something that was never discovered is refused, with no oracle (§105).

These are pure — no server, no network. The live paths are covered in
`test_mcp_resources.py` and `test_mcp_prompts.py`; this is where the rules
themselves are pinned, so a refactor that breaks one fails here rather than in a
test that also needs a server to be running.
"""

from __future__ import annotations

import pytest

from app.mcp.index import (
    CapabilityLookupError,
    McpCapabilityIndex,
    _ConnectionCapabilities,
)
from app.mcp.prompts import McpPrompt
from app.mcp.resources import McpResource, McpResourceTemplate


def _entry(
    connection_id: str,
    *,
    uris: tuple[str, ...] = (),
    templates: tuple[str, ...] = (),
    prompts: tuple[str, ...] = (),
) -> _ConnectionCapabilities:
    entry = _ConnectionCapabilities(
        connection_id=connection_id, server_slug=connection_id
    )
    entry.resources = [
        McpResource(
            uri=u, name=u, connection_id=connection_id, server_slug=connection_id
        )
        for u in uris
    ]
    entry.templates = [
        McpResourceTemplate(
            uri_template=t,
            name=t,
            connection_id=connection_id,
            server_slug=connection_id,
            variables=tuple(
                part[1:-1]
                for part in t.replace("/", " ").split()
                if part.startswith("{") and part.endswith("}")
            ),
        )
        for t in templates
    ]
    entry.prompts = [
        McpPrompt(name=p, connection_id=connection_id, server_slug=connection_id)
        for p in prompts
    ]
    return entry


class _Client:
    def __init__(self, tag: str) -> None:
        self.tag = tag


# ------------------------------------------------------------- collisions
def test_two_servers_offering_the_same_uri_stay_distinct():
    """§107. Identity is `(connection, uri)`, never the bare URI.

    Two Notion-like servers both exposing `mem://notes` is ordinary; resolving
    to whichever was added last would read one account's data for another's.
    """
    index = McpCapabilityIndex()
    index.add(_entry("conn-a", uris=("mem://notes",)), client=_Client("a"))
    index.add(_entry("conn-b", uris=("mem://notes",)), client=_Client("b"))

    assert len(index.resources()) == 2
    assert {r.connection_id for r in index.resources()} == {"conn-a", "conn-b"}
    # Both entries survive: neither displaced the other in the index.
    assert len(index.resources("conn-a")) == 1
    assert len(index.resources("conn-b")) == 1


def test_two_servers_offering_the_same_prompt_name_must_be_disambiguated():
    """§108. Running the wrong server's `summarize` over the user's data is a
    silent, plausible-looking failure — so it is an error, not a coin flip."""
    index = McpCapabilityIndex()
    index.add(_entry("conn-a", prompts=("summarize",)), client=_Client("a"))
    index.add(_entry("conn-b", prompts=("summarize",)), client=_Client("b"))

    with pytest.raises(CapabilityLookupError, match="name the connection"):
        index.resolve_prompt("summarize")

    found, client = index.resolve_prompt("summarize", connection_id="conn-b")
    assert found.connection_id == "conn-b"
    assert client.tag == "b"


def test_a_unique_prompt_name_needs_no_disambiguation():
    index = McpCapabilityIndex()
    index.add(_entry("conn-a", prompts=("only_here",)), client=_Client("a"))
    found, _client = index.resolve_prompt("only_here")
    assert found.connection_id == "conn-a"


# --------------------------------------------------------------- isolation
def test_a_resource_resolves_to_the_client_it_was_discovered_on():
    """The read must go back to the session the metadata came from.

    Sending user A's URI to user B's session would be a cross-tenant read that
    every ownership check upstream would have passed.
    """
    index = McpCapabilityIndex()
    index.add(_entry("conn-a", uris=("mem://a",)), client=_Client("a"))
    index.add(_entry("conn-b", uris=("mem://b",)), client=_Client("b"))

    _resource, client = index.resolve_resource("mem://a")
    assert client.tag == "a"
    _resource, client = index.resolve_resource("mem://b")
    assert client.tag == "b"


def test_an_index_built_for_one_user_cannot_reach_anothers_connection():
    """§111. The index IS the tenant boundary for resources and prompts.

    A's index is built only from A's sessions, so B's URI is simply not in it —
    there is no lookup that could find it and no fallback that could guess.
    """
    a = McpCapabilityIndex()
    a.add(_entry("conn-a", uris=("mem://a",), prompts=("p_a",)), client=_Client("a"))

    for uri in ("mem://b", "mem://notes", "file:///etc/passwd"):
        with pytest.raises(CapabilityLookupError):
            a.resolve_resource(uri)
    with pytest.raises(CapabilityLookupError):
        a.resolve_prompt("p_b")


def test_a_connection_with_no_client_is_refused_not_half_resolved():
    # Metadata without a live session is unusable; returning the resource with a
    # None client would push the failure into the read path, where it would look
    # like a server error rather than a missing session.
    index = McpCapabilityIndex()
    index.add(_entry("conn-a", uris=("mem://a",)))  # no client
    with pytest.raises(CapabilityLookupError):
        index.resolve_resource("mem://a")


# ------------------------------------------------------- template matching
@pytest.mark.parametrize(
    ("uri", "ok"),
    [
        ("mem://repo/main/README.md", True),
        ("mem://repo/v2/a.txt", True),
        ("mem://repo/main/deep/nested", False),
        ("mem://repo/main", False),
        ("mem://repo//x", False),
        ("mem://other/main/a", False),
        ("mem://repo/main/README.md/extra", False),
    ],
    ids=[
        "simple",
        "other-branch",
        "too-deep",
        "too-short",
        "empty-var",
        "wrong-prefix",
        "trailing",
    ],
)
def test_template_matching_is_segment_exact(uri, ok):
    """A variable matches ONE segment, never a path.

    A `{branch}` that could swallow `/` would let one advertised template
    authorize URIs its author never offered — which is the whole risk of
    accepting templated reads at all.
    """
    index = McpCapabilityIndex()
    index.add(
        _entry("conn-a", templates=("mem://repo/{branch}/{path}",)),
        client=_Client("a"),
    )
    if ok:
        resource, client = index.resolve_resource(uri)
        assert resource.uri == uri
        assert client.tag == "a"
    else:
        with pytest.raises(CapabilityLookupError):
            index.resolve_resource(uri)


def test_an_exact_resource_wins_over_a_template():
    # A server advertising both should serve the specific one; otherwise a
    # template could shadow a resource with different content.
    index = McpCapabilityIndex()
    entry = _entry(
        "conn-a",
        uris=("mem://repo/main/README.md",),
        templates=("mem://repo/{branch}/{path}",),
    )
    index.add(entry, client=_Client("a"))
    resource, _client = index.resolve_resource("mem://repo/main/README.md")
    assert resource.name == "mem://repo/main/README.md"


# ------------------------------------------------------------ bind gating
def test_the_resource_tool_binds_only_when_something_advertises_resources():
    """A user with no resource-bearing server never sees `mcp_read_resource`,
    so it costs nothing in the context budget of turns that could not use it."""
    empty = McpCapabilityIndex()
    assert empty.has_resources is False
    assert empty.has_prompts is False

    with_prompts = McpCapabilityIndex()
    with_prompts.add(_entry("c", prompts=("p",)), client=_Client("c"))
    # Prompts alone must NOT bind the resource tool.
    assert with_prompts.has_resources is False
    assert with_prompts.has_prompts is True

    with_templates = McpCapabilityIndex()
    with_templates.add(_entry("c", templates=("mem://{x}",)), client=_Client("c"))
    # A template counts: it is readable once filled.
    assert with_templates.has_resources is True


# -------------------------------------------------------------- no oracle
@pytest.mark.parametrize("uri", ["", "   ", "mem://nope", "not-a-uri"])
def test_every_unmatched_uri_gets_the_same_shape_of_refusal(uri):
    """A distinguishable answer would let a caller probe for other people's
    resource URIs one guess at a time."""
    index = McpCapabilityIndex()
    index.add(_entry("conn-a", uris=("mem://a",)), client=_Client("a"))
    with pytest.raises(CapabilityLookupError) as caught:
        index.resolve_resource(uri)
    assert "not available" in str(caught.value) or "no resource uri" in str(
        caught.value
    )


def test_the_safe_projection_carries_no_client_and_no_session():
    index = McpCapabilityIndex()
    index.add(
        _entry("conn-a", uris=("mem://a",), prompts=("p",)), client=_Client("secret")
    )
    blob = str(index.as_dict())
    assert "secret" not in blob
    assert "_Client" not in blob
    # It is still useful: counts and per-connection errors survive.
    assert "conn-a" in blob
    assert index.as_dict()["connections"][0]["resources"] == 1


# ------------------------------------------------ M-04: ambiguity is refused
def test_an_ambiguous_uri_is_refused_until_a_connector_is_named():
    """Audit M-04. The first exact match used to win, so a read of a URI two
    connections both offer landed on whichever was added first — the wrong
    account's copy, silently. Now: ambiguity refuses and names the choice; a
    named connector resolves exactly that one; a wrong name is 'not available'."""
    from app.mcp.index import CapabilityLookupError

    index = McpCapabilityIndex()
    index.add(_entry("conn-a", uris=("mem://notes",)), client=_Client("a"))
    index.add(_entry("conn-b", uris=("mem://notes",)), client=_Client("b"))

    with pytest.raises(
        CapabilityLookupError, match="name the connector: conn-a, conn-b"
    ):
        index.resolve_resource("mem://notes")
    resource, client = index.resolve_resource("mem://notes", connector="conn-b")
    assert resource.connection_id == "conn-b" and client.tag == "b"
    with pytest.raises(CapabilityLookupError, match="not available"):
        index.resolve_resource("mem://notes", connector="conn-z")
    # A URI only one connection offers needs no name.
    index.add(_entry("conn-c", uris=("mem://only-c",)), client=_Client("c"))
    assert index.resolve_resource("mem://only-c")[0].connection_id == "conn-c"


def test_ambiguous_templates_are_refused_too():
    from app.mcp.index import CapabilityLookupError

    index = McpCapabilityIndex()
    index.add(_entry("conn-a", templates=("mem://repo/{branch}",)), client=_Client("a"))
    index.add(_entry("conn-b", templates=("mem://repo/{branch}",)), client=_Client("b"))
    with pytest.raises(CapabilityLookupError, match="name the connector"):
        index.resolve_resource("mem://repo/main")
    resource, client = index.resolve_resource("mem://repo/main", connector="conn-a")
    assert resource.connection_id == "conn-a" and client.tag == "a"
