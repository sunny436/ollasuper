"""Build an SDK `Client` for a connection — with server-initiated callbacks REFUSED.

A FACTORY, NOT A WRAPPER. The SDK's `mcp.client.Client` is already the interface
this layer would otherwise re-implement: it is an async context manager exposing
`list_tools` / `call_tool` / `list_resources` / `list_prompts`, with
`server_capabilities` and `protocol_version` as properties and response caching
built in. Re-exporting those through a hand-written `McpClient` would add a
second thing to maintain and nothing else, so callers use the SDK client
directly and this module only decides HOW it is constructed.

WHY THE REFUSAL CALLBACKS ARE THE POINT OF THIS FILE
----------------------------------------------------
`Client.call_tool` documents that when a server returns an `InputRequiredResult`,
"the embedded input requests are dispatched to this client's sampling /
elicitation / roots callbacks and the call is retried automatically".

That means an MCP server can ask US to:

  * sampling    — run an LLM completion on ITS prompt. It spends OllaSuper's
                  model budget, on text the server chose. Cost abuse, and a
                  confused deputy: our key, their instructions.
  * elicitation — put a prompt of its choosing in front of OUR user.
  * roots       — enumerate filesystem roots we would expose to it.

All three default to `None` in the SDK, which refuses. We do NOT rely on that:
a security property that holds only because of a library default is one
dependency bump away from silently inverting. The refusals below are explicit,
logged, and asserted by tests — so if the default ever changes, nothing moves.

Granting any of these is a product decision with a budget attached; it is not
Phase 1, and it is not something a server gets to ask for.
"""

from __future__ import annotations

import logging
from contextlib import AsyncExitStack
from typing import Any

from app.mcp.models import McpConnectionConfig

log = logging.getLogger(__name__)

__all__ = ["build_client", "open_client"]

# JSON-RPC "method not found". The honest answer to a capability we do not
# advertise: the server asked for something this client does not implement.
_METHOD_NOT_FOUND = -32601


def _refusal(kind: str, slug: str) -> Any:
    """Build the ErrorData a refused server request is answered with."""
    from mcp_types import ErrorData  # noqa: PLC0415

    # WARNING, not debug: a server reaching for sampling is worth seeing. It may
    # be entirely legitimate (many servers probe), but it is also exactly what
    # budget abuse looks like, and Phase 8 will want the signal already flowing.
    log.warning("mcp.capability_refused", extra={"kind": kind, "server": slug})
    return ErrorData(
        code=_METHOD_NOT_FOUND,
        message=f"OllaSuper does not grant MCP '{kind}' to connected servers.",
    )


def build_client(config: McpConnectionConfig) -> Any:
    """Construct an SDK `Client` for `config`. Does not connect.

    The returned object is an async context manager: `async with client as c`
    performs initialize and capability negotiation, and exiting tears the
    session down. Callers use its own `list_tools` / `call_tool`.

    MUST BE ENTERED AND EXITED IN THE SAME TASK. `Client.__aenter__` opens an
    anyio task group, and anyio refuses to exit a cancel scope from a different
    task than entered it ("Attempted to exit a cancel scope that isn't the
    current task's current cancel scope"). That is not a style preference: it is
    why `app/mcp/session.py` gives every pooled session its own owner task
    instead of handing the client around as a plain object.
    """
    from mcp.client import Client  # noqa: PLC0415

    slug = config.identity.slug

    async def _no_sampling(_context: Any, _params: Any) -> Any:
        return _refusal("sampling", slug)

    async def _no_elicitation(_context: Any, _params: Any) -> Any:
        return _refusal("elicitation", slug)

    async def _no_roots(_context: Any) -> Any:
        return _refusal("roots", slug)

    from mcp.client.caching import CacheConfig  # noqa: PLC0415

    # A zero-arg callable means "build me a FRESH transport". Required because
    # `streamable_http_client` is an @asynccontextmanager whose result is
    # single-use, so a pooled connection could never reconnect through a stored
    # instance. Anything else (an in-process server, a Transport) is passed to
    # the SDK untouched, which is what keeps the Phase 1 tests unchanged.
    server = config.server() if callable(config.server) else config.server

    return Client(
        server=server,
        read_timeout_seconds=config.read_timeout_seconds,
        # Server notifications. Only the three `list_changed` kinds are acted
        # on, and only by marking the session stale (see `on_list_changed`).
        message_handler=(
            _list_changed_handler(config.on_list_changed)
            if config.on_list_changed is not None
            else None
        ),
        # EXPLICIT, and per-client. The SDK defaults to `CacheConfig()` already,
        # but the property that matters here is a security one: the default
        # store is per-client, so one tenant's cached `tools/list` can never be
        # served into another tenant's session. Stating it means a future SDK
        # default cannot invert it silently, and it documents the rule that a
        # SHARED `store=` must never be configured here.
        cache=CacheConfig(),
        # The three refusals. Explicit beats the None default — see the module
        # docstring. `sampling_capabilities` stays None so we do not ADVERTISE a
        # capability we then refuse; the callback is the backstop if one is
        # requested anyway.
        sampling_callback=_no_sampling,
        elicitation_callback=_no_elicitation,
        list_roots_callback=_no_roots,
        # A server that keeps asking does not get to keep us in a loop. The SDK
        # bounds this at 10 by default; 1 is the right bound for a client that
        # refuses every such request anyway.
        input_required_max_rounds=1,
    )


def _list_changed_handler(callback: Any) -> Any:
    """Turn the SDK's message stream into `callback(kind)` for list changes.

    Everything else — progress, logging, cancellation — is left to the SDK's
    own default (`checkpoint()`), so this handler changes nothing about how
    other notifications are treated.
    """
    import anyio  # noqa: PLC0415
    from mcp import types  # noqa: PLC0415

    kinds = (
        (types.ToolListChangedNotification, "tools"),
        (types.ResourceListChangedNotification, "resources"),
        (types.PromptListChangedNotification, "prompts"),
    )

    async def handler(message: Any) -> None:
        for cls, kind in kinds:
            if isinstance(message, cls):
                try:
                    callback(kind)
                except Exception:  # noqa: BLE001 -- a bookkeeping hook must not kill the read loop
                    log.warning("mcp.list_changed_callback_failed")
                return
        await anyio.lowlevel.checkpoint()

    return handler


async def open_client(config: McpConnectionConfig, stack: AsyncExitStack) -> Any:
    """Enter a client on the caller's exit stack and return the live session.

    The stack — not this function — owns teardown, so a caller that manages
    several connections closes them in one place and an exception on any one of
    them cannot leak the others.

    THE COST PHASE 1 DEFERRED, NOW MEASURED: connect-per-call spends 3 HTTP
    round trips per tool call (probe, initialize, the call) against 1 for a
    pooled session — 30 requests versus 12 for ten calls. Over the internet that
    is two extra RTTs on every single tool call, which is why `session.py`
    pools. This function remains the one-shot path used by lifecycle probes and
    by tests.
    """
    return await stack.enter_async_context(build_client(config))
