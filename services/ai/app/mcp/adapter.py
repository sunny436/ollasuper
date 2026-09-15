"""`McpToolAdapter` — one class, one method, plugged into machinery that exists.

WHAT THIS DELIBERATELY DOES NOT DO: authorization, policy, approval, allow-list,
write-ahead, retry, backoff, timeout, idempotency, injection framing, recovery,
streaming. Every one of those already happens in `_run_one` (app/agent/executor.py)
for ANY provider, and re-implementing any of them here would create the second
execution pipeline this integration exists to avoid.

The executor reaches this class through `ctx.adapters.get(tool.provider)`, which
is live today (a `seo_write` provider already uses it) — so MCP needs no change
to the executor at all.

WHAT IT *DOES* DO, AND WHY IT HAS TO
------------------------------------
ARGUMENT VALIDATION. An earlier version of this file said "`input_schema` is
unused: the executor has already validated `payload` against it before calling".
That was FALSE. `executor.py` dereferences the schema and HANDS IT TO THE
ADAPTER; `OllagraphAdapter._validate_input` is what actually validates, and it is
live in production. So MCP was the one provider forwarding raw model-authored
JSON, unbounded, to a third party. The shared validator now runs here too.

That fix alone was not enough, which is the more interesting half. MCP tool
schemas are emitted by pydantic, so a nested model becomes `$defs` plus
`{"$ref": "#/$defs/Filter"}` — and the executor's dereferencer only understands
the OpenAPI `#/components/schemas/X` form, resolving anything else to `{}`. An
empty schema node validates nothing, SILENTLY. Measured against a live server:
top-level checks all fired while an undeclared nested field, a missing nested
required field and a wrong nested type were all accepted. `normalize.py` now
inlines `$defs` at discovery time so the schema reaching this validator is
self-contained.

TENANCY: `user_id` / `workspace_id` arrive from the trusted `ToolExecContext`.
They are never read from the tool's arguments, the server's response, or any MCP
metadata.
"""

from __future__ import annotations

import contextlib
import json
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import AsyncExitStack
from typing import Any

from app.mcp.connection import open_client
from app.mcp.errors import to_tool_error
from app.mcp.models import McpConnectionConfig
from app.models.tools import ToolDefinition
from app.tools.validate import validate_args

log = logging.getLogger(__name__)

__all__ = ["McpToolAdapter"]

# Content block kinds that are safe to inline as text. Everything else — image,
# audio, embedded resource — becomes a MARKER, never raw bytes: a base64 image
# inlined into a tool result would blow the context window that
# `result_max_chars` exists to protect, and the model cannot read it anyway.
_TEXT_KINDS = frozenset({"text"})

#: Provider-side ceiling on one result, applied BEFORE the executor's own
#: `result_max_chars`. Two bounds rather than one because they protect different
#: things: this one stops a hostile server making us build a 200MB string in the
#: first place; the executor's stops a large-but-legitimate result eating the
#: context window.
DEFAULT_RESULT_MAX_BYTES = 256 * 1024
#: Content blocks per result and structured-content nesting depth, applied
#: BEFORE any serialisation. A server decides how many blocks it returns and
#: how deep its structured content nests; both are walked and dumped here, so
#: both are bounded here — `json.dumps` of a 100k-block or 200-deep payload is
#: the cost this file must not pay. `Settings.mcp_max_result_blocks/_depth`.
DEFAULT_RESULT_MAX_BLOCKS = 512
DEFAULT_RESULT_MAX_DEPTH = 32


