"""Server-side adapter between Ollagraph and the rest of OllaSuper.

Two responsibilities:
  * `fetch_spec` / `discover` — pull the PUBLIC OpenAPI spec (no credential) and
    hand it to the pure discovery parser. This is what startup discovery uses.
  * `call_tool` — the normalized request/response primitive (auth header, input
    validation, response + error normalization). This IS the live production
    execution path: `runner.py` constructs this adapter and the executor
    dispatches to it via `ctx.adapter`. An earlier version of this docstring
    said "exercised ONLY by tests"; that was true when tools executed nothing
    and has been wrong since the agent started calling them.

Nothing here is wired to the LLM. Credentials never reach logs (we never
`log.exception` a provider error — the Phase-0 redaction gap leaves tracebacks
unscrubbed) and never reach the browser.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import time

import httpx

from app.agent.search_guard import SEARCH_TOOL_IDS
from app.config import Settings
from app.logging import get_logger
from app.models.tools import ToolDefinition
from app.ssrf import SsrfError, assert_payload_urls_safe
from app.tools.discovery import DiscoveryResult, discover_from_spec
from app.tools.errors import ToolError, ToolErrorKind
from app.tools.validate import validate_args

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

# --- search health, for hedging -----------------------------------------
# The last N search ATTEMPTS as (monotonic time, failed); failed = 5xx / timeout
# / transport. A 4xx (incl. 429) says nothing about the origin's flakiness and is
# not recorded;
# rate limiting is the gate's business. Process-wide, like the gate: one event
# loop, so plain module state needs no lock.
_SEARCH_WINDOW = 20
_SEARCH_MIN_SAMPLES = 5
_SEARCH_DEGRADED_RATE = 0.3
# Outcomes older than this are ignored: failures from before a quiet spell must
# not make the first searches after it pay for hedges the provider no longer
# needs.
_SEARCH_MAX_AGE_S = 600.0
# Never hedge while the gate is narrowed (the provider is rate-limiting us), and
# never let hedging add more than this many extra requests in flight process-wide.
_HEDGE_MIN_GATE = 4
_HEDGE_MAX_EXTRA_IN_FLIGHT = 6
# A hedged round finishes this long before the per-attempt timeout (see _search).
_HEDGE_DEADLINE_MARGIN_S = 1.0
_HEDGE_MIN_ROUND_S = 0.5
_search_outcomes: collections.deque[tuple[float, bool]] = collections.deque(
    maxlen=_SEARCH_WINDOW
)
_hedge_extra_in_flight = 0


def _record_search(failed: bool) -> None:
    _search_outcomes.append((time.monotonic(), failed))


def _search_degraded() -> bool:
    cutoff = time.monotonic() - _SEARCH_MAX_AGE_S
    recent = [failed for at, failed in _search_outcomes if at >= cutoff]
    return (
        len(recent) >= _SEARCH_MIN_SAMPLES
        and sum(recent) / len(recent) >= _SEARCH_DEGRADED_RATE
    )


def _log_hedge(attempts: int, failed: int, t0: float, *, ok: bool) -> None:
    log.info(
        "tool.search_hedged",
        extra={
            "attempts": attempts,
            "failed": failed,
            "elapsed_ms": round((time.monotonic() - t0) * 1000),
            "ok": ok,
        },
    )


def _is_origin_failure(e: ToolError) -> bool:
    return e.kind in (
        ToolErrorKind.TIMEOUT,
        ToolErrorKind.UNAVAILABLE,
    ) or (e.kind == ToolErrorKind.UPSTREAM_ERROR and (e.status or 0) >= 500)


def tool_gate(settings: Settings) -> AdaptiveGate:
    """The shared gate every outbound Ollagraph call passes through. Lazy, so it
    binds to the running loop (mirrors ingest/governor.py)."""
    global _gate
    if _gate is None:
        _gate = AdaptiveGate(
            settings.ollagraph_max_connections, settings.ollagraph_min_concurrency
        )
    return _gate


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
        """Default-closed validation of the model's untrusted args.

        The rules MOVED to `app/tools/validate.py` unchanged. MCP became a
        second provider that forwards model-authored JSON to a third party, and
        a security check with two copies is a security check that drifts. Kept
        as a method so every existing call site and test is untouched.
        """
        validate_args(payload, input_schema)

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
        timeout_s = tool.timeout or _default
        if self._s.ai_search_hedge_enabled and tool.tool_id in SEARCH_TOOL_IDS:
            return await self._search(tool, url, payload, headers, timeout_s)
        return await self._request_once(tool, url, payload, headers, timeout_s)

    async def _search(
        self,
        tool: ToolDefinition,
        url: str,
        payload: dict,
        headers: dict,
        timeout_s: float,
    ) -> dict:
        """Web search, hedged while the provider is degraded.

        Healthy: ONE request, exactly the old path. Degraded (a recent window of
        attempts failing at >= `_SEARCH_DEGRADED_RATE`), with the gate at full
        width and room under the process-wide cap: the fan-out runs in parallel,
        the first success wins, the rest are cancelled. If every attempt fails, or
        the round runs out of time, the error is raised NON-retryable — the hedge
        WAS the retries, so the executor must not multiply it (at most `fanout`
        attempts per call, today's maximum of three). A 429 is never hedged into:
        it is raised as it arrived.
        """
        global _hedge_extra_in_flight
        fanout = max(1, self._s.ai_search_hedge_fanout)
        extra = 0
        gate_open = tool_gate(self._s).limit >= _HEDGE_MIN_GATE
        if fanout > 1 and gate_open and _search_degraded():
            room = _HEDGE_MAX_EXTRA_IN_FLIGHT - _hedge_extra_in_flight
            extra = min(fanout - 1, room)
        if extra <= 0:
            return await self._search_attempt(tool, url, payload, headers, timeout_s)
        _hedge_extra_in_flight += extra
        t0 = time.monotonic()
        # The round ends, NON-retryably, before the executor's own per-attempt
        # timeout (the same `timeout_s`) can fire: that TimeoutError IS retryable,
        # and a retried round would triple the attempts this exists to bound.
        deadline = t0 + max(_HEDGE_MIN_ROUND_S, timeout_s - _HEDGE_DEADLINE_MARGIN_S)
        tasks = [
            asyncio.ensure_future(
                self._search_attempt(tool, url, payload, headers, timeout_s)
            )
            for _ in range(1 + extra)
        ]
        failed = 0
        last: BaseException | None = None
        try:
            pending: set[asyncio.Future] = set(tasks)
            while pending:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    last = ToolError(
                        ToolErrorKind.TIMEOUT, "search timed out", tool_id=tool.tool_id
                    )
                    break
                done, pending = await asyncio.wait(
                    pending, timeout=remaining, return_when=asyncio.FIRST_COMPLETED
                )
                for t in done:
                    exc = t.exception()
                    if exc is None:
                        _log_hedge(len(tasks), failed, t0, ok=True)
                        return t.result()
                    if (
                        isinstance(exc, ToolError)
                        and exc.kind == ToolErrorKind.RATE_LIMITED
                    ):
                        raise exc
                    failed += 1
                    last = exc
            _log_hedge(len(tasks), failed, t0, ok=False)
            if isinstance(last, ToolError):
                raise ToolError(
                    last.kind,
                    last.message,
                    tool_id=last.tool_id,
                    status=last.status,
                    retryable=False,
                )
            raise last  # type: ignore[misc]  # a non-ToolError: surface it as-is
        finally:
            for t in tasks:
                if not t.done():
                    t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            _hedge_extra_in_flight -= extra

    async def _search_attempt(
        self,
        tool: ToolDefinition,
        url: str,
        payload: dict,
        headers: dict,
        timeout_s: float,
    ) -> dict:
        """One search request, its outcome recorded for the hedging window."""
        try:
            out = await self._request_once(tool, url, payload, headers, timeout_s)
        except ToolError as e:
            if _is_origin_failure(e):
                _record_search(True)
            raise
        _record_search(False)
        return out

    async def _request_once(
        self,
        tool: ToolDefinition,
        url: str,
        payload: dict,
        headers: dict,
        timeout_s: float,
    ) -> dict:
        """The single-request primitive: gate slot, request, normalization."""
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
                        read=timeout_s,
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
