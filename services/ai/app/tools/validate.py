"""Default-closed validation of MODEL-AUTHORED tool arguments.

MOVED HERE, NOT WRITTEN HERE. Every rule, threshold and message below came
verbatim from `OllagraphAdapter._validate_input` / `._validate_value`, which is
live on the production tool path (`runner.py` builds that adapter). The move
exists because MCP became a second provider that forwards model-authored JSON to
a third party, and two copies of a security check are two copies that drift.
`test_ollagraph_adapter.py` and `test_capability_security.py` pass UNMODIFIED
against this module — that is the proof the move was pure.

WHY DEFAULT-CLOSED ONLY WHEN THE TOOL DECLARES ITS INPUTS: a bare
`{"type": "object"}` with neither `properties` nor `additionalProperties: false`
has an unknown shape, so rejecting extras there would reject legitimate calls.
Such a payload is still bounded by the absolute size/depth caps, which are
schema-independent on purpose.

THE CALLER MUST HAND IN A SELF-CONTAINED SCHEMA. This module does not resolve
`$ref`. An unresolved `$ref` node has no `type` and no `properties`, so it
validates nothing and does so SILENTLY — which is exactly the hole MCP's `$defs`
opened (see `app/mcp/normalize.py:resolve_local_refs`). Resolution is the
caller's job precisely because the two providers ref differently.
"""

from __future__ import annotations

import json

from app.tools.errors import ToolError, ToolErrorKind

__all__ = [
    "MAX_NESTING_DEPTH",
    "MAX_PAYLOAD_BYTES",
    "nesting_depth",
    "validate_args",
]

JSON_TYPES = {
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "array": list,
    "object": dict,
}

# Phase 5 DoS defense-in-depth: absolute, schema-INDEPENDENT caps on a tool-call
# body, so an unbounded or unschema'd field can't overflow the provider or the
# pipeline even when the schema declares no minLength/maxItems/etc.
MAX_PAYLOAD_BYTES = 128 * 1024
MAX_NESTING_DEPTH = 12


def nesting_depth(value: object, level: int = 0) -> int:
    """Max object/array nesting depth, short-circuited past the cap."""
    if level > MAX_NESTING_DEPTH:
        return level
    if isinstance(value, dict):
        vals = value.values()
        return max((nesting_depth(v, level + 1) for v in vals), default=level)
    if isinstance(value, list):
        return max((nesting_depth(v, level + 1) for v in value), default=level)
    return level


def validate_args(payload: dict, input_schema: dict | None) -> None:
    """DEFAULT-CLOSED validation. The model's args are untrusted: reject
    undeclared fields, enforce enums + string/number bounds, recurse into nested
    objects/arrays, and cap absolute payload size + nesting depth."""
    if not isinstance(payload, dict):
        raise ToolError(ToolErrorKind.INVALID_INPUT, "payload must be an object")
    # Absolute caps first (independent of the schema).
    try:
        size = len(json.dumps(payload, default=str))
    except (TypeError, ValueError) as e:
        raise ToolError(
            ToolErrorKind.INVALID_INPUT, "payload is not serializable"
        ) from e
    if size > MAX_PAYLOAD_BYTES:
        raise ToolError(ToolErrorKind.SCHEMA_VALIDATION, "payload too large")
    if nesting_depth(payload) > MAX_NESTING_DEPTH:
        raise ToolError(ToolErrorKind.SCHEMA_VALIDATION, "payload nested too deeply")
    if input_schema:
        validate_value(payload, input_schema, "$")


def validate_value(value: object, schema: dict, path: str) -> None:
    """Recursive per-node check against a (dereferenced) JSON schema node."""
    if not isinstance(schema, dict) or not schema:
        return
    jtype = schema.get("type")
    expected = JSON_TYPES.get(jtype) if isinstance(jtype, str) else None
    # bool is an int subclass — guard against it satisfying `integer`/`number`.
    if expected is not None and (
        not isinstance(value, expected)
        or (jtype in ("integer", "number") and isinstance(value, bool))
    ):
        raise ToolError(ToolErrorKind.SCHEMA_VALIDATION, f"{path} expected {jtype}")
    enum = schema.get("enum")
    if isinstance(enum, list) and value not in enum:
        raise ToolError(
            ToolErrorKind.SCHEMA_VALIDATION, f"{path} is not an allowed value"
        )
    if isinstance(value, str):
        mx, mn = schema.get("maxLength"), schema.get("minLength")
        if isinstance(mx, int) and len(value) > mx:
            raise ToolError(ToolErrorKind.SCHEMA_VALIDATION, f"{path} too long")
        if isinstance(mn, int) and len(value) < mn:
            raise ToolError(ToolErrorKind.SCHEMA_VALIDATION, f"{path} too short")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        mx, mn = schema.get("maximum"), schema.get("minimum")
        if isinstance(mx, (int, float)) and value > mx:
            raise ToolError(ToolErrorKind.SCHEMA_VALIDATION, f"{path} above maximum")
        if isinstance(mn, (int, float)) and value < mn:
            raise ToolError(ToolErrorKind.SCHEMA_VALIDATION, f"{path} below minimum")
    if isinstance(value, dict) and (jtype == "object" or "properties" in schema):
        props = schema.get("properties") or {}
        for req in schema.get("required") or []:
            if req not in value:
                raise ToolError(
                    ToolErrorKind.SCHEMA_VALIDATION,
                    f"missing required field: {req}",
                )
        additional = schema.get("additionalProperties")
        # DEFAULT-CLOSED when the tool DECLARES its inputs (properties) or
        # explicitly forbids extras. A bare {"type":"object"} with neither is
        # treated as open (bounded only by the DoS caps) since its shape is
        # unknown — tightening that would need live-spec confirmation.
        closed = bool(props) or additional is False
        for k, v in value.items():
            if k in props:
                validate_value(v, props[k], f"{path}.{k}")
            elif isinstance(additional, dict):
                validate_value(v, additional, f"{path}.{k}")
            elif additional is True:
                continue
            elif closed:
                raise ToolError(
                    ToolErrorKind.SCHEMA_VALIDATION, f"unexpected field: {k}"
                )
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for i, item in enumerate(value):
            validate_value(item, schema["items"], f"{path}[{i}]")