def _render_content(
    blocks: Any, *, max_blocks: int = DEFAULT_RESULT_MAX_BLOCKS
) -> tuple[list[str], list[dict]]:
    """Split a CallToolResult's content into inlinable text and typed markers.

    Only the first `max_blocks` are looked at. The rest are COUNTED and
    announced in a marker, never walked — the cap exists so a hostile block
    count costs nothing past the cap.
    """
    text: list[str] = []
    markers: list[dict] = []
    items = list(blocks or [])
    if len(items) > max_blocks:
        markers.append(
            {
                "type": "truncated",
                "omitted": f"{len(items) - max_blocks} content blocks beyond the "
                f"{max_blocks}-block limit were dropped",
            }
        )
        items = items[:max_blocks]
    for block in items:
        kind = getattr(block, "type", None) or ""
        if kind in _TEXT_KINDS:
            value = getattr(block, "text", None)
            if isinstance(value, str) and value:
                text.append(value)
            continue
        # A RESOURCE LINK IS A REFERENCE, NEVER A FETCH (§27). The server is
        # saying "this exists"; acting on that by reading it would let a tool
        # result pull arbitrary content into the turn without the model, the
        # policy or the user asking for it. The URI is preserved so a LATER
        # explicit `mcp_read_resource` can act on it — and that call goes
        # through the capability index, which only authorizes URIs the server
        # actually advertised.
        if kind == "resource_link":
            markers.append(
                {
                    "type": "resource_link",
                    "uri": getattr(block, "uri", None),
                    "name": getattr(block, "name", None),
                    "mime_type": getattr(block, "mime_type", None),
                    "note": "reference only; read it explicitly if needed",
                }
            )
            continue

        # An EMBEDDED RESOURCE already carries its content, so there is nothing
        # to fetch. Text is inlined (the server chose to send it); a blob is
        # named and dropped, for the same reason binary is refused on the read
        # path — base64 in a ToolMessage is unreadable to a model and costs the
        # whole payload in memory.
        if kind == "resource":
            inner = getattr(block, "resource", None)
            inner_text = getattr(inner, "text", None)
            if isinstance(inner_text, str) and inner_text:
                text.append(inner_text)
                continue
            markers.append(
                {
                    "type": "resource",
                    "uri": getattr(inner, "uri", None),
                    "mime_type": getattr(inner, "mime_type", None),
                    "omitted": "embedded binary resource is not inlined",
                }
            )
            continue

        # Describe it; do not carry it. `mime_type` is useful, the payload is not.
        markers.append(
            {
                "type": kind or "unknown",
                "mime_type": getattr(block, "mime_type", None),
                "omitted": "non-text content is not inlined",
            }
        )
    return text, markers


