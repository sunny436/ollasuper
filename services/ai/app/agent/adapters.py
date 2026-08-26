"""Provider-neutral tool-execution contract.

The executor depends on THIS Protocol, never on a concrete provider adapter. A
provider (Ollagraph today, GSC/GA4/etc. later) supplies a `ToolAdapter`; the
executor dispatches per `tool.provider`. `OllagraphAdapter.call_tool` already
matches this signature byte-for-byte, so it satisfies the Protocol without change.

Discovery (fetching a provider's spec, building the registry) is a SEPARATE
startup concern and deliberately not part of this per-call Protocol.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.models.tools import ToolDefinition


class ToolResultEnvelope(dict):
    """The normalized success envelope every adapter returns.

    A plain `dict` subclass (not a TypedDict) so existing adapters that return a
    bare dict remain valid and so `.get(...)` access in the executor is unchanged.
    Documented keys the executor consumes: `ok: bool`, `tool_id: str`,
    `data: object`, `cost: dict` (`{"credits": str | None}`),
    `provider_request_id: str | None`.
    """


@runtime_checkable
class ToolAdapter(Protocol):
    """One remote tool call. Owns the provider's base URL, auth, and HTTP client.

    Raises `ToolError` (see `app.clients.ollagraph`) on failure; a `TimeoutError`
    is bounded by the caller via `asyncio.wait_for`. Keyword names are load-bearing
    — the executor passes them by keyword.
    """

    async def call_tool(
        self,
        tool: ToolDefinition,
        payload: dict,
        *,
        input_schema: dict | None = None,
        idempotency_key: str | None = None,
        user_id: str = "",
        workspace_id: str = "",
    ) -> dict: ...
