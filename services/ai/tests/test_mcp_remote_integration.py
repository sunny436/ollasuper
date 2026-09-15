"""The whole chain, over a REAL Streamable HTTP session, through the REAL
OllaSuper execution machinery.

    tool call -> ToolSelector's registry -> check_tool_policy -> approval gate
              -> execute_tool_calls -> McpToolAdapter -> pooled MCP session
              -> remote server -> normalized result -> ToolMessage

Nothing here is MCP-specific below the adapter. There is no MCP policy, no MCP
retry, no MCP approval path, no MCP agent loop — if any of those existed, these
tests could not be written using the real `ToolExecContext`, the real
`DeltaWriter` and the real `check_tool_policy`.

`test_mcp_integration.py` proves the same chain over the in-process transport.
This file is what that one cannot be: a real HTTP session, a real handshake, a
real pool, and therefore the first place where argument validation, result
bounding, cancellation and cross-tenant isolation are exercised end to end.
"""

from __future__ import annotations

from contextlib import AsyncExitStack

import anyio
import httpx2
import pytest
from langchain_core.messages import ToolMessage

from app.agent.executor import ToolExecContext, build_tool_specs, execute_tool_calls
from app.agent.policy import READ_SCOPE, WRITE_SCOPE, check_tool_policy
from app.config import Settings
from app.mcp.compose import compose_tools
from app.mcp.session import McpSessionPool, PoolLimits
from app.models.tools import SideEffect, ToolCandidate, ToolDefinition
from app.runtime.writer import DeltaWriter
from app.tools.registry import ToolRegistry
from tests.fakes import mcp_http
from tests.fakes.mcp_http import build_colliding_app, build_mcp_app, running, spec
from tests.test_writer_events import RecordingConvex


@pytest.fixture
def asgi(monkeypatch):
    def _install(app):
        mcp_http.patch_transport(monkeypatch, app)

    return _install


def _ctx(composed, *, scope=READ_SCOPE, **overrides) -> ToolExecContext:
    """A REAL ToolExecContext. Every field below belongs to the existing
    executor; none of them is an MCP concept."""
    settings = Settings()
    base = {
        "registry": composed.registry,
        "adapter": None,
        # THE integration point, and the only one: provider-keyed dispatch,
        # already live for `seo_write`.
        "adapters": composed.adapters,
        "writer": DeltaWriter(RecordingConvex(), "s1", settings),
        "scope": scope,
        "name_to_tool_id": {t.tool_id: t.tool_id for t in composed.tools},
        "result_max_chars": 8000,
        "default_timeout_s": 30.0,
    }
    base.update(overrides)
    return ToolExecContext(**base)


async def _pool(stack, **limits) -> McpSessionPool:
    return await McpSessionPool(
        PoolLimits(sweep_interval_s=3600.0, **limits)
    ).start(stack)


# ---------------------------------------------------------------- the chain
async def test_a_model_tool_call_reaches_a_remote_server_and_returns_a_toolmessage(
    asgi,
):
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec()) as session:
            composed = compose_tools([session], pool=pool)
            add = next(t for t in composed.tools if t.name == "add")
            assert add.side_effect is SideEffect.READ_ONLY

            msgs = await execute_tool_calls(
                [{"name": add.tool_id, "args": {"a": 2, "b": 3}, "id": "c1"}],
                _ctx(composed),
            )

        assert len(msgs) == 1
        msg = msgs[0]
        assert isinstance(msg, ToolMessage)
        assert msg.tool_call_id == "c1"
        assert "5" in msg.content, f"computed result missing from {msg.content!r}"
        # Inherited free from the existing executor: untrusted tool output is
        # framed as DATA rather than as instructions to the model.
        assert "<tool_output>" in msg.content
        await pool.aclose()


async def test_policy_and_approval_apply_with_no_mcp_specific_code(asgi):
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec(trusted=True)) as session:
            by_name = {t.name: t for t in session.tools}
            # Trusted + explicitly read-only -> allowed under the read ceiling.
            assert check_tool_policy(by_name["echo"], READ_SCOPE).allowed
            # destructive_hint, and the spec DEFAULTS it true -> approval.
            assert check_tool_policy(by_name["write_note"], READ_SCOPE).needs_approval
            # Unannotated -> approval, because fail-safe is the default and
            # `destructive_hint` defaults TRUE in the spec.
            assert check_tool_policy(by_name["slow"], READ_SCOPE).needs_approval
            # An ELEVATED turn — what production runs — no longer gates on the
            # ceiling, so a declared write must ask on its own account; a
            # declared read flows. Measured on production before this held.
            assert check_tool_policy(by_name["write_note"], WRITE_SCOPE).needs_approval
            assert check_tool_policy(by_name["slow"], WRITE_SCOPE).needs_approval
            assert check_tool_policy(by_name["huge"], WRITE_SCOPE).allowed
        await pool.aclose()