class McpToolAdapter:
    """Satisfies `app.agent.adapters.ToolAdapter` for one MCP connection.

    Two ways to reach a session, and both are real:

      * `session_provider` — an async context manager yielding a pooled
        `McpSession`. The production path: one handshake amortised across every
        call, and the session's `StatusRecorder` is what lets a 401 be told
        apart from a 429.
      * `config` — open a client per call. Used by the in-process tests and by
        one-shot lifecycle probes, where pooling would be machinery for a single
        request.
    """

    def __init__(
        self,
        config: McpConnectionConfig | None = None,
        *,
        session_provider: Callable[[], Any] | None = None,
        result_max_bytes: int = DEFAULT_RESULT_MAX_BYTES,
        server_slug: str = "",
        result_max_blocks: int = DEFAULT_RESULT_MAX_BLOCKS,
        result_max_depth: int = DEFAULT_RESULT_MAX_DEPTH,
        quota: Any = None,
        user_gate: Any = None,
        hourly: Callable[[], Any] | None = None,
        connection_id: str = "",
    ) -> None:
        if config is None and session_provider is None:
            raise ValueError("McpToolAdapter needs either a config or a session")
        self._config = config
        self._session_provider = session_provider
        self._result_max_bytes = max(1024, result_max_bytes)
        self._result_max_blocks = max(1, result_max_blocks)
        self._result_max_depth = max(1, result_max_depth)
        # Quotas (audit H-09; `quota.py`). All three are optional so the
        # one-shot and test paths need none; `mcp_for_turn` supplies all three
        # for every production turn.
        self._quota = quota
        self._user_gate = user_gate
        self._hourly = hourly
        self._connection_id = connection_id
        self._slug = server_slug or (config.identity.slug if config is not None else "")

    @property
    def provider_id(self) -> str:
        if self._config is not None:
            return self._config.identity.provider_id
        return f"mcp:{self._slug}"

    def _wire_name(self, tool: ToolDefinition) -> str:
        """Recover the server-side tool name from our namespaced `tool_id`.

        The wire call must use the bare name; `tool_id` is "mcp:<slug>:<name>".
        Stripped using THIS adapter's own slug rather than by parsing the id, so
        a tool name containing ':' survives and a mismatched id falls back
        rather than sending a mangled name to the server.
        """
        prefix = f"mcp:{self._slug}:"
        if tool.tool_id.startswith(prefix):
            return tool.tool_id[len(prefix) :]
        return tool.name

    @contextlib.asynccontextmanager
    async def _session(self) -> AsyncIterator[tuple[Any, Any, Any]]:
        """Yield `(client, recorder, call_lock)`. Pooled when available,
        one-shot otherwise (no recorder, no lock: nothing is shared)."""
        if self._session_provider is not None:
            async with self._session_provider() as session:
                if getattr(session, "stale", False):
                    # The server changed its list after this turn bound its
                    # tools. What the model would call is no longer what the
                    # server serves; the next turn re-discovers.
                    from app.mcp.exceptions import (  # noqa: PLC0415
                        McpConnectionError,
                        McpErrorKind,
                    )

                    raise McpConnectionError(
                        McpErrorKind.CAPABILITY_ERROR,
                        "the server changed its tool list during this turn; "
                        "start a new turn to use the updated tools",
                        server_slug=self._slug,
                    )
                yield (
                    session.client,
                    session.recorder,
                    getattr(session, "call_lock", None),
                )
            return
        async with AsyncExitStack() as stack:
            client = await open_client(self._config, stack)
            # No recorder on the one-shot path: it exists per session, and this
            # path has no session to hang it on. Classification then falls back
            # to leaf type, which is all the in-process transport can offer
            # anyway (it produces no HTTP status).
            yield client, None, None

    async def call_tool(
        self,
        tool: ToolDefinition,
        payload: dict,
        *,
        input_schema: dict | None = None,
        idempotency_key: str | None = None,
        user_id: str = "",
        workspace_id: str = "",
    ) -> dict:
        """Execute one MCP tool call and return a JSON-safe dict.

        `idempotency_key` is unused because MCP defines no idempotency header —
        which is exactly why `provider_idempotency_supported` is False on every
        MCP ToolDefinition, so the executor never auto-replays a write.
        """
        slug = self._slug
        name = self._wire_name(tool)

        # DEFAULT-CLOSED, and it happens HERE because nothing upstream does it.
        # See the module docstring: the executor dereferences the schema and
        # delegates; it does not validate.
        validate_args(payload or {}, input_schema)

        # QUOTAS, before the wire (audit H-09). Per-turn counters first (pure,
        # instant), then the durable hourly window (one loopback round trip,
        # FAIL CLOSED), then the per-user concurrency gate around the call.
        if self._quota is not None:
            self._quota.admit(
                connection_id=self._connection_id or slug,
                tool_id=tool.tool_id,
                payload=payload or {},
            )
        if self._hourly is not None:
            await self._hourly()

        # Identifiers only. Never the payload: that is where user data and any
        # credential-shaped argument would be.
        log.info(
            "mcp.call_tool",
            extra={
                "server": slug,
                "tool": name,
                "user_id": user_id,
                "workspace_id": workspace_id,
            },
        )
        recorder = None
        try:
            async with (
                _maybe(self._user_gate),
                self._session() as (client, recorder, call_lock),
                _maybe(call_lock),
            ):
                if recorder is not None:
                    # Clear first: a 401 recorded by an earlier, unrelated call
                    # on this pooled session must not be blamed on this one.
                    # Safe because the session's call lock (held above) means
                    # no other call is in flight on this recorder (M-07).
                    recorder.reset()
                result = await client.call_tool(name, payload or {})
        except Exception as exc:  # noqa: BLE001 — normalized on the next line
            raise to_tool_error(exc, server_slug=slug, recorder=recorder) from exc

        # THE ADAPTER CONTRACT, which the `-> dict` hint does not convey: the
        # executor reads `result.get("data")` (executor.py) and bounds THAT.
        # Returning the payload at the top level makes it read `None` and the
        # model receives "null" — found by the integration test, not by review.
        data = self._normalize_result(
            result,
            self._result_max_bytes,
            max_blocks=self._result_max_blocks,
            max_depth=self._result_max_depth,
        )
        if self._quota is not None:
            # Charged AFTER bounding: the budget is what reaches the model.
            self._quota.charge(len(json.dumps(data, default=str)))
        return {
            "ok": True,
            "tool_id": tool.tool_id,
            # The CONFIGURED caps. An earlier version called this with the
            # module default and silently ignored `result_max_bytes` (H-08).
            "data": data,
        }

    @staticmethod
    def _normalize_result(
        result: Any,
        max_bytes: int = DEFAULT_RESULT_MAX_BYTES,
        *,
        max_blocks: int = DEFAULT_RESULT_MAX_BLOCKS,
        max_depth: int = DEFAULT_RESULT_MAX_DEPTH,
    ) -> dict:
        """`CallToolResult` -> the dict the executor frames into a ToolMessage.

        `is_error=True` IS NOT RAISED, and that is deliberate. The spec asks
        servers to report tool-originated failures in-result "so the LLM can see
        and self-correct". Raising would spend a retry and a backoff on a
        deterministic failure and withhold from the model the message it needs
        to fix its own arguments. Verified against a real HTTP session: an
        unknown tool name comes back as a result, raising nothing. So it comes
        back as a result here too, clearly flagged.
        """
        text, markers = _render_content(
            getattr(result, "content", None), max_blocks=max_blocks
        )
        structured = getattr(result, "structured_content", None)
        is_error = bool(getattr(result, "is_error", False))

        out: dict[str, Any] = {}
        if structured is not None:
            # Preserved, not stringified: `_bounded` keeps dict/list intact, so
            # the model reasons over structure rather than a JSON blob in prose.
            # DEPTH FIRST, before the dump: `_deeper_than` short-circuits at
            # the cap, so a 200-deep payload costs 32 levels of walking, not a
            # recursive serialisation.
            if _deeper_than(structured, max_depth):
                out["structured"] = {
                    "error": "structured content nested deeper than the limit "
                    "and was dropped",
                    "limit": max_depth,
                }
            else:
                out["structured"] = _bound_structured(structured, max_bytes)
        if text:
            out["text"] = _bound_text("\n".join(text), max_bytes)
        if markers:
            out["omitted_content"] = markers
        if is_error:
            # Named so the model can act on it, and so a reader of the ledger
            # can tell a tool-level failure from a successful call.
            out["is_error"] = True
            out.setdefault("text", "The tool reported an error.")
        if not out:
            out["text"] = ""
        return out


