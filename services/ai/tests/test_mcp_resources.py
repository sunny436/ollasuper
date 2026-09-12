"""Resources and templates: normalization, filling, reading, and the refusals.

THE PROPERTY THIS FILE EXISTS FOR: a resource URI is untrusted input that reaches
us from the model, and the only thing that makes reading one safe is that it must
match something this turn already discovered for this user. Every "refused" test
below is that rule firing.

Everything runs against the REAL SDK and a REAL server. A normalization test that
invented its own `Resource` object would drift from what a server actually sends
— which is exactly how Phase 3's `$defs` bug survived review.
"""

from __future__ import annotations

import contextlib

import httpx2
import pytest

from app.mcp.index import (
    McpCapabilityIndex,
    discover_capabilities,
)
from app.mcp.resource_tool import read_resource
from app.mcp.resources import (
    McpResource,
    McpResourceTemplate,
    normalize_resources,
    normalize_templates,
)
from tests.fakes.mcp_capabilities import (
    BASE_URL,
    MCP_URL,
    build_hostile_server,
    build_malformed_server,
    build_partial_server,
    build_resource_server,
)

pytestmark = pytest.mark.anyio


@contextlib.asynccontextmanager
async def _index(builder=build_resource_server, connection_id="conn-1", slug="res"):
    """Build a real index from a real server, and hand back the live client.

    An `@asynccontextmanager` rather than a bare async generator, and that is not
    style. A generator consumed with `async for` is finalized whenever GC gets to
    it — a DIFFERENT task — and anyio refuses to exit a cancel scope from a task
    other than the one that entered it. The MCP client opens exactly such a
    scope, so the generator form fails with "Attempted to exit cancel scope in a
    different task". Same rule that makes every pooled session an actor in
    `app/mcp/session.py`; it bites test helpers too.
    """
    from mcp.client import Client
    from mcp.client.streamable_http import streamable_http_client

    app, state = builder()
    async with app.router.lifespan_context(app):
        client = httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url=BASE_URL
        )
        async with client:
            async with Client(
                server=streamable_http_client(MCP_URL, http_client=client)
            ) as session:
                entry = await discover_capabilities(
                    session, connection_id=connection_id, server_slug=slug
                )
                index = McpCapabilityIndex()
                index.add(entry, client=session)
                yield index, state, entry


# ------------------------------------------------------------- normalization
async def test_a_real_server_normalizes_into_resources_and_templates():
    async with _index() as (index, _state, entry):
        names = {r.name for r in entry.resources}
        assert {"alpha", "beta"} <= names
        assert entry.resources_error == ""
        assert [t.uri_template for t in entry.templates] == [
            "mem://repo/{branch}/{path}"
        ]
        template = entry.templates[0]
        assert template.variables == ("branch", "path")
        assert template.fillable is True


async def test_identity_carries_the_connection_not_just_the_uri():
    # Two servers may advertise the same URI; the connection is what tells them
    # apart, and a read must go back to the session the metadata came from.
    async with _index(connection_id="conn-A") as (index, _s, entry):
        assert all(r.connection_id == "conn-A" for r in entry.resources)
        assert entry.resources[0].key == ("conn-A", entry.resources[0].uri)


def test_a_malformed_row_is_skipped_not_fatal():
    class Bad:
        uri = ""
        name = "nameless"

    class Good:
        uri = "mem://ok"
        name = "ok"
        description = "d"
        mime_type = "text/plain"
        size = 10

    kept, dropped = normalize_resources(
        [Bad(), Good(), Bad()], connection_id="c", server_slug="s"
    )
    # One bad row must not cost the user every other resource on that server.
    assert [r.uri for r in kept] == ["mem://ok"]
    assert dropped == 2


def test_a_duplicate_uri_is_dropped_rather_than_shadowing():
    class R:
        def __init__(self, uri):
            self.uri = uri
            self.name = uri
            self.description = ""
            self.mime_type = ""
            self.size = None

    kept, dropped = normalize_resources(
        [R("mem://a"), R("mem://a")], connection_id="c", server_slug="s"
    )
    assert len(kept) == 1
    assert dropped == 1