async def test_an_untrusted_remote_server_cannot_downgrade_its_own_tools(asgi):
    """The server SAYS `readOnlyHint: true` for `echo`. MCP's own types warn
    that annotations from an untrusted server must never drive a tool-use
    decision, so an untrusted connection keeps the approval gate."""
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec(slug="sketchy", trusted=False)) as session:
            echo = next(t for t in session.tools if t.name == "echo")
            assert echo.side_effect is SideEffect.EXTERNAL_SIDE_EFFECT
            assert check_tool_policy(echo, READ_SCOPE).needs_approval
        await pool.aclose()


async def test_a_tool_level_failure_comes_back_as_a_readable_toolmessage(asgi):
    """`is_error` is a RESULT, not an exception: the spec asks servers to report
    tool failures in-result so the model can self-correct, and raising would
    spend a retry on a deterministic failure while hiding the message the model
    needs."""
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec()) as session:
            composed = compose_tools([session], pool=pool)
            fails = next(t for t in composed.tools if t.name == "always_fails")
            msgs = await execute_tool_calls(
                [{"name": fails.tool_id, "args": {}, "id": "c2"}],
                _ctx(composed, scope=WRITE_SCOPE),
            )
        assert len(msgs) == 1 and msgs[0].tool_call_id == "c2"
        assert msgs[0].content, "a tool failure must reach the model, not vanish"
        await pool.aclose()


# ------------------------------------------------------ argument validation
async def test_the_model_cannot_send_an_undeclared_argument_to_a_remote_server(
    asgi,
):
    """GAP 1 + GAP 3 end to end. Before this phase the MCP adapter forwarded raw
    model-authored JSON unvalidated, and even after adding the validator the
    NESTED fields went unchecked because `$defs` refs resolved to `{}`."""
    app, traffic = build_mcp_app(nested=True)
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec()) as session:
            composed = compose_tools([session], pool=pool)
            search = next(t for t in composed.tools if t.name == "search")

            before = traffic.count
            msgs = await execute_tool_calls(
                [
                    {
                        "name": search.tool_id,
                        "args": {
                            "query": "x",
                            "filters": {"label": "a", "evil": "injected"},
                        },
                        "id": "c3",
                    }
                ],
                # WRITE_SCOPE, because `search` is unannotated and the
                # fail-safe classifier parks it at approval otherwise. The
                # ORDER is the executor's and is deliberately not changed here:
                # policy -> approval -> adapter, so validation is the last gate
                # before the wire, not a substitute for the first two.
                _ctx(composed, scope=WRITE_SCOPE),
            )
            # Refused locally: the hostile argument never reached the server.
            assert traffic.count == before, "an invalid payload was sent anyway"
            assert len(msgs) == 1
            # Classified as a SCHEMA failure, not a generic error, and it names
            # the offending field so the model can correct itself rather than
            # retrying the same malformed call.
            assert "schema_validation" in msgs[0].content
            assert "evil" in msgs[0].content
            assert msgs[0].status == "error"
        await pool.aclose()


async def test_a_valid_nested_argument_still_reaches_the_server(asgi):
    """The other half: validation that rejects everything is not validation."""
    app, _ = build_mcp_app(nested=True)
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec()) as session:
            composed = compose_tools([session], pool=pool)
            search = next(t for t in composed.tools if t.name == "search")
            msgs = await execute_tool_calls(
                [
                    {
                        "name": search.tool_id,
                        "args": {
                            "query": "q",
                            "filters": {"label": "lbl", "limit": 3},
                            "tags": ["a", "b"],
                        },
                        "id": "c4",
                    }
                ],
                _ctx(composed, scope=WRITE_SCOPE),
            )
            assert "q:lbl:2" in msgs[0].content
        await pool.aclose()


# ----------------------------------------------------------- result bounds
async def test_an_enormous_result_is_bounded_and_the_truncation_is_announced(
    asgi,
):
    """A silently cut result is one the model reasons over as if complete."""
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec()) as session:
            composed = compose_tools([session], pool=pool, result_max_bytes=2000)
            huge = next(t for t in composed.tools if t.name == "huge")
            msgs = await execute_tool_calls(
                [{"name": huge.tool_id, "args": {}, "id": "c5"}],
                _ctx(composed, scope=WRITE_SCOPE),
            )
            content = msgs[0].content
            assert len(content) < 20_000, "the result was not bounded"
            assert "truncated" in content.lower()
        await pool.aclose()