@contextlib.asynccontextmanager
async def _maybe(gate: Any) -> AsyncIterator[None]:
    """`async with gate:` when there is one, a no-op when there is not."""
    if gate is None:
        yield
        return
    async with gate:
        yield


def _deeper_than(value: Any, limit: int, _level: int = 0) -> bool:
    """Does `value` nest past `limit`? Short-circuits at the first offending
    branch, so a nesting bomb costs `limit` levels of walking and no more."""
    if _level > limit:
        return True
    if isinstance(value, dict):
        return any(_deeper_than(v, limit, _level + 1) for v in value.values())
    if isinstance(value, list):
        return any(_deeper_than(v, limit, _level + 1) for v in value)
    return False


def _bound_text(text: str, limit: int) -> str:
    # Measured in BYTES, like every other cap on this path: a limit that counts
    # characters is a limit a server doubles with multi-byte text.
    if len(text.encode("utf-8")) <= limit:
        return text
    # Truncation is ANNOUNCED. A silently cut result is one the model reasons
    # over as if it were complete.
    note = f"\n\n[truncated: the server returned more than {limit} bytes]"
    return text.encode("utf-8")[:limit].decode("utf-8", errors="ignore") + note


def _bound_structured(structured: Any, limit: int) -> Any:
    try:
        encoded = json.dumps(structured, default=str)
    except (TypeError, ValueError):
        return {"error": "structured content could not be serialized"}
    if len(encoded) <= limit:
        return structured
    return {
        "error": "structured content exceeded the size limit and was dropped",
        "bytes": len(encoded),
        "limit": limit,
    }
