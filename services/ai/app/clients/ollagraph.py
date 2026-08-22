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
        if not isinstance(payload, dict):
            raise ToolError(ToolErrorKind.INVALID_INPUT, "payload must be an object")
        if not input_schema:
            return
        required = input_schema.get("required") or []
        for key in required:
            if key not in payload:
                raise ToolError(
                    ToolErrorKind.SCHEMA_VALIDATION,
                    f"missing required field: {key}",
                )
        props = input_schema.get("properties") or {}
        for key, value in payload.items():
            spec = props.get(key)
            if not isinstance(spec, dict):
                continue
            jtype = spec.get("type")
            expected = _JSON_TYPES.get(jtype) if isinstance(jtype, str) else None
            # bool is an int subclass — guard against it satisfying `integer`.
            if expected and (
                not isinstance(value, expected)
                or (jtype in ("integer", "number") and isinstance(value, bool))
            ):
                raise ToolError(
                    ToolErrorKind.SCHEMA_VALIDATION,
                    f"field {key} expected {jtype}",
                )

    def _auth_headers(self, tool: ToolDefinition) -> dict:
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
        return {
            "authorization": f"Bearer {key}",
            "content-type": "application/json",
        }

    async def call_tool(
        self,
        tool: ToolDefinition,
        payload: dict,
        *,
        input_schema: dict | None = None,
    ) -> dict:
        """Normalized single-tool request. Raises `ToolError` on any failure.
        (Tests only — no production caller.)"""
        self._validate_input(payload, input_schema)
        headers = self._auth_headers(tool)
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
