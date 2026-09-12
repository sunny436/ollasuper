"""The ONE way an MCP resource reaches the model.

A single generic tool, not one per resource. The distinction matters: registering
each resource as a `ToolDefinition` would put every URI a user's servers advertise
into the model's tool list on every turn — the context explosion §37 warns about —
and would make resources indistinguishable from tools at exactly the layer that is
supposed to keep them apart.

WHAT MAKES IT SAFE IS WHAT IT DOES NOT TAKE. The model supplies a `uri` and
nothing else. It cannot name a connection, a server, or a credential; the
connection is resolved from the URI against the per-turn
`McpCapabilityIndex`, which was built only from sessions acquired for this user.
A URI matching nothing there is refused — never fetched, never guessed at.

`cache_mode="bypass"` IS LOAD-BEARING, and it was a correction from measurement.
`read_resource` defaults to `cache_mode="use"`, and the SDK honours a
server-declared `ttl_ms`, so a server could otherwise decide that its content
stays resident in our process. Whether a third party's data is cached is our
decision, and the answer in Phase 5 is no.
"""

from __future__ import annotations

from typing import Any

from app.logging import get_logger
from app.mcp.index import CapabilityLookupError, McpCapabilityIndex

log = get_logger(__name__)

__all__ = [
    "MCP_READ_RESOURCE_TOOL_NAME",
    "MCP_READ_RESOURCE_TOOL_SPEC",
    "read_resource",
]

MCP_READ_RESOURCE_TOOL_NAME = "mcp_read_resource"

#: Default ceiling on one resource body. Generous enough for a README or a config
#: file, small enough that a 50 MB log cannot be pulled into a turn. The executor
#: applies its own `result_max_chars` afterwards, so this bounds MEMORY while
#: that bounds CONTEXT.
DEFAULT_RESOURCE_MAX_BYTES = 128 * 1024

MCP_READ_RESOURCE_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": MCP_READ_RESOURCE_TOOL_NAME,
        "description": (
            "Read the contents of a resource exposed by one of the user's "
            "connected MCP servers. Use this when the user refers to a document, "
            "file, page, or record that a connected server offers as a resource. "
            "The `uri` must be one the server advertised — you cannot read "
            "arbitrary URLs, files, or web pages with this tool."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "uri": {
                    "type": "string",
                    "description": (
                        "The resource URI exactly as the connected server "
                        "advertised it, for example 'git://repo/main/README.md'."
                    ),
                }
            },
            "required": ["uri"],
            "additionalProperties": False,
        },
    },
}


async def read_resource(
    index: McpCapabilityIndex,
    uri: str,
    *,
    max_bytes: int = DEFAULT_RESOURCE_MAX_BYTES,
) -> dict[str, Any]:
    """Resolve, read and bound one resource. Never raises for a caller error.

    Returns a result dict rather than raising, matching how MCP tool errors are
    handled (`is_error` in the result): the model can correct a wrong URI if it
    is told what went wrong, and cannot if the turn fails.
    """
    try:
        resource, client = index.resolve_resource(uri)
    except CapabilityLookupError as exc:
        return {
            "is_error": True,
            "text": (
                f"{exc}. Only resources advertised by a connected server can be "
                "read, and this one was not among them."
            ),
        }

    try:
        # BYPASS: see the module docstring. A server does not get to decide that
        # its content lives in our memory.
        result = await client.read_resource(uri, cache_mode="bypass")
    except Exception as exc:  # noqa: BLE001 — reported to the model, not raised
        log.warning(
            "mcp.resource_read_failed",
            extra={
                "server": resource.server_slug,
                "connection_id": resource.connection_id,
                "reason": type(exc).__name__,
            },
        )
        return {
            "is_error": True,
            "text": f"The server could not read that resource ({type(exc).__name__}).",
        }

    return _normalize(result, resource=resource, max_bytes=max_bytes)


def _normalize(result: Any, *, resource: Any, max_bytes: int) -> dict[str, Any]:
    """`ReadResourceResult` -> the dict the executor frames into a ToolMessage.

    BINARY IS REFUSED, NOT DECODED. A `BlobResourceContents` carries base64;
    decoding it would allocate the whole payload and then have nowhere useful to
    put it, since a byte string in a ToolMessage is not something a model can
    read. Naming what was omitted is the bounded, honest answer — and storing
    binary for later retrieval is a Phase 7 decision, not a Phase 5 one.
    """
    texts: list[str] = []
    omitted: list[str] = []
    budget = max(0, max_bytes)
    truncated = False

    for block in getattr(result, "contents", None) or []:
        text = getattr(block, "text", None)
        if isinstance(text, str):
            clean = "".join(c for c in text if c >= " " or c in "\n\t")
            if len(clean) > budget:
                clean = clean[:budget]
                truncated = True
            if clean:
                texts.append(clean)
                budget -= len(clean)
            if budget <= 0:
                truncated = True
                break
            continue
        if getattr(block, "blob", None) is not None:
            omitted.append(
                "binary content ("
                f"{getattr(block, 'mime_type', None) or 'unknown type'})"
            )
            continue
        omitted.append(f"unsupported content ({type(block).__name__})")

    out: dict[str, Any] = {
        "uri": resource.uri,
        "server": resource.server_slug,
    }
    if resource.mime_type:
        out["mime_type"] = resource.mime_type
    if texts:
        out["text"] = "\n".join(texts)
    if omitted:
        out["omitted_content"] = omitted
    if truncated:
        out["truncated"] = True
    if not texts and not omitted:
        out["text"] = ""
    if not texts and omitted:
        # Say so in the field the model actually reads, rather than leaving it to
        # infer meaning from a metadata key.
        out["text"] = f"The resource contains no readable text ({'; '.join(omitted)})."
    return out
