"""Server-side adapter between Ollagraph and the rest of OllaSuper.

Two responsibilities:
  * `fetch_spec` / `discover` — pull the PUBLIC OpenAPI spec (no credential) and
    hand it to the pure discovery parser. This is what startup discovery uses.
  * `call_tool` — the normalized request/response primitive (auth header, input
    validation, response + error normalization). It is exercised ONLY by tests
    (against httpx.MockTransport); NO FastAPI route, graph node, or chat-path
    import calls it, and it makes ZERO real Ollagraph calls. Phase 1 executes
    no tools — this exists so error normalization is testable and so a future
    phase has a single, credential-safe execution seam.

Nothing here is wired to the LLM. Credentials never reach logs (we never
`log.exception` a provider error — the Phase-0 redaction gap leaves tracebacks
unscrubbed) and never reach the browser.
"""

from __future__ import annotations

import json

import httpx

from app.config import Settings
from app.logging import get_logger
from app.models.tools import ToolDefinition
from app.tools.discovery import DiscoveryResult, discover_from_spec
from app.tools.errors import ToolError, ToolErrorKind

log = get_logger(__name__)

_JSON_TYPES = {
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
_MAX_PAYLOAD_BYTES = 128 * 1024
_MAX_NESTING_DEPTH = 12


def _nesting_depth(value: object, level: int = 0) -> int:
    """Max object/array nesting depth, short-circuited past the cap."""
    if level > _MAX_NESTING_DEPTH:
        return level
    if isinstance(value, dict):
        vals = value.values()
        return max((_nesting_depth(v, level + 1) for v in vals), default=level)
    if isinstance(value, list):
        return max((_nesting_depth(v, level + 1) for v in value), default=level)
    return level


class OllagraphAdapter:
    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self._s = settings
        self._c = client

    @staticmethod
    def build_http_client() -> httpx.AsyncClient:
        # Mirrors ConvexClient.build_http_client(); tool endpoints can be slow
        # (scraping/rendering), so the read timeout is generous but bounded.
        return httpx.AsyncClient(
            limits=httpx.Limits(
                max_connections=16,
                max_keepalive_connections=8,
                keepalive_expiry=30,
            ),
            timeout=httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0),
            http2=False,
            # Phase 5: never follow a redirect off the fixed Ollagraph host.
            follow_redirects=False,
        )

    # --- discovery (public spec, no auth) --------------------------------
    async def fetch_spec(self) -> dict:
        url = self._s.ollagraph_spec_url
        try:
            r = await self._c.get(
                url, timeout=self._s.ollagraph_discovery_timeout_s
            )
        except httpx.TimeoutException as e:
            raise ToolError(ToolErrorKind.TIMEOUT, "spec fetch timed out") from e
        except httpx.TransportError as e:
            raise ToolError(ToolErrorKind.UNAVAILABLE, "spec unreachable") from e
        if r.status_code >= 400:
            raise ToolError(
                ToolErrorKind.UNAVAILABLE,
                f"spec fetch failed: {r.status_code}",
                status=r.status_code,
            )
        try:
            spec = r.json()
        except ValueError as e:
            raise ToolError(
                ToolErrorKind.MALFORMED_RESPONSE, "spec is not valid JSON"
            ) from e
        if not isinstance(spec, dict) or "paths" not in spec:
            raise ToolError(
                ToolErrorKind.MALFORMED_RESPONSE, "spec missing paths"
            )
        return spec

    async def discover(self) -> DiscoveryResult:
        spec = await self.fetch_spec()
        return discover_from_spec(
            spec, default_timeout=self._s.ollagraph_default_tool_timeout_s
        )

    # --- execution primitive (TESTS ONLY; not wired to prod) -------------
    def _validate_input(self, payload: dict, input_schema: dict | None) -> None:
        """Phase 5 DEFAULT-CLOSED validation. The model's args are untrusted:
        reject undeclared fields, enforce enums + string/number bounds, recurse
        into nested objects/arrays, and cap absolute payload size + nesting depth.
        The input_schema handed in is fully dereferenced by the executor, so the
        nested checks see real shapes, not $ref stubs."""
        if not isinstance(payload, dict):
            raise ToolError(ToolErrorKind.INVALID_INPUT, "payload must be an object")
        # Absolute caps first (independent of the schema).
        try:
            size = len(json.dumps(payload, default=str))
        except (TypeError, ValueError) as e:
            raise ToolError(
                ToolErrorKind.INVALID_INPUT, "payload is not serializable"
            ) from e
        if size > _MAX_PAYLOAD_BYTES:
            raise ToolError(ToolErrorKind.SCHEMA_VALIDATION, "payload too large")
        if _nesting_depth(payload) > _MAX_NESTING_DEPTH:
            raise ToolError(
                ToolErrorKind.SCHEMA_VALIDATION, "payload nested too deeply"
            )
        if input_schema:
            self._validate_value(payload, input_schema, "$")

    def _validate_value(self, value: object, schema: dict, path: str) -> None:
        """Recursive per-node check against a (dereferenced) JSON schema node."""
        if not isinstance(schema, dict) or not schema:
            return
        jtype = schema.get("type")
        expected = _JSON_TYPES.get(jtype) if isinstance(jtype, str) else None
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
                raise ToolError(
                    ToolErrorKind.SCHEMA_VALIDATION, f"{path} above maximum"
                )
            if isinstance(mn, (int, float)) and value < mn:
                raise ToolError(
                    ToolErrorKind.SCHEMA_VALIDATION, f"{path} below minimum"
                )
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
                    self._validate_value(v, props[k], f"{path}.{k}")
                elif isinstance(additional, dict):
                    self._validate_value(v, additional, f"{path}.{k}")
                elif additional is True:
                    continue
                elif closed:
                    raise ToolError(
                        ToolErrorKind.SCHEMA_VALIDATION, f"unexpected field: {k}"
                    )
        if isinstance(value, list) and isinstance(schema.get("items"), dict):
            for i, item in enumerate(value):
                self._validate_value(item, schema["items"], f"{path}[{i}]")

    def _auth_headers(
        self, tool: ToolDefinition, *, user_id: str = "", workspace_id: str = ""
    ) -> dict:
        if tool.required_auth == "AdminToken":
            # We hold no admin token; such ops are catalogued but not callable.
            raise ToolError(
                ToolErrorKind.AUTH_FAILED,
                "admin-scoped tool is not callable",
                tool_id=tool.tool_id,
            )
        key = self._s.ollagraph_api_key
        if key is None or key == "":
            raise ToolError(
                ToolErrorKind.AUTH_FAILED,
                "ollagraph api key not configured",
                tool_id=tool.tool_id,
            )
        headers = {
            "authorization": f"Bearer {key}",
            "content-type": "application/json",
        }
        # Phase 5: AUTHORITATIVE tenant/user scope, taken from the caller's ctx
        # (never from the model's args). A separate, non-forgeable header
        # namespace so Ollagraph can enforce per-user/workspace isolation even
        # though every call shares one service key.
        if user_id:
            headers["x-ollagraph-user"] = user_id
        if workspace_id:
            headers["x-ollagraph-workspace"] = workspace_id
        return headers

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
        """Normalized single-tool request. Raises `ToolError` on any failure.

        Phase 2: `idempotency_key` (sent as an `Idempotency-Key` header) is passed
        only when the tool declares `provider_idempotency_supported`, so a retry is
        provider-deduped. No Ollagraph op declares support today, so it is None in
        practice — the header is a dormant forward-compat mechanism.

        Phase 5: `user_id`/`workspace_id` are the AUTHORITATIVE caller scope from
        ctx (never model args); they ride separate headers so the fixed-host
        provider can enforce tenant/user isolation.
        """
        self._validate_input(payload, input_schema)
        headers = self._auth_headers(
            tool, user_id=user_id, workspace_id=workspace_id
        )
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key
        # Phase 5: the destination is fixed — host from operator config, path +
        # method from the trusted discovered spec, NEVER from model args. No tool
        # argument can redirect the outbound call (no SSRF from this plane).
        url = f"{self._s.ollagraph_base_url.rstrip('/')}{tool.path}"
        timeout = tool.timeout or self._s.ollagraph_default_tool_timeout_s
        try:
            r = await self._c.request(
                tool.method.upper(), url, json=payload, headers=headers, timeout=timeout
            )
        except httpx.TimeoutException as e:
            raise ToolError(
                ToolErrorKind.TIMEOUT, "tool call timed out", tool_id=tool.tool_id
            ) from e
        except httpx.TransportError as e:
            raise ToolError(
                ToolErrorKind.UNAVAILABLE, "tool unreachable", tool_id=tool.tool_id
            ) from e

        return self._normalize_response(tool, r)

    def _normalize_response(self, tool: ToolDefinition, r: httpx.Response) -> dict:
        sc = r.status_code
        if sc < 400:
            try:
                data = r.json()
            except ValueError as e:
                raise ToolError(
                    ToolErrorKind.MALFORMED_RESPONSE,
                    "tool returned non-JSON",
                    tool_id=tool.tool_id,
                    status=sc,
                ) from e
            return {
                "ok": True,
                "tool_id": tool.tool_id,
                "data": data,
                "cost": {"credits": r.headers.get("x-credits-cost")},
                # Phase 8: the provider's request id for the observability ledger.
                "provider_request_id": r.headers.get("x-request-id"),
            }

        # Log safe fields only — never the Authorization header, URL, or payload.
        log.warning(
            "tool.provider_error", extra={"tool_id": tool.tool_id, "status": sc}
        )
        tid = tool.tool_id
        if sc in (401, 403):
            raise ToolError(
                ToolErrorKind.AUTH_FAILED, "tool auth failed", tool_id=tid, status=sc
            )
        if sc == 404:
            raise ToolError(
                ToolErrorKind.INVALID_TOOL, "tool not found", tool_id=tid, status=sc
            )
        if sc == 422:
            raise ToolError(
                ToolErrorKind.SCHEMA_VALIDATION,
                "tool rejected input",
                tool_id=tid,
                status=sc,
            )
        if sc == 429:
            raise ToolError(
                ToolErrorKind.RATE_LIMITED, "tool rate limited", tool_id=tid, status=sc
            )
        if sc >= 500:
            raise ToolError(
                ToolErrorKind.UPSTREAM_ERROR,
                "tool upstream error",
                tool_id=tid,
                status=sc,
            )
        raise ToolError(
            ToolErrorKind.UPSTREAM_ERROR, "tool error", tool_id=tid, status=sc
        )
