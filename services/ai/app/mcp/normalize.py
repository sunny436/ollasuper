"""MCP `Tool` -> OllaSuper `ToolDefinition`. PURE: no I/O, no network, no clock.

Kept pure on purpose — like `app/finance/calc.py`, the whole security-relevant
mapping is then testable with no server, no session and no fixtures.

THE SECURITY-CRITICAL LINE IN THIS FILE is `_side_effect`. MCP's own type
definitions say of `ToolAnnotations`:

    "all properties in ToolAnnotations are hints. They are not guaranteed to
     provide a faithful description of tool behavior... Clients should never
     make tool use decisions based on ToolAnnotations received from untrusted
     servers."

...and `destructive_hint` DEFAULTS TO TRUE. `side_effect` is what
`check_tool_policy` uses to decide whether a call needs human approval, so
deriving it from a value the server controls would let a malicious server mark
`delete_everything` read-only and skip the approval gate. Hence: fail safe
always, and let a hint DOWNGRADE only when the operator has marked the
connection trusted.

THE SECOND SECURITY-CRITICAL LINE is `resolve_local_refs`, and it was found by
running a real MCP server rather than by reading one. MCP tool schemas are
emitted by pydantic, so a nested model becomes `$defs` + `{"$ref":
"#/$defs/Filter"}`. OllaSuper's executor dereferences `#/components/schemas/X`
(the OpenAPI form) and resolves ANYTHING ELSE to `{}` — and an empty schema node
validates nothing, silently. Measured against a live server: top-level checks
all fired, while an undeclared nested field, a missing nested required field and
a wrong nested type were ALL ACCEPTED. Resolving the refs here, at the one place
that already owns "MCP shape -> OllaSuper shape", makes the stored schema
self-contained so `app/tools/validate.py` sees real nested shapes. It also stops
the model receiving a `$ref` it cannot resolve, since `build_tool_specs` sends
`input_schema` to the LLM verbatim.
"""

from __future__ import annotations

import json
from typing import Any

from app.mcp.models import McpServerIdentity
from app.models.tools import (
    Availability,
    SideEffect,
    ToolDefinition,
    ToolPermissions,
)

__all__ = ["normalize_tool", "normalize_tools", "resolve_local_refs"]

# MCP requires `type: "object"` at the root of an input schema. A server that
# sends something else gets an empty object schema rather than a rejected tool:
# `build_tool_specs` does the same, and dropping a tool silently is worse than
# offering it with no arguments.
_EMPTY_SCHEMA: dict[str, Any] = {"type": "object", "properties": {}}

# Bounds on `$defs` expansion. A ref graph is attacker-supplied, so resolution is
# depth-bounded AND cycle-guarded; expansion can also GROW a schema, so the size
# cap is applied after resolving, never before.
_MAX_REF_DEPTH = 12
#: Default ceiling on one tool's resolved input schema. The schema is
#: dereferenced and walked on every single call, and it is also sent to the model
#: on every turn, so an unbounded one costs both CPU and context.
MAX_SCHEMA_BYTES = 64 * 1024
#: Default ceiling on tools accepted from one server. A 5,000-tool server would
#: swamp the selector index and the registry.
MAX_TOOLS_PER_SERVER = 256


def resolve_local_refs(
    schema: Any,
    defs: dict[str, Any] | None = None,
    seen: frozenset[str] = frozenset(),
    depth: int = 0,
) -> Any:
    """Inline `#/$defs/...` references so the result is SELF-CONTAINED.

    Bounded and cycle-guarded: a self-referential `$defs` resolves to `{}` at the
    point of recursion rather than recursing forever. That leaves one node
    unvalidated, which is the honest trade — the alternative is dropping an
    otherwise-usable tool because it models a tree.

    Non-`$defs` refs (e.g. the OpenAPI `#/components/schemas/X` form) are left
    EXACTLY as they are: they belong to the other provider's resolver, and
    rewriting them here would break Ollagraph's own dereferencing.
    """
    if depth > _MAX_REF_DEPTH or not isinstance(schema, dict):
        return schema
    if defs is None:
        raw_defs = schema.get("$defs")
        defs = raw_defs if isinstance(raw_defs, dict) else {}
    ref = schema.get("$ref")
    if isinstance(ref, str) and ref.startswith("#/$defs/"):
        name = ref.rsplit("/", 1)[-1]
        if name in seen:
            return {}
        target = defs.get(name)
        if not isinstance(target, dict):
            return {}
        return resolve_local_refs(target, defs, seen | {name}, depth + 1)
    out: dict[str, Any] = {}
    for key, value in schema.items():
        if key == "$defs":
            continue  # inlined above; carrying it forward only inflates the schema
        if isinstance(value, dict):
            out[key] = resolve_local_refs(value, defs, seen, depth + 1)
        elif isinstance(value, list):
            out[key] = [
                resolve_local_refs(v, defs, seen, depth + 1)
                if isinstance(v, dict)
                else v
                for v in value
            ]
        else:
            out[key] = value
    return out


def _declared_read_only(annotations: Any) -> bool:
    """The server's own `readOnlyHint`, and ONLY an explicit True."""
    return getattr(annotations, "read_only_hint", None) is True


def _side_effect(annotations: Any, *, trusted: bool) -> SideEffect:
    """Blast-radius classification. FAIL SAFE — see the module docstring.

    Only ONE path reaches READ_ONLY: an explicitly read-only hint from a server
    the operator has marked trusted. Everything else — no annotations, a
    destructive hint, an ambiguous hint, or ANY hint from an untrusted server —
    is EXTERNAL_SIDE_EFFECT, which `check_tool_policy` sends to approval.
    """
    if not trusted:
        return SideEffect.EXTERNAL_SIDE_EFFECT
    if annotations is not None and getattr(annotations, "read_only_hint", None) is True:
        return SideEffect.READ_ONLY
    return SideEffect.EXTERNAL_SIDE_EFFECT


