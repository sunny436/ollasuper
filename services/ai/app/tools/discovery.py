"""Turn an OpenAPI 3.x spec into normalized `ToolDefinition`s.

Pure and side-effect-free: it takes an already-fetched spec dict (the adapter
does the HTTP) so it is trivially testable from a fixture. `$ref`s are NOT
fully dereferenced — the raw schema is kept and `components.schemas` is returned
alongside for lazy resolution, which avoids infinite recursion on self-
referential schemas.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.models.tools import (
    Availability,
    ToolCostMetadata,
    ToolDefinition,
)
from app.tools.classify import classify

_HTTP_METHODS = ("get", "post", "put", "patch", "delete")
_TIMEOUT_KEYS = ("timeout", "timeout_seconds")


@dataclass
class DiscoveryResult:
    definitions: list[ToolDefinition] = field(default_factory=list)
    # components.schemas, kept once for lazy `$ref` resolution by consumers.
    components: dict = field(default_factory=dict)
    report: dict = field(default_factory=dict)


def _deref_once(schema: dict, components: dict) -> dict:
    """Follow a top-level `#/components/schemas/X` once (non-recursive)."""
    if not isinstance(schema, dict):
        return {}
    ref = schema.get("$ref")
    if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
        name = ref.rsplit("/", 1)[-1]
        target = components.get(name)
        return target if isinstance(target, dict) else {}
    return schema


def _required_auth(op: dict, global_security: list) -> str:
    """Map an operation's security requirement to a scheme name. AdminToken
    wins if present (those ops need a platform-admin token we do not hold)."""
    security = op.get("security")
    if security is None:
        security = global_security or []
    names: list[str] = []
    for req in security:
        if isinstance(req, dict):
            names.extend(req.keys())
    if "AdminToken" in names:
        return "AdminToken"
    return names[0] if names else "BearerAuth"


def _request_schema(op: dict) -> dict:
    body = op.get("requestBody") or {}
    content = body.get("content") or {}
    json_ct = content.get("application/json") or {}
    schema = json_ct.get("schema")
    return schema if isinstance(schema, dict) else {}


def _output_schema(op: dict) -> dict | None:
    responses = op.get("responses") or {}
    ok = responses.get("200") or responses.get("201") or {}
    content = ok.get("content") or {}
    schema = (content.get("application/json") or {}).get("schema")
    # The Ollagraph spec declares `{}` for every 200 — treat empty as "none".
    if isinstance(schema, dict) and schema:
        return schema
    return None


def _tool_timeout(request_schema: dict, components: dict, default: float) -> float:
    props = (_deref_once(request_schema, components) or {}).get("properties") or {}
    for key in _TIMEOUT_KEYS:
        spec = props.get(key)
        if isinstance(spec, dict) and isinstance(spec.get("default"), (int, float)):
            return float(spec["default"])
    return default


def discover_from_spec(spec: dict, *, default_timeout: float) -> DiscoveryResult:
    """Parse a spec dict into definitions + a coverage report. Never raises on
    a merely-odd operation — it skips it and records the reason."""
    paths = spec.get("paths") or {}
    components = (spec.get("components") or {}).get("schemas") or {}
    version = (spec.get("info") or {}).get("version") or ""
    global_security = spec.get("security") or []

    definitions: list[ToolDefinition] = []
    seen_ids: set[str] = set()
    skipped: list[dict] = []
    duplicates: list[str] = []
    by_category: dict[str, int] = {}
    by_method: dict[str, int] = {}
    ops_seen = 0

    for path, item in paths.items():
        if not isinstance(item, dict):
            continue
        for method in _HTTP_METHODS:
            op = item.get(method)
            if not isinstance(op, dict):
                continue
            ops_seen += 1
            by_method[method] = by_method.get(method, 0) + 1

            op_id = op.get("operationId") or f"{method}_{path}"
            if op_id in seen_ids:
                duplicates.append(op_id)
                op_id = f"{op_id}__{method}_{path}"
            seen_ids.add(op_id)

            try:
                tags = op.get("tags") or []
                category = tags[0] if tags else "uncategorized"
                req_schema = _request_schema(op)
                required_auth = _required_auth(op, global_security)
                side, perms, enabled = classify(method, path, required_auth)

                definitions.append(
                    ToolDefinition(
                        tool_id=op_id,
                        name=op.get("summary") or op_id,
                        description=op.get("description") or op.get("summary") or "",
                        input_schema=req_schema,
                        output_schema=_output_schema(op),
                        category=category,
                        provider="ollagraph",
                        permissions=perms,
                        timeout=_tool_timeout(req_schema, components, default_timeout),
                        rate_limit=None,
                        cost_metadata=ToolCostMetadata(),
                        side_effect=side,
                        enabled=enabled,
                        availability=Availability.AVAILABLE,
                        version=version,
                        method=method,
                        path=path,
                        required_auth=required_auth,
                    )
                )
                by_category[category] = by_category.get(category, 0) + 1
            except Exception as e:  # noqa: BLE001 — never let one op break discovery
                skipped.append({"op_id": op_id, "reason": type(e).__name__})

    report = {
        "paths": len(paths),
        "operations_seen": ops_seen,
        "registered": len(definitions),
        "skipped": len(skipped),
        "skipped_detail": skipped,
        "duplicate_operation_ids": duplicates,
        "by_category": dict(sorted(by_category.items(), key=lambda kv: -kv[1])),
        "by_method": by_method,
        "version": version,
    }
    return DiscoveryResult(
        definitions=definitions, components=components, report=report
    )