# ---------------------------------------------------------- multi-server
async def test_two_remote_servers_exposing_the_same_tool_name_both_work(
    asgi, monkeypatch
):
    """Server A's `echo` must not overwrite Server B's, and BOTH must be
    callable through the same executor context."""
    app_a, _ = build_mcp_app(name="fake")
    app_b, _ = build_colliding_app()

    import app.mcp.session as session_mod
    from app.mcp.transport import build_http_client as real_build

    def routed(spec_, headers, recorder, **kwargs):
        target = app_b if spec_.identity.slug == "other" else app_a
        kwargs.setdefault("transport", httpx2.ASGITransport(app=target))
        return real_build(spec_, headers, recorder, **kwargs)

    monkeypatch.setattr(session_mod, "build_http_client", routed)
    monkeypatch.setattr(session_mod, "_WATCH_LIST_CHANGES", False)  # see _park

    async with running(app_a), running(app_b), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec(connection_id="a", slug="fake")) as sa:
            async with pool.acquire(spec(connection_id="b", slug="other")) as sb:
                composed = compose_tools([sa, sb], pool=pool)
                ids = composed.tool_ids
                assert "mcp:fake:echo" in ids
                assert "mcp:other:echo" in ids

                msgs = await execute_tool_calls(
                    [
                        {
                            "name": "mcp:fake:echo",
                            "args": {"text": "one"},
                            "id": "a1",
                        },
                        {
                            "name": "mcp:other:echo",
                            "args": {"text": "two"},
                            "id": "b1",
                        },
                    ],
                    _ctx(composed),
                )
                by_id = {m.tool_call_id: m.content for m in msgs}
                assert "one" in by_id["a1"]
                # The colliding server prefixes its answer, so this proves the
                # call went to the RIGHT server rather than to A twice.
                assert "other:two" in by_id["b1"]
        await pool.aclose()


async def test_an_existing_non_mcp_provider_still_dispatches_normally(asgi):
    """`ctx.adapters.get(provider) or ctx.adapter` — the fallback that keeps
    every existing single-provider deployment byte-identical."""
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec()) as session:
            base = ToolRegistry()
            base.register(
                ToolDefinition(
                    tool_id="search_web", name="Search Web", provider="ollagraph"
                )
            )
            composed = compose_tools([session], base=base, pool=pool)
            assert composed.registry.get("search_web") is not None
            assert composed.registry.get("mcp:fake:echo") is not None
            # No adapter is registered for ollagraph, so it falls through to
            # `ctx.adapter` exactly as before.
            assert composed.adapters.get("ollagraph") is None
        await pool.aclose()


# ------------------------------------------------------------- the selector
async def test_mcp_tools_survive_the_existing_spec_builder(asgi):
    """`build_tool_specs` is what actually reaches the model. An MCP tool whose
    schema still carried an unresolved `$ref` would be sent to the model as a
    reference it cannot resolve."""
    app, _ = build_mcp_app(nested=True)
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec()) as session:
            composed = compose_tools([session], pool=pool)
            candidates = [
                ToolCandidate(tool=t, score=1.0) for t in composed.tools
            ]
            specs, _name_to_id = build_tool_specs(candidates, composed.registry)
            assert specs
            blob = str(specs)
            assert "$ref" not in blob, "an unresolved ref reached the model"
            assert "$defs" not in blob
        await pool.aclose()


# ------------------------------------------------------------ cancellation
async def test_cancelling_a_slow_call_notifies_the_remote_server(asgi):
    """§54, stated honestly.

    The SDK's `cancel_on_abandon` defaults True, so abandoning a request sends
    `notifications/cancelled`. This asserts the notification ARRIVED — which is
    the only thing that can be asserted, because MCP cancellation is ADVISORY:
    a server may ignore it, and a side-effecting call already dispatched may
    complete on the far side. That limit is documented, not papered over.
    """
    app, traffic = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec()) as session:
            with anyio.move_on_after(2):
                await session.client.call_tool("slow", {"seconds": 30})
            # Give the cancellation notification a moment to be delivered and
            # handled server-side.
            for _ in range(20):
                if traffic.cancelled:
                    break
                await anyio.sleep(0.05)
        assert traffic.cancelled, (
            "the server never observed the cancellation; "
            "cancel_on_abandon did not fire"
        )
        await pool.aclose()


async def test_a_cancelled_call_does_not_poison_the_session(asgi):
    """A cancelled request must not leave the session unusable for the next
    one -- otherwise one slow tool costs the user their whole connection."""
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec()) as session:
            with anyio.move_on_after(1):
                await session.client.call_tool("slow", {"seconds": 30})
            got = await session.client.call_tool("echo", {"text": "still here"})
            assert got.content[0].text == "still here"
        await pool.aclose()