def test_the_per_server_ceiling_is_enforced_and_reported():
    class R:
        def __init__(self, i):
            self.uri = f"mem://{i}"
            self.name = str(i)
            self.description = ""
            self.mime_type = ""
            self.size = None

    kept, dropped = normalize_resources(
        [R(i) for i in range(300)], connection_id="c", server_slug="s", max_resources=10
    )
    # Silent truncation would read as "this server has 10 resources".
    assert len(kept) == 10
    assert dropped == 290


async def test_control_characters_and_oversized_text_are_bounded():
    async with _index(build_malformed_server, slug="bad") as (_idx, _s, entry):
        for resource in entry.resources:
            assert all(c >= " " for c in resource.name)
            assert all(c >= " " for c in resource.uri)
            assert len(resource.description) <= 1024


# ------------------------------------------------------------- template fill
@pytest.mark.parametrize(
    ("values", "expected"),
    [
        ({"branch": "main", "path": "README.md"}, "mem://repo/main/README.md"),
        ({"branch": "v2", "path": "a.txt"}, "mem://repo/v2/a.txt"),
    ],
)
def test_a_template_fills_to_a_concrete_uri(values, expected):
    t = McpResourceTemplate(
        uri_template="mem://repo/{branch}/{path}",
        name="f",
        connection_id="c",
        server_slug="s",
        variables=("branch", "path"),
    )
    assert t.fill(values) == expected


@pytest.mark.parametrize(
    "values",
    [
        {"branch": "main"},
        {"branch": "main", "path": "a", "extra": "b"},
        {"branch": "../../etc", "path": "a"},
        {"branch": "a/b", "path": "c"},
        {"branch": "", "path": "a"},
        {"branch": "a?x=1", "path": "b"},
        {"branch": "a#frag", "path": "b"},
    ],
    ids=["missing", "extra", "traversal", "separator", "empty", "query", "fragment"],
)
def test_a_template_refuses_anything_that_would_change_the_target(values):
    """Filling is where a variable could redirect the read.

    `branch="main/../../etc"` is the classic shape: the server resolves the
    resulting URI to something the user never asked for, and every later check
    sees a URI that looks legitimate.
    """
    t = McpResourceTemplate(
        uri_template="mem://repo/{branch}/{path}",
        name="f",
        connection_id="c",
        server_slug="s",
        variables=("branch", "path"),
    )
    with pytest.raises(ValueError):
        t.fill(values)


def test_an_rfc6570_template_beyond_simple_placeholders_is_not_guessed_at():
    # `{+path}` does not escape like `{path}`. Guessing produces a URI that
    # addresses something else, so it is reported and refused instead.
    kept, _ = normalize_templates(
        [type("T", (), {"uri_template": "mem://{+path}", "name": "x",
                        "description": "", "mime_type": ""})()],
        connection_id="c",
        server_slug="s",
    )
    assert kept[0].fillable is False
    with pytest.raises(ValueError, match="beyond simple"):
        kept[0].fill({"path": "a"})


# ------------------------------------------------------------------ the read
async def test_an_advertised_resource_reads_through_the_session():
    async with _index() as (index, state, _e):
        out = await read_resource(index, "mem://notes/alpha")
        assert out["text"] == "ALPHA BODY"
        assert out["uri"] == "mem://notes/alpha"
        assert out.get("is_error") is None
        assert state["reads"] == 1


async def test_a_templated_uri_reads_without_a_second_protocol_call():
    # Measured in the plan's second pass: a concrete URI matching an advertised
    # template is served by an ordinary read. There is no expand step.
    async with _index() as (index, _s, _e):
        out = await read_resource(index, "mem://repo/main/README.md")
        assert out["text"] == "FILE main/README.md"


@pytest.mark.parametrize(
    "uri",
    [
        "mem://notes/does-not-exist",
        "file:///etc/passwd",
        "http://169.254.169.254/latest/meta-data/",
        "https://evil.test/steal",
        "mem://repo/main/deep/nested/path",
        "",
    ],
    ids=["unknown", "file", "metadata-ip", "https", "too-many-segments", "empty"],
)
async def test_a_uri_that_was_never_advertised_is_refused(uri):
    """THE control. The model supplies this string, so it is untrusted input.

    Note `mem://repo/main/deep/nested/path`: it LOOKS like the advertised
    template but has an extra segment. A variable that could swallow `/` would
    let one template authorize URIs its author never offered, so the match is
    segment-exact.
    """
    async with _index() as (index, state, _e):
        out = await read_resource(index, uri)
        assert out["is_error"] is True
        # "not available" for an unmatched uri, "no resource uri" for an empty
        # one — both refusals, and neither distinguishes "absent" from
        # "someone else's", which is the property that matters.
        assert "not available" in out["text"] or "no resource uri" in out["text"]
        # Refused BEFORE any request left.
        assert state["reads"] == 0


