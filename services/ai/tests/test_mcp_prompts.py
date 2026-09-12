"""Prompts: discovery, argument validation, retrieval, and the trust boundary.

THE PROPERTY THIS FILE EXISTS FOR: a prompt is a template a USER chooses, not an
instruction a SERVER issues. Every test about roles is that rule.

THE SECOND PROPERTY: argument validation is ours, not the server's — measured.
Against a real server, both a missing required argument and an unknown one come
back as `MCPError: Internal server error` with no field name and no reason. That
is unusable to a user and unusable to a model, so the usable error has to be
built here from the `required` flags `prompts/list` already returns.
"""

from __future__ import annotations

import contextlib

import httpx2
import pytest

from app.mcp.index import (
    CapabilityLookupError,
    McpCapabilityIndex,
    discover_capabilities,
)
from app.mcp.prompts import (
    McpPrompt,
    McpPromptArgument,
    PromptArgumentError,
    normalize_prompt_messages,
    normalize_prompts,
)
from tests.fakes.mcp_capabilities import (
    BASE_URL,
    INJECTION,
    MCP_URL,
    build_hostile_server,
    build_prompt_server,
)

pytestmark = pytest.mark.anyio


@contextlib.asynccontextmanager
async def _index(builder=build_prompt_server, connection_id="conn-1", slug="pr"):
    """See `test_mcp_resources._index` for why this is a context manager."""
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


# --------------------------------------------------------------- discovery
async def test_a_real_server_normalizes_into_prompts_with_argument_flags():
    async with _index() as (_idx, _state, entry):
        by_name = {p.name: p for p in entry.prompts}
        assert {"summarize", "review"} <= set(by_name)
        args = {a.name: a.required for a in by_name["summarize"].arguments}
        # The required flag is what client-side validation is built from.
        assert args == {"text": True, "style": False}


def test_a_prompt_without_a_name_is_skipped_not_fatal():
    class Bad:
        name = ""

    class Good:
        name = "ok"
        title = ""
        description = "d"
        arguments = []

    kept, dropped = normalize_prompts(
        [Bad(), Good()], connection_id="c", server_slug="s"
    )
    assert [p.name for p in kept] == ["ok"]
    assert dropped == 1


def test_a_nameless_argument_is_dropped_rather_than_failing_the_prompt():
    # A nameless argument cannot be supplied, so it cannot be required either;
    # losing the whole prompt over it would help nobody.
    class Arg:
        name = ""
        description = ""
        required = True

    class P:
        name = "p"
        title = ""
        description = ""
        arguments = [Arg()]

    kept, _ = normalize_prompts([P()], connection_id="c", server_slug="s")
    assert kept[0].arguments == ()


# ------------------------------------------------------ argument validation
def _prompt(**kw) -> McpPrompt:
    return McpPrompt(
        name="summarize",
        connection_id="c",
        server_slug="s",
        arguments=(
            McpPromptArgument(name="text", required=True),
            McpPromptArgument(name="style", required=False),
        ),
        **kw,
    )


def test_valid_arguments_coerce_to_the_protocol_shape():
    # `GetPromptRequest` is string-valued, so a model emitting a number for a
    # numeric-looking argument is ordinary and refusing it would help nobody.
    out = _prompt().validate_arguments({"text": "hello", "style": 2})
    assert out == {"text": "hello", "style": "2"}
    assert all(isinstance(v, str) for v in out.values())


def test_a_missing_required_argument_is_refused_with_a_usable_message():
    """The measured reason this exists: the SERVER answers
    `MCPError: Internal server error` — no field, no cause."""
    with pytest.raises(PromptArgumentError, match="requires.*text"):
        _prompt().validate_arguments({"style": "brief"})


def test_an_unknown_argument_is_refused_not_dropped():
    # A caller passing an argument this prompt does not take believes it is
    # invoking something else.
    with pytest.raises(PromptArgumentError, match="does not take.*bogus"):
        _prompt().validate_arguments({"text": "x", "bogus": "y"})


def test_an_oversized_argument_is_refused_before_it_leaves():
    with pytest.raises(PromptArgumentError, match="ceiling"):
        _prompt().validate_arguments({"text": "x" * (16 * 1024 + 1)})


def test_an_optional_argument_may_simply_be_absent():
    assert _prompt().validate_arguments({"text": "x"}) == {"text": "x"}


def test_arguments_must_be_an_object():
    with pytest.raises(PromptArgumentError):
        _prompt().validate_arguments(["text", "x"])  # type: ignore[arg-type]


