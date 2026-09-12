"""The MCP adapter, against a real in-process MCP server.

Covers the two normalization decisions that are easy to get backwards:

  * `is_error=True` is a SUCCESSFUL result carrying a tool-level failure. The
    spec asks servers to report those in-result "so the LLM can see and
    self-correct". Raising would spend a retry on a deterministic failure and
    withhold the message the model needs.
  * server-initiated sampling / elicitation / roots are REFUSED. Sampling means
    an MCP server can spend OllaSuper's model budget on the server's own prompt.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from app.agent.adapters import ToolAdapter
from app.mcp.adapter import McpToolAdapter
from app.mcp.connection import build_client
from app.mcp.errors import to_tool_error
from app.mcp.models import McpConnectionConfig, McpServerIdentity
from app.mcp.normalize import normalize_tools
from app.tools.errors import ToolError, ToolErrorKind
from tests.fakes.mcp_server import build_test_server

IDENTITY = McpServerIdentity(slug="fake", display_name="Fake", trusted=True)


def _config(**over: Any) -> McpConnectionConfig:
    return McpConnectionConfig(
        identity=over.pop("identity", IDENTITY),
        server=over.pop("server", build_test_server()),
        **over,
    )


async def _definitions(cfg: McpConnectionConfig):
    async with build_client(cfg) as client:
        listed = await client.list_tools()
        return {d.name: d for d in normalize_tools(list(listed.tools), cfg.identity)}


# ------------------------------------------------------------- the contract
def test_adapter_satisfies_the_existing_tooladapter_protocol():
    """`ToolAdapter` is @runtime_checkable, and the executor dispatches on it —
    so conformance is checkable, not a matter of convention."""
    assert isinstance(McpToolAdapter(_config()), ToolAdapter)


# ------------------------------------------------------------- happy paths
async def test_call_returns_structured_content():
    cfg = _config()
    defs = await _definitions(cfg)
    out = (await McpToolAdapter(cfg).call_tool(defs["add"], {"a": 2, "b": 3}))["data"]
    # Structure preserved, not stringified — `_bounded` keeps dict/list intact.
    assert out["structured"] == {"result": 5}


async def test_call_returns_text_content():
    cfg = _config()
    defs = await _definitions(cfg)
    out = (await McpToolAdapter(cfg).call_tool(defs["echo"], {"text": "hello"}))["data"]
    assert "hello" in (out.get("text") or "") or out.get("structured") == {
        "result": "hello"
    }


async def test_a_dict_returning_tool_round_trips():
    cfg = _config()
    defs = await _definitions(cfg)
    out = (await McpToolAdapter(cfg).call_tool(defs["get_test_data"], {}))["data"]
    payload = out.get("structured") or {}
    assert payload.get("id") == 7 and payload.get("items") == ["a", "b"]


async def test_result_is_json_safe():
    import json

    cfg = _config()
    defs = await _definitions(cfg)
    out = (await McpToolAdapter(cfg).call_tool(defs["add"], {"a": 1, "b": 1}))["data"]
    json.dumps(out)  # must not raise


# ------------------------------------------------- is_error is NOT an exception
async def test_a_failing_tool_returns_a_result_rather_than_raising():
    """The spec's self-correction path. Raising here would burn a retry and hide
    the server's message from the model."""
    cfg = _config()
    defs = await _definitions(cfg)
    out = (await McpToolAdapter(cfg).call_tool(defs["always_fails"], {}))["data"]
    assert out["is_error"] is True
    assert out.get("text")  # the model must be able to read WHY


# ---------------------------------------------------------- error mapping
def test_every_mcp_failure_maps_into_the_existing_vocabulary():
    from mcp.shared.exceptions import MCPError
    from pydantic import ValidationError

    cases = [
        (TimeoutError("slow"), ToolErrorKind.TIMEOUT, True),
        (ConnectionError("refused"), ToolErrorKind.UNAVAILABLE, True),
        (RuntimeError("???"), ToolErrorKind.UPSTREAM_ERROR, False),
    ]
    for exc, kind, retryable in cases:
        err = to_tool_error(exc, server_slug="fake")
        assert isinstance(err, ToolError)
        assert err.kind is kind, f"{exc!r} -> {err.kind}"
        assert err.retryable is retryable
    assert "fake" in to_tool_error(TimeoutError("x"), server_slug="fake").message

    # A pydantic ValidationError means the server spoke the wrong dialect —
    # retrying cannot fix that.
    try:
        from mcp_types import Tool

        Tool(name=None, input_schema=None)  # type: ignore[arg-type]
    except ValidationError as ve:
        err = to_tool_error(ve, server_slug="fake")
        assert err.kind is ToolErrorKind.MALFORMED_RESPONSE
        assert err.retryable is False

    assert isinstance(MCPError, type)