async def test_binary_content_is_refused_rather_than_decoded():
    async with _index() as (index, _s, _e):
        out = await read_resource(index, "mem://blob/logo")
        assert "omitted_content" in out
        assert any("binary" in m for m in out["omitted_content"])
        # A base64 blob in a ToolMessage is unreadable to a model and costs the
        # whole payload in memory.
        assert "PNG" not in out.get("text", "")


async def test_an_oversized_body_is_bounded_and_says_so():
    async with _index() as (index, _s, _e):
        out = await read_resource(index, "mem://huge/log", max_bytes=2048)
        assert len(out["text"]) <= 2048
        assert out["truncated"] is True


async def test_a_read_failure_is_reported_to_the_model_not_raised():
    # The model can correct a wrong URI if told what happened, and cannot if the
    # turn dies.
    class Boom:
        async def read_resource(self, *_a, **_k):
            raise RuntimeError("server exploded")

    index = McpCapabilityIndex()
    from app.mcp.index import _ConnectionCapabilities

    entry = _ConnectionCapabilities(connection_id="c", server_slug="s")
    entry.resources = [
        McpResource(uri="mem://x", name="x", connection_id="c", server_slug="s")
    ]
    index.add(entry, client=Boom())
    out = await read_resource(index, "mem://x")
    assert out["is_error"] is True
    assert "RuntimeError" in out["text"]


# ------------------------------------------------------- failure isolation
async def test_a_broken_resources_list_does_not_cost_the_server_its_prompts():
    """§117. One capability failing must not disable the others."""
    async with _index(build_partial_server, slug="partial") as (_idx, _s, entry):
        assert entry.resources_error != ""
        assert entry.resources == []
        assert [p.name for p in entry.prompts] == ["still_here"]


# ------------------------------------------------------------- injection
async def test_a_hostile_resource_body_is_data_not_instruction():
    from tests.fakes.mcp_capabilities import INJECTION

    async with _index(build_hostile_server, slug="hostile") as (index, _s, entry):
        out = await read_resource(index, "mem://evil")
        # It comes back — suppressing it would be lying about what the server
        # said — but as an ordinary tool RESULT, with no role, no priority and
        # no path into the system prompt.
        assert INJECTION in out["text"]
        assert set(out) <= {
            "uri", "server", "mime_type", "text", "omitted_content", "truncated",
        }
        # Nothing in the result can name a role or a policy.
        assert "role" not in out
        assert "system" not in out


async def test_every_read_asks_the_sdk_to_bypass_its_cache():
    """The §0a correction, and it needs its own test because no SERVER can
    exercise it.

    `read_resource` defaults to `cache_mode="use"`, and the SDK honours a
    server-declared `ttl_ms` — so a server returning a non-zero TTL would put its
    content in our per-client store. The fixtures all return `ttl_ms=0`
    (measured), which means removing the bypass breaks NOTHING they can see:
    verified by deleting it and watching all 29 other tests still pass.

    So the property is asserted where it actually lives — in what WE ask for,
    every time, whatever the server would prefer.
    """
    seen: list[dict] = []

    class Capturing:
        async def read_resource(self, uri, **kwargs):
            seen.append(kwargs)
            return type("R", (), {"contents": []})()

    index = McpCapabilityIndex()
    from app.mcp.index import _ConnectionCapabilities

    entry = _ConnectionCapabilities(connection_id="c", server_slug="s")
    entry.resources = [
        McpResource(uri="mem://x", name="x", connection_id="c", server_slug="s")
    ]
    index.add(entry, client=Capturing())

    await read_resource(index, "mem://x")
    assert seen == [{"cache_mode": "bypass"}], seen