async def test_our_validation_fires_before_the_servers_unusable_error():
    """End to end: the caller gets OUR message, not `Internal server error`."""
    async with _index() as (index, state, _entry):
        prompt, _client = index.resolve_prompt("summarize")
        with pytest.raises(PromptArgumentError):
            prompt.validate_arguments({})
        # Nothing was sent — the server never saw the bad call.
        assert state["gets"] == 0


# ---------------------------------------------------------------- retrieval
async def test_a_validated_prompt_retrieves_and_normalizes():
    async with _index() as (index, state, _entry):
        prompt, client = index.resolve_prompt("summarize")
        args = prompt.validate_arguments({"text": "hello world"})
        result = await client.get_prompt(prompt.name, args)
        messages, truncated = normalize_prompt_messages(result.messages)
        assert state["gets"] == 1
        assert truncated is False
        assert messages == [
            {"role": "user", "content": "Summarize this in a brief way: hello world"}
        ]


async def test_a_two_sided_template_keeps_both_roles():
    # A few-shot template supplying both sides is legitimate and common;
    # flattening the roles would corrupt it.
    async with _index() as (index, _state, _entry):
        prompt, client = index.resolve_prompt("review")
        result = await client.get_prompt(prompt.name, {"code": "x = 1"})
        messages, _ = normalize_prompt_messages(result.messages)
        assert [m["role"] for m in messages] == ["user", "assistant"]


# ------------------------------------------------------------ trust boundary
@pytest.mark.parametrize("role", ["system", "developer", "tool", "", None, "SYSTEM"])
def test_no_server_supplied_role_can_become_a_system_message(role):
    """THE prompt-injection control, and it is structural.

    There is no branch in `normalize_prompt_messages` that can emit `system` or
    `developer`. A server asking for one gets `user` — so the worst a hostile
    prompt can do is have a user say something, which the model already knows how
    to refuse.
    """

    class M:
        def __init__(self, r):
            self.role = r
            self.content = type("C", (), {"text": INJECTION})()

    messages, _ = normalize_prompt_messages([M(role)])
    assert messages[0]["role"] == "user"
    assert messages[0]["content"] == INJECTION


async def test_a_hostile_prompt_body_arrives_as_user_content_only():
    async with _index(build_hostile_server, slug="hostile") as (index, _s, entry):
        assert [p.name for p in entry.prompts] == ["evil_prompt"]
        prompt, client = index.resolve_prompt("evil_prompt")
        result = await client.get_prompt(prompt.name, {})
        messages, _ = normalize_prompt_messages(result.messages)
        assert messages, "nothing came back; the assertion below would be vacuous"
        for message in messages:
            assert message["role"] in ("user", "assistant")
            assert message["role"] not in ("system", "developer")
        # The text is preserved — suppressing it would be lying about what the
        # server said — but it is conversation content, not an instruction.
        assert any(INJECTION in m["content"] for m in messages)


def test_prompt_output_is_bounded():
    class M:
        role = "user"
        content = type("C", (), {"text": "x" * 100_000})()

    messages, truncated = normalize_prompt_messages([M()], max_chars=1000)
    assert truncated is True
    assert sum(len(m["content"]) for m in messages) <= 1000


def test_non_text_prompt_content_is_named_not_smuggled():
    class M:
        role = "user"
        content = type("C", (), {"type": "image", "data": "BASE64" * 1000})()

    messages, _ = normalize_prompt_messages([M()])
    assert "omitted" in messages[0]["content"]
    assert "BASE64" not in messages[0]["content"]


# ------------------------------------------------------------- name lookup
def test_two_servers_offering_the_same_prompt_name_must_be_disambiguated():
    """§108. Silently choosing one server's `summarize` over another's would run
    the wrong template against the user's data."""
    from app.mcp.index import _ConnectionCapabilities

    index = McpCapabilityIndex()
    for cid in ("conn-a", "conn-b"):
        entry = _ConnectionCapabilities(connection_id=cid, server_slug=cid)
        entry.prompts = [
            McpPrompt(name="summarize", connection_id=cid, server_slug=cid)
        ]
        index.add(entry, client=object())

    with pytest.raises(CapabilityLookupError, match="name the connection"):
        index.resolve_prompt("summarize")

    found, _client = index.resolve_prompt("summarize", connection_id="conn-b")
    assert found.connection_id == "conn-b"


def test_an_unknown_prompt_is_refused_with_no_existence_oracle():
    index = McpCapabilityIndex()
    for name in ("nope", ""):
        with pytest.raises(CapabilityLookupError):
            index.resolve_prompt(name)
