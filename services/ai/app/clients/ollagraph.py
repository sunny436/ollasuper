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

import asyncio
import contextlib
import json

import httpx

from app.config import Settings
from app.logging import get_logger
from app.models.tools import ToolDefinition
from app.ssrf import SsrfError, assert_payload_urls_safe
from app.tools.discovery import DiscoveryResult, discover_from_spec
from app.tools.errors import ToolError, ToolErrorKind

log = get_logger(__name__)


class AdaptiveGate:
    """Process-wide, provider-feedback concurrency gate for outbound tool calls.

    OllaSuper imposes NO configured ceiling on how much Ollagraph work an agent may
    do — a task that genuinely needs 200 calls makes 200. What it must not do is
    fire them faster than the provider will accept: 429 is by far the most common
    Ollagraph failure in production, and a rate-limited call is work the model
    silently does not get. A fixed cap cannot solve that (too low throttles honest
    work, too high converts throughput into errors), so the width is discovered
    from the provider instead of configured: AIMD — halve on a 429, grow by one per
    sustained-success round, floored so it can never collapse to nothing.

    Deliberately process-wide, like the httpx pool it fronts: the executor's
    per-step semaphore is per-turn, so without a shared gate N concurrent streams
    would each believe they owned the whole pool.
    """

    def __init__(self, maximum: int, minimum: int) -> None:
        self._max = max(1, maximum)
        self._min = max(1, min(minimum, self._max))
        self._limit = self._max
        self._in_flight = 0
        self._ok = 0
        # Generation counter, bumped on every narrowing. A wide window that is too
        # wide produces MANY simultaneous 429s — one per in-flight request — and
        # halving once per 429 would collapse straight to the floor on the first
        # burst. Each request carries the epoch it was admitted under, and only a
        # 429 from the CURRENT epoch narrows: one halving per over-wide window,
        # which is what AIMD actually means.
        self._epoch = 0
        self._cond = asyncio.Condition()

    @property
    def limit(self) -> int:
        return self._limit

    @contextlib.asynccontextmanager
    async def slot(self):
        """Yields the epoch this call was admitted under — pass it back to
        `on_rate_limited` so a stale 429 cannot re-narrow an already-narrowed gate."""
        async with self._cond:
            while self._in_flight >= self._limit:
                await self._cond.wait()
            self._in_flight += 1
            epoch = self._epoch
        try:
            yield epoch
        finally:
            async with self._cond:
                self._in_flight -= 1
                self._cond.notify()

    async def on_rate_limited(self, epoch: int) -> None:
        """Multiplicative decrease: the provider just told us we are too wide.

        Ignores a 429 raised by a request admitted under an EARLIER epoch — those
        were already in flight when we narrowed, so they are evidence about the old
        width, not the new one."""
        async with self._cond:
            if epoch != self._epoch:
                return
            before = self._limit
            self._limit = max(self._min, self._limit // 2)
            self._epoch += 1
            self._ok = 0
        if before != self._limit:
            log.info("tool.gate_narrowed", extra={"from": before, "to": self._limit})

    async def on_success(self) -> None:
        """Additive increase, one slot per `limit` consecutive successes, so the
        gate probes back toward the pool size without immediately re-tripping."""
        async with self._cond:
            self._ok += 1
            if self._ok >= self._limit and self._limit < self._max:
                self._limit += 1
                self._ok = 0
                self._cond.notify()


_gate: AdaptiveGate | None = None


def tool_gate(settings: Settings) -> AdaptiveGate:
    """The shared gate every outbound Ollagraph call passes through. Lazy, so it
    binds to the running loop (mirrors ingest/governor.py)."""
    global _gate
    if _gate is None:
        _gate = AdaptiveGate(
            settings.ollagraph_max_connections, settings.ollagraph_min_concurrency
        )
    return _gate

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
    def build_http_client(settings: Settings | None = None) -> httpx.AsyncClient:
        # Mirrors ConvexClient.build_http_client(); tool endpoints can be slow
        # (scraping/rendering), so the read timeout is generous but bounded.
        #
        # This client is a PROCESS-WIDE singleton (app.state.ollagraph_http), so
        # `max_connections` is shared by every concurrent stream — it is not a
        # per-turn budget. It is the one genuine infrastructure limit on outbound
        # tool concurrency, which is why the executor's semaphore is derived from
        # the same setting rather than being an independent second cap.
        n = (
            settings.ollagraph_max_connections
            if settings is not None
            else Settings.model_fields["ollagraph_max_connections"].default
        )
        return httpx.AsyncClient(
            limits=httpx.Limits(
                max_connections=n,
                max_keepalive_connections=max(1, n // 2),
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
        # SSRF BOUNDARY: a tool payload can carry a model-supplied `url` that
        # Ollagraph then fetches. Refuse to forward any URL that points at
        # loopback / private / metadata / internal targets, resolved via DNS.
        # Default-closed: unsafe URLs never leave this process.
        try:
            await assert_payload_urls_safe(payload)
        except SsrfError as e:
            raise ToolError(
                ToolErrorKind.INVALID_INPUT,
                f"unsafe url refused: {e}",
                tool_id=tool.tool_id,
            ) from e
        headers = self._auth_headers(
            tool, user_id=user_id, workspace_id=workspace_id
        )
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key
        # Phase 5: the destination is fixed — host from operator config, path +
        # method from the trusted discovered spec, NEVER from model args. No tool
        # argument can redirect the outbound call (no SSRF from this plane).
        url = f"{self._s.ollagraph_base_url.rstrip('/')}{tool.path}"
        # A spec-declared timeout still wins; the crawl override only replaces the
        # DEFAULT, for the tools that fetch many pages in one call and cannot
        # finish in 30s. Bounded well under the 300s turn deadline on purpose.
        _default = self._s.ollagraph_default_tool_timeout_s
        # Match on BOTH ids: `tool_id` carries the provider's operation id
        # (seo_broken_links_endpoint_v1_...), `name` the shorter registry name, and
        # which one carries the marker depends on the discovered spec.
        _ident = f"{tool.tool_id} {tool.name}".lower()
        if any(m in _ident for m in self._s.ollagraph_crawl_tool_markers):
            _default = max(_default, self._s.ollagraph_crawl_tool_timeout_s)
        timeout = tool.timeout or _default
        gate = tool_gate(self._s)
        try:
            # An explicit Timeout, NOT a bare float: httpx applies a bare float to
            # every phase including `pool`, which made waiting for a free connection
            # consume the tool's own EXECUTION budget — so a queued call could burn
            # its whole allowance before its first byte, time out, and be retried,
            # adding yet more pool pressure. Connect/read/write keep the tool's
            # budget; pool acquisition gets its own, separately bounded wait.
            async with gate.slot() as gate_epoch:
                r = await self._c.request(
                    tool.method.upper(),
                    url,
                    json=payload,
                    headers=headers,
                    timeout=httpx.Timeout(
                        connect=5.0,
                        read=timeout,
                        write=10.0,
                        pool=self._s.ollagraph_pool_acquire_timeout_s,
                    ),
                )
        except httpx.TimeoutException as e:
            raise ToolError(
                ToolErrorKind.TIMEOUT, "tool call timed out", tool_id=tool.tool_id
            ) from e
        except httpx.TransportError as e:
            raise ToolError(
                ToolErrorKind.UNAVAILABLE, "tool unreachable", tool_id=tool.tool_id
            ) from e

        # Feed the provider's verdict back BEFORE normalization turns it into an
        # exception, so the gate learns from every call including the failed ones.
        if r.status_code == 429:
            await gate.on_rate_limited(gate_epoch)
        elif r.status_code < 400:
            await gate.on_success()
        return self._normalize_response(tool, r)

    @staticmethod
    def _retry_after(r: httpx.Response) -> float | None:
        """RFC 9110 `Retry-After`, as seconds. Accepts the delta-seconds form
        (what rate limiters send); an HTTP-date form is ignored rather than
        mis-parsed into a wrong wait. Negative/absurd values are dropped so a
        malformed header can never park a turn.
        """
        raw = (r.headers.get("retry-after") or "").strip()
        if not raw:
            return None
        try:
            secs = float(raw)
        except ValueError:
            return None
        return secs if 0 <= secs <= 3600 else None

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
            # 429 is by far the most common Ollagraph failure in production, so the
            # provider's own backoff instruction is carried through rather than
            # discarded — retrying on a 0.5s/1.0s exponential just lands all three
            # attempts inside the same rate window and fails all three.
            raise ToolError(
                ToolErrorKind.RATE_LIMITED,
                "tool rate limited",
                tool_id=tid,
                status=sc,
                retry_after_s=self._retry_after(r),
            )
        if sc >= 500:
            # 503 commonly carries Retry-After too; honour it when present.
            raise ToolError(
                ToolErrorKind.UPSTREAM_ERROR,
                "tool upstream error",
                tool_id=tid,
                status=sc,
                retry_after_s=self._retry_after(r),
            )
        raise ToolError(
            ToolErrorKind.UPSTREAM_ERROR, "tool error", tool_id=tid, status=sc
        )