async def test_a_dead_server_raises_a_normalized_tool_error_not_a_raw_sdk_error():
    cfg = _config()
    defs = await _definitions(cfg)
    broken = _config(server="http://127.0.0.1:1/mcp")  # nothing listens there
    with pytest.raises(ToolError):
        await McpToolAdapter(broken).call_tool(defs["echo"], {"text": "x"})


# --------------------------------------------------- non-text content bounds
@dataclass
class _Block:
    type: str
    text: str | None = None
    mime_type: str | None = None
    data: str | None = None


@dataclass
class _Result:
    content: list
    structured_content: Any = None
    is_error: bool = False


def test_binary_content_becomes_a_marker_not_raw_bytes():
    """A base64 image inlined into a tool result would blow the context window
    `result_max_chars` exists to protect, and the model cannot read it anyway."""
    huge = "A" * 100_000
    out = McpToolAdapter._normalize_result(
        _Result(content=[_Block(type="image", mime_type="image/png", data=huge)])
    )
    assert "omitted_content" in out
    assert huge not in str(out)
    assert out["omitted_content"][0]["mime_type"] == "image/png"


def test_text_and_markers_coexist():
    out = McpToolAdapter._normalize_result(
        _Result(content=[_Block(type="text", text="hi"), _Block(type="audio")])
    )
    assert out["text"] == "hi" and len(out["omitted_content"]) == 1


def test_an_empty_result_is_still_a_dict():
    assert McpToolAdapter._normalize_result(_Result(content=[])) == {"text": ""}


# ------------------------------------------------------------- the refusals
async def test_sampling_elicitation_and_roots_are_refused():
    """A server must not be able to spend our model budget (sampling), prompt
    our user (elicitation), or enumerate our filesystem (roots).

    Asserted against the constructed client rather than trusting the SDK's
    None-default: a security property that holds only by library default is one
    dependency bump from silently inverting.
    """
    from mcp_types import ErrorData

    client = build_client(_config())
    for attr in ("sampling_callback", "elicitation_callback", "list_roots_callback"):
        cb = getattr(client, attr)
        assert cb is not None, f"{attr} must be an explicit refusal, not None"

    assert isinstance(await client.sampling_callback(None, None), ErrorData)
    assert isinstance(await client.elicitation_callback(None, None), ErrorData)
    assert isinstance(await client.list_roots_callback(None), ErrorData)


async def test_the_server_cannot_hold_us_in_an_input_required_loop():
    assert build_client(_config()).input_required_max_rounds == 1


# ------------------------------------------------------------------ secrets
def test_a_config_repr_never_leaks_the_credential_hook():
    async def _creds() -> dict[str, str]:
        return {"Authorization": "Bearer super-secret-token"}

    cfg = _config(headers_provider=_creds)
    assert "super-secret-token" not in repr(cfg)
    assert "auth=yes" in repr(cfg)


async def test_the_result_is_wrapped_in_the_data_envelope_the_executor_reads():
    """`executor.py` does `_bounded(result.get("data"), …)`, which the Protocol's
    bare `-> dict` hint does not say. Returning the payload at the top level
    makes the executor read None and the model receive the string "null" — which
    is exactly what happened before the integration test caught it.
    """
    cfg = _config()
    defs = await _definitions(cfg)
    envelope = await McpToolAdapter(cfg).call_tool(defs["add"], {"a": 2, "b": 3})
    assert set(envelope) >= {"ok", "tool_id", "data"}
    assert envelope["tool_id"] == "mcp:fake:add"
    assert isinstance(envelope["data"], dict)
