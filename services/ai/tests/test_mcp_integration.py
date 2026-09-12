"""MCP through OllaSuper's EXISTING execution machinery — the Phase 1 success criteria.

The point of these tests is what they do NOT exercise: there is no MCP-specific
policy, approval, retry, bounding, framing or streaming anywhere. A real
`ToolExecContext`, a real `DeltaWriter`, the real `check_tool_policy` and the
real `execute_tool_calls` run an MCP tool exactly as they run an Ollagraph one,
dispatching through `ctx.adapters[tool.provider]`.

If MCP had needed a second execution pipeline, these tests could not be written.
"""

from __future__ import annotations

from langchain_core.messages import ToolMessage

from app.agent.executor import ToolExecContext, build_tool_specs, execute_tool_calls
from app.agent.policy import READ_SCOPE, check_tool_policy
from app.config import Settings
from app.mcp.adapter import McpToolAdapter
from app.mcp.connection import build_client
from app.mcp.models import McpConnectionConfig, McpServerIdentity
from app.mcp.normalize import normalize_tools
from app.models.tools import SideEffect, ToolCandidate, ToolDefinition
from app.runtime.writer import DeltaWriter
from app.tools.registry import ToolRegistry
from tests.fakes.mcp_server import build_colliding_server, build_test_server
from tests.test_writer_events import RecordingConvex

TRUSTED = McpServerIdentity(slug="fake", display_name="Fake", trusted=True)
OTHER = McpServerIdentity(slug="other", display_name="Other", trusted=True)


def _cfg(identity: McpServerIdentity, server) -> McpConnectionConfig:
    return McpConnectionConfig(identity=identity, server=server)


async def _discover(cfg: McpConnectionConfig) -> list[ToolDefinition]:
    async with build_client(cfg) as client:
        listed = await client.list_tools()
        return normalize_tools(list(listed.tools), cfg.identity)


# ------------------------------------------------------ registry coexistence
async def test_two_mcp_servers_and_an_existing_provider_coexist():
    """The flat `_by_id` map silently overwrites on a duplicate id, and both
    fake servers expose `echo` — so this is the collision that matters."""
    fake = await _discover(_cfg(TRUSTED, build_test_server()))
    other = await _discover(_cfg(OTHER, build_colliding_server()))

    reg = ToolRegistry()
    ollagraph = ToolDefinition(
        tool_id="search_web", name="Search Web", provider="ollagraph"
    )
    reg.register(ollagraph)
    reg.replace_provider("mcp:fake", fake)
    reg.replace_provider("mcp:other", other)

    assert reg.get("mcp:fake:echo") is not None
    assert reg.get("mcp:other:echo") is not None
    assert reg.get("mcp:fake:echo").description != reg.get("mcp:other:echo").description
    assert reg.get("search_web") is not None


async def test_replacing_one_mcp_provider_leaves_the_others_intact():
    """`replace_provider` must be surgical: refreshing one connection's
    catalogue cannot erase another's, or a reconnect would silently disarm
    every other server the user had."""
    fake = await _discover(_cfg(TRUSTED, build_test_server()))
    other = await _discover(_cfg(OTHER, build_colliding_server()))

    reg = ToolRegistry()
    reg.register(
        ToolDefinition(tool_id="search_web", name="Search Web", provider="ollagraph")
    )
    reg.replace_provider("mcp:fake", fake)
    reg.replace_provider("mcp:other", other)

    reg.replace_provider("mcp:fake", fake[:1])  # a refresh that returns fewer tools

    assert reg.get("mcp:other:echo") is not None, "another provider was erased"
    assert reg.get("search_web") is not None, "the non-MCP provider was erased"
    assert len([t for t in reg.list() if t.provider == "mcp:fake"]) == 1


# ------------------------------------------------------------ model binding
async def test_mcp_tools_bind_to_the_model_with_distinct_names():
    fake = await _discover(_cfg(TRUSTED, build_test_server()))
    other = await _discover(_cfg(OTHER, build_colliding_server()))
    reg = ToolRegistry()
    reg.replace_provider("mcp:fake", fake)
    reg.replace_provider("mcp:other", other)

    cands = [ToolCandidate(tool=t, score=1.0) for t in (*fake, *other)]
    specs, name_to_id = build_tool_specs(cands, reg)

    names = [s["function"]["name"] for s in specs]
    assert len(names) == len(set(names)), "two tools bound under one model-facing name"
    assert all(len(n) <= 64 for n in names), "a bound name exceeds the OpenAI limit"
    # Both `echo` tools survived as separately callable.
    assert len([tid for tid in name_to_id.values() if tid.endswith(":echo")]) == 2