def _schema(raw: Any, *, max_bytes: int) -> dict[str, Any]:
    if not isinstance(raw, dict) or raw.get("type") != "object":
        return dict(_EMPTY_SCHEMA)
    resolved = resolve_local_refs(raw)
    if not isinstance(resolved, dict) or resolved.get("type") != "object":
        return dict(_EMPTY_SCHEMA)
    # AFTER resolution: inlining a `$defs` entry used in ten places multiplies it.
    try:
        size = len(json.dumps(resolved, default=str))
    except (TypeError, ValueError) as e:
        raise ValueError("tool input schema is not serializable") from e
    if size > max_bytes:
        # Raised, not silently emptied: an empty schema would make an unbounded
        # tool look like a zero-argument one and validate nothing. The caller's
        # skip-one-bad-tool loop drops just this tool.
        raise ValueError(f"tool input schema too large: {size} > {max_bytes}")
    return resolved


def normalize_tool(
    tool: Any,
    identity: McpServerIdentity,
    *,
    timeout_s: float = 30.0,
    max_schema_bytes: int = MAX_SCHEMA_BYTES,
    origin: str = "",
) -> ToolDefinition:
    """One `mcp_types.Tool` -> one `ToolDefinition`.

    Typed as `Any` rather than importing `mcp_types.Tool` so this module stays
    importable (and testable) without the SDK present; only the attributes the
    protocol guarantees are read.
    """
    name = getattr(tool, "name", "") or ""
    if not name:
        raise ValueError("MCP tool has no name")

    return ToolDefinition(
        # Namespaced: ToolRegistry._by_id is a flat map that silently overwrites
        # on collision, and `search` exists on half the MCP ecosystem.
        tool_id=identity.tool_id(name),
        name=name,
        description=(getattr(tool, "description", None) or "")[:1024],
        input_schema=_schema(
            getattr(tool, "input_schema", None), max_bytes=max_schema_bytes
        ),
        output_schema=getattr(tool, "output_schema", None),
        # Per-SERVER category, so a PolicyScope can allow one connection's tools
        # without naming each tool — `check_tool_policy` already scopes on
        # `tool.category in scope.allowed_categories`.
        category=identity.provider_id,
        # Keys both `ToolExecContext.adapters` and `replace_provider`.
        provider=identity.provider_id,
        side_effect=_side_effect(
            getattr(tool, "annotations", None), trusted=identity.trusted
        ),
        # EVERYTHING ASKS, EXCEPT A DECLARED READ ON A SERVER THE OPERATOR
        # VOUCHED FOR. The side-effect ceiling gates nothing on an elevated turn
        # (production runs every turn elevated), so this flag is the human gate.
        # The waiver has TWO conditions and both are needed: `readOnlyHint` is
        # server metadata, and MCP's own spec says clients "should not make
        # tool use decisions based on ToolAnnotations received from untrusted
        # servers" — an earlier version honoured the hint alone, so an untrusted
        # server marking `delete_everything` read-only ran it unasked (audit
        # H-05). Now the hint lowers nothing unless `trusted`, which only an
        # operator sets; and even a trusted server's WRITE always asks.
        permissions=ToolPermissions(
            approval_required=not (
                identity.trusted
                and _declared_read_only(getattr(tool, "annotations", None))
            )
        ),
        timeout=timeout_s,
        enabled=True,
        availability=Availability.AVAILABLE,
        # `idempotent_hint` exists but is server-controlled, and this flag makes a
        # SIDE-EFFECTING tool auto-retryable. Trusting it would let a server opt
        # its own writes into silent replay. False until Phase 6 trust tiers.
        provider_idempotency_supported=False,
        # HTTP-shaped fields that MCP has no analogue for. Explicitly blank so it
        # is obvious they are unused rather than defaulted-and-forgotten; the MCP
        # adapter dispatches on `provider` and never reads these.
        method="",
        path="",
        required_auth="mcp",
        version="",
        # `<connection_id>|<endpoint_url>` from the session that discovered it;
        # part of the approval binding so an approval cannot cross connections.
        origin=origin,
    )


def normalize_tools(
    tools: list[Any],
    identity: McpServerIdentity,
    *,
    timeout_s: float = 30.0,
    max_tools: int = MAX_TOOLS_PER_SERVER,
    max_schema_bytes: int = MAX_SCHEMA_BYTES,
    origin: str = "",
) -> list[ToolDefinition]:
    """Normalize a `tools/list` payload. A malformed or oversized entry is
    SKIPPED, not fatal: one bad tool must not cost the user every other tool on
    that server.

    The count is capped because a remote server decides how many tools it
    advertises. Callers compare `len(result)` against `len(tools)` and log the
    shortfall — this module stays pure, so the WARNING is emitted one layer up
    where a logger belongs (`app/mcp/session.py`). Silent truncation would read
    as "this server has 256 tools".
    """
    out: list[ToolDefinition] = []
    for t in tools[: max(0, max_tools)]:
        try:
            out.append(
                normalize_tool(
                    t,
                    identity,
                    timeout_s=timeout_s,
                    max_schema_bytes=max_schema_bytes,
                    origin=origin,
                )
            )
        except (ValueError, TypeError, AttributeError):
            continue
    return out