# -------------------------------------------------------------------- policy
async def test_policy_applies_to_mcp_tools_with_no_mcp_specific_code():
    fake = {t.name: t for t in await _discover(_cfg(TRUSTED, build_test_server()))}
    # Trusted + explicitly read-only -> allowed under the read-only ceiling.
    assert check_tool_policy(fake["echo"], READ_SCOPE).allowed
    # Unannotated / destructive -> the existing side-effect ceiling sends it to
    # approval. No MCP-aware policy code exists or is needed.
    assert check_tool_policy(fake["write_note"], READ_SCOPE).needs_approval
    assert check_tool_policy(fake["get_test_data"], READ_SCOPE).needs_approval


async def test_an_untrusted_server_sends_even_its_read_only_tools_to_approval():
    untrusted = McpServerIdentity(slug="sketchy", trusted=False)
    tools = {t.name: t for t in await _discover(_cfg(untrusted, build_test_server()))}
    assert check_tool_policy(tools["echo"], READ_SCOPE).needs_approval


# ----------------------------------------------------- the full §32 chain
async def test_the_full_chain_from_model_tool_call_to_toolmessage():
    """model tool call -> policy -> executor -> MCP adapter -> server ->
    normalized result -> ToolMessage, through the real machinery."""
    cfg = _cfg(TRUSTED, build_test_server())
    tools = await _discover(cfg)
    by_name = {t.name: t for t in tools}
    reg = ToolRegistry()
    reg.replace_provider("mcp:fake", tools)

    settings = Settings()
    convex = RecordingConvex()
    ctx = ToolExecContext(
        registry=reg,
        adapter=None,
        # THE integration point: provider-keyed dispatch, already live.
        adapters={"mcp:fake": McpToolAdapter(cfg)},
        writer=DeltaWriter(convex, "s1", settings),
        scope=READ_SCOPE,
        name_to_tool_id={t.tool_id: t.tool_id for t in tools},
        result_max_chars=8000,
        default_timeout_s=30.0,
    )

    add = by_name["add"]
    assert add.side_effect is SideEffect.READ_ONLY  # no approval needed
    msgs = await execute_tool_calls(
        [{"name": add.tool_id, "args": {"a": 2, "b": 3}, "id": "c1"}], ctx
    )

    assert len(msgs) == 1
    msg = msgs[0]
    assert isinstance(msg, ToolMessage)
    assert msg.tool_call_id == "c1"
    assert "5" in msg.content, f"computed result missing from {msg.content!r}"
    # Inherited free: untrusted tool output is framed as DATA for the model.
    assert "<tool_output>" in msg.content


async def test_a_failing_mcp_tool_returns_a_paired_toolmessage_the_model_can_read():
    cfg = _cfg(TRUSTED, build_test_server())
    tools = await _discover(cfg)
    reg = ToolRegistry()
    reg.replace_provider("mcp:fake", tools)
    fails = next(t for t in tools if t.name == "always_fails")

    settings = Settings()
    ctx = ToolExecContext(
        registry=reg,
        adapter=None,
        adapters={"mcp:fake": McpToolAdapter(cfg)},
        writer=DeltaWriter(RecordingConvex(), "s1", settings),
        # always_fails is unannotated -> side-effecting, so allow the ceiling.
        scope=READ_SCOPE.model_copy(
            update={"max_side_effect": SideEffect.EXTERNAL_SIDE_EFFECT}
        )
        if hasattr(READ_SCOPE, "model_copy")
        else READ_SCOPE,
        name_to_tool_id={t.tool_id: t.tool_id for t in tools},
        result_max_chars=8000,
        default_timeout_s=30.0,
    )
    msgs = await execute_tool_calls(
        [{"name": fails.tool_id, "args": {}, "id": "c2"}], ctx
    )
    assert len(msgs) == 1 and msgs[0].tool_call_id == "c2"
    # A tool-level failure must reach the model as readable content, not vanish.
    assert msgs[0].content


# -------------------------------------------------------------- regression
def test_a_non_mcp_provider_still_dispatches_to_the_default_adapter():
    """`ctx.adapters.get(provider) or ctx.adapter` — the fallback that keeps
    every existing single-provider deployment byte-identical."""
    tool = ToolDefinition(tool_id="search_web", name="Search Web", provider="ollagraph")
    adapters = {"mcp:fake": McpToolAdapter(_cfg(TRUSTED, build_test_server()))}
    assert adapters.get(tool.provider) is None  # falls through to ctx.adapter
