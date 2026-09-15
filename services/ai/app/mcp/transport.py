"""Build the HTTP client and the transport FACTORY for one connection.

THIS FILE EXISTS FOR TWO REASONS.

1. The two remote MCP transports take credentials in incompatible ways, and
   nothing above this layer should have to know that.

    streamable_http_client(url, *, http_client, terminate_on_close)
        -> no `headers` parameter, no `auth` parameter. Authentication can ONLY
           be injected by handing it a pre-built httpx2 client.
    sse_client(url, headers=..., timeout=..., auth=..., ...)
        -> takes headers directly, and builds its own client from a factory.

   `Client(server=<url string>)` is therefore NEVER used: the SDK would construct
   the transport with no `http_client`, so it could carry no Authorization
   header at all.

2. EVERY BYTE THAT LEAVES FOR AN MCP SERVER OR ITS AUTHORIZATION SERVER GOES
   THROUGH ONE GUARDED TRANSPORT. The OAuth SDK follows URLs the SERVER chooses
   — protected-resource metadata, authorization-server metadata, dynamic client
   registration, token, refresh, revocation — and it does so on the same httpx2
   client as the MCP endpoint. A pre-flight check of the endpoint alone
   therefore covered one URL out of seven. Here the guard is structural:

     * a REQUEST HOOK runs `check_url_shape` on every request (https, :443,
       no userinfo, no credential-shaped query key) — DNS-free, so it is safe
       on the event loop;
     * a NETWORK BACKEND resolves each hostname itself, checks EVERY returned
       address against `app/ssrf.py::address_is_forbidden`, and then dials the
       validated literal. The address that was checked is the address the
       socket goes to, which closes the resolve-then-dial (DNS rebinding)
       window that a URL check can never close. TLS is unaffected: httpcore
       takes the SNI / certificate hostname from the request's origin, not
       from the address it dialled (verified in `httpcore2/_async/connection.py`).
     * `trust_env=False` on both the client and the transport, so no
       `HTTPS_PROXY` in the service's environment can reroute a request, and no
       env-supplied CA can be trusted.

   The gateway (local, loopback) path gets the SAME machinery with the OPPOSITE
   address policy: loopback only, the failure direction `assert_gateway_url`
   documents.

WHY A FACTORY AND NOT A TRANSPORT. `streamable_http_client` is decorated with
`@asynccontextmanager`, so the object it returns is SINGLE-USE — entering it a
second time raises. A pooled session that reconnects must build a fresh one each
time, which a stored instance cannot do.

ONE httpx CLIENT PER SESSION, NEVER SHARED. A shared client would pool TCP
connections and cookies across tenants — a cookie-authenticated server would
then serve one user's session to another — and its `StatusRecorder` would
attribute one tenant's 401 to another tenant's call. The isolation here is
structural, not conventional.

REDIRECTS ARE THE SDK'S. `stream_within_origin` follows a redirect only within
the endpoint's own origin (or http->https on the same host), and REFUSES an
https->http downgrade. It does not consult `follow_redirects`, so setting it
here would be theatre. Verified by reading `mcp/shared/_httpx_utils.py`. Every
hop it does follow is still a request, so the hook and the backend see it.

TLS IS NEVER WEAKENED. There is no `verify=` argument anywhere in this module,
and a test asserts the string does not appear in `app/mcp/`.

3. RESPONSES ARE BOUNDED ON THE WIRE, before the SDK buffers or parses a byte
   (audit H-08). `adapter.py` bounds what reaches the MODEL, but by then the
   SDK's `response.aread()` had already materialised the whole body — 200 MB of
   JSON, or 1 MB of gzip that decodes to 1 GB. So `_bounded_transport` sits
   above the pinned transport and:

     * refuses any `Content-Encoding` other than identity (the client asks for
       identity; a server that compresses anyway is refused rather than
       decoded, because a compressed body's decoded size is unknowable);
     * refuses a `Content-Length` over the cap before reading the body;
     * wraps the body stream in a counter that cuts the stream the moment the
       cap is crossed — for a JSON body, for the SSE stream that answers a
       POST, and for the standalone GET stream (which is long-lived and gets
       the largest cap; the SDK reconnects when it is cut).

   The per-EVENT bound stays httpx2's own `EventSource` default (1 MiB); a
   test pins it so a library bump cannot raise it silently.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

from app.logging import get_logger
from app.mcp.exceptions import McpConnectionError, McpErrorKind
from app.mcp.models import McpConnectionSpec
from app.mcp.status import StatusRecorder

log = get_logger(__name__)

__all__ = [
    "ResponseLimits",
    "TransportFactory",
    "build_guarded_client",
    "build_http_client",
    "build_transport_factory",
]


@dataclass(frozen=True)
class ResponseLimits:
    """Byte caps applied on the wire. Defaults match `Settings`."""

    max_response_bytes: int = 8 * 1024 * 1024
    max_stream_bytes_per_request: int = 16 * 1024 * 1024
    max_listen_stream_bytes: int = 64 * 1024 * 1024


#: Sent on every client so a server has no reason to compress; a server that
#: compresses anyway is refused by `_bounded_transport`.
_IDENTITY_ONLY = {"Accept-Encoding": "identity"}

TransportFactory = Callable[[], Any]

# The SDK's own defaults, restated because we build the client instead of using
# `create_mcp_http_client`: 30s connect/write/pool, 300s read. The long read is
# not a mistake -- a Streamable HTTP GET stream is held open deliberately, and a
# short read timeout would tear down a healthy idle session.
_CONNECT_TIMEOUT_S = 30.0
_STREAM_READ_TIMEOUT_S = 300.0

#: `McpConnectionSpec.endpoint_trust` for a local gateway; the only value that
#: selects the loopback policy. Restated here (rather than imported from
#: `local/gateway.py`) so this module has no dependency on the local package.
_GATEWAY_TRUST = "gateway"


# --------------------------------------------------------------- the guard
def _catalogue_address_allowed(ip: ipaddress._BaseAddress) -> bool:
    from app.ssrf import address_is_forbidden  # noqa: PLC0415 -- one policy

    return not address_is_forbidden(ip)


def _loopback_address_allowed(ip: ipaddress._BaseAddress) -> bool:
    return ip.is_loopback


def _guarded_backend(allowed: Callable[[ipaddress._BaseAddress], bool]) -> Any:
    """A network backend that dials only an address `allowed` approved.

    Built inside a function because `httpcore2` is imported lazily (it is the
    SDK's HTTP stack, not the repo's).
    """
    import httpcore2  # noqa: PLC0415

    class GuardedBackend(httpcore2.AnyIOBackend):
        """Resolve here, validate every address, dial the literal that passed."""

        allowed_policy = staticmethod(allowed)

        async def connect_tcp(
            self,
            host: str,
            port: int,
            timeout: float | None = None,  # noqa: ASYNC109 -- httpcore's own signature
            local_address: str | None = None,
            socket_options: Any = None,
        ) -> Any:
            addresses = await _resolve_checked(host, port, self.allowed_policy)
            # THE PINNED DIAL: the literal that was just validated, never the
            # hostname again. SNI and certificate verification still use the
            # origin's hostname (httpcore passes it separately).
            return await super().connect_tcp(
                str(addresses[0]),
                port,
                timeout=timeout,
                local_address=local_address,
                socket_options=socket_options,
            )

    return GuardedBackend()


async def _resolve_checked(
    host: str, port: int, allowed: Callable[[ipaddress._BaseAddress], bool]
) -> list[ipaddress._BaseAddress]:
    """Resolve `host` and refuse unless EVERY address passes `allowed`.

    Every address, not the first: a rebinding or split-horizon answer that mixes
    one public address with one private one is refused outright rather than
    dialled on the public half. Separate from the backend class so the policy is
    testable with a stubbed resolver and no socket at all.
    """
    import anyio  # noqa: PLC0415
    import httpcore2  # noqa: PLC0415

    try:
        infos = await anyio.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, OSError, UnicodeError) as exc:
        raise httpcore2.ConnectError("could not resolve host") from exc

    addresses: list[ipaddress._BaseAddress] = []
    for info in infos:
        try:
            addresses.append(ipaddress.ip_address(str(info[4][0]).split("%", 1)[0]))
        except ValueError:
            continue
    if not addresses:
        raise httpcore2.ConnectError("host resolved to nothing")
    for address in addresses:
        if not allowed(address):
            # The host, never the address: the refusal must not become an
            # internal-network oracle (same rule as `endpoint._redact_addresses`).
            log.warning(
                "mcp.egress_refused",
                extra={"host": host, "port": port, "rule": "address policy"},
            )
            raise httpcore2.ConnectError("blocked address")
    return addresses


def _pinned_transport(allowed: Callable[[ipaddress._BaseAddress], bool]) -> Any:
    """`httpx2.AsyncHTTPTransport` whose connection pool uses the guarded backend.

    httpx2 exposes no `network_backend` parameter, so the pool the base class
    built is replaced with one that does. `test_mcp_egress.py` asserts the
    replacement took, so an httpx2 upgrade that renames `_pool` fails a test
    rather than silently reverting to the unguarded resolver.
    """
    import httpcore2  # noqa: PLC0415
    import httpx2  # noqa: PLC0415

    class PinnedTransport(httpx2.AsyncHTTPTransport):
        def __init__(self) -> None:
            # `trust_env=False`: no proxy from the environment, no env CA.
            super().__init__(trust_env=False, retries=0, http1=True, http2=False)
            # One session's client: a handful of connections is plenty, and a
            # low ceiling is itself a bound on what a hostile server can make
            # us hold open.
            self._pool = httpcore2.AsyncConnectionPool(
                ssl_context=httpx2.create_ssl_context(trust_env=False),
                max_connections=8,
                max_keepalive_connections=4,
                keepalive_expiry=60.0,
                http1=True,
                http2=False,
                retries=0,
                network_backend=_guarded_backend(allowed),
            )

    return PinnedTransport()


def _too_large(detail: str) -> McpConnectionError:
    return McpConnectionError(McpErrorKind.RESPONSE_TOO_LARGE, detail)


def _bounded_transport(inner: Any, limits: ResponseLimits) -> Any:
    """Wrap `inner` so every response body is counted and cut at its cap."""
    import httpx2  # noqa: PLC0415

    class CountingStream(httpx2.AsyncByteStream):
        """The body, cut the moment the cap is crossed. Nothing is buffered."""

        def __init__(self, stream: Any, cap: int, what: str) -> None:
            self._stream = stream
            self._cap = cap
            self._what = what
            self._seen = 0

        async def __aiter__(self) -> AsyncIterator[bytes]:
            async for chunk in self._stream:
                self._seen += len(chunk)
                if self._seen > self._cap:
                    log.warning(
                        "mcp.response_cut",
                        extra={"what": self._what, "cap": self._cap},
                    )
                    raise _too_large(
                        f"{self._what} exceeded {self._cap} bytes and was cut"
                    )
                yield chunk

        async def aclose(self) -> None:
            await self._stream.aclose()

    class BoundedTransport(httpx2.AsyncBaseTransport):
        async def handle_async_request(self, request: Any) -> Any:
            response = await inner.handle_async_request(request)
            headers = httpx2.Headers(response.headers)
            encoding = headers.get("content-encoding", "").strip().lower()
            if encoding and encoding != "identity":
                await response.aclose()
                raise _too_large(
                    f"compressed response ({encoding}) refused; "
                    "the decoded size of a compressed body cannot be bounded"
                )
            content_type = headers.get("content-type", "").lower()
            streaming = content_type.startswith("text/event-stream")
            if streaming and request.method.upper() == "GET":
                cap, what = limits.max_listen_stream_bytes, "listen stream"
            elif streaming:
                cap, what = limits.max_stream_bytes_per_request, "response stream"
            else:
                cap, what = limits.max_response_bytes, "response body"
            declared = headers.get("content-length", "")
            if declared.isdigit() and int(declared) > cap:
                await response.aclose()
                raise _too_large(
                    f"{what} declares {declared} bytes, over the {cap} byte cap"
                )
            response.stream = CountingStream(response.stream, cap, what)
            return response

        async def aclose(self) -> None:
            await inner.aclose()

    return BoundedTransport()


def _request_guard(trust: str) -> Callable[[Any], Any]:
    """The per-request hook: the DNS-free URL policy for this trust level."""
    if trust == _GATEWAY_TRUST:
        from app.mcp.local.gateway import assert_gateway_url  # noqa: PLC0415

        async def _gateway_guard(request: Any) -> None:
            assert_gateway_url(str(request.url))

        return _gateway_guard

    from app.mcp.endpoint import check_url_shape  # noqa: PLC0415

    async def _catalogue_guard(request: Any) -> None:
        check_url_shape(str(request.url))

    return _catalogue_guard


def _guarded_kwargs(trust: str, limits: ResponseLimits | None = None) -> dict[str, Any]:
    """The client kwargs that make egress guarded, for any client this module
    hands out. One place, so `build_http_client` and `build_guarded_client`
    cannot disagree about what "guarded" means."""
    allowed = (
        _loopback_address_allowed
        if trust == _GATEWAY_TRUST
        else _catalogue_address_allowed
    )
    return {
        "trust_env": False,
        "transport": _bounded_transport(
            _pinned_transport(allowed), limits or ResponseLimits()
        ),
        "event_hooks": {"request": [_request_guard(trust)]},
    }


# -------------------------------------------------------------- the clients
def build_http_client(
    spec: McpConnectionSpec,
    headers: dict[str, str],
    recorder: StatusRecorder,
    *,
    transport: Any = None,
    auth: Any = None,
    limits: ResponseLimits | None = None,
) -> Any:
    """One tenant's httpx2 client: their credentials, their status recorder.

    `headers` is the resolver's output and is NOT stored anywhere: it lives on
    this client for the life of this session and is never written to a row, a
    log line or a `ToolDefinition`.

    `auth` is an httpx2 `Auth` — in practice the SDK's `OAuthClientProvider`,
    which drives discovery, PKCE, token exchange and refresh from inside the
    request cycle. It is mutually exclusive with a static `headers` credential
    in practice, but not forbidden here: a server could want both a bearer token
    and an API-key header, and refusing that combination would be inventing a
    restriction no specification imposes.

    `transport` swaps the SOCKET LAYER ONLY and is never passed in production.
    It exists so the test suite can point a real protocol session at an
    in-process ASGI MCP server: everything above the socket -- the headers, the
    timeouts, the status hook, the request guard, TLS handling -- stays exactly
    as built here, so a test cannot drift away from the client production
    actually uses. Note what it is NOT: there is no `verify=` argument in this
    module, and no way to reach one, so no test can weaken TLS to make a
    fixture work. What a test-supplied transport DOES bypass is the address
    policy (there is no socket to pin), which is why `test_mcp_egress.py`
    exercises the guarded backend directly.
    """
    import httpx2  # noqa: PLC0415 -- the SDK's HTTP stack, not the repo's httpx

    trust = getattr(spec, "endpoint_trust", "catalogue") or "catalogue"
    guarded = _guarded_kwargs(trust, limits)
    kwargs: dict[str, Any] = {
        "headers": {**dict(headers), **_IDENTITY_ONLY},
        # The CONFIGURED connect timeout (audit M-13): an earlier `max(30, cfg)`
        # meant a shorter operator value was silently ignored.
        "timeout": httpx2.Timeout(
            spec.connect_timeout_s or _CONNECT_TIMEOUT_S,
            read=_STREAM_READ_TIMEOUT_S,
        ),
        "trust_env": False,
        # The request guard first; then the hook the SDK's error path erases the
        # status from (see status.py).
        "event_hooks": {
            "request": list(guarded["event_hooks"]["request"]),
            "response": [recorder],
        },
        "transport": guarded["transport"],
    }
    if transport is not None:
        # A test-supplied socket layer still gets the byte caps: the counting
        # wrapper is what the suite exercises with oversized fixtures.
        kwargs["transport"] = _bounded_transport(transport, limits or ResponseLimits())
    if auth is not None:
        kwargs["auth"] = auth
    return httpx2.AsyncClient(**kwargs)


def build_guarded_client(timeout_s: float = 15.0) -> Any:
    """A bare guarded client for the one-shot OAuth paths (probe, revoke).

    Same request guard, same pinned transport, no credential, no recorder. It
    exists so that no caller in `app/mcp` or `app/routers/mcp_oauth.py` has a
    reason to write `httpx2.AsyncClient(` itself — a test asserts none does.
    """
    import httpx2  # noqa: PLC0415

    return httpx2.AsyncClient(
        timeout=httpx2.Timeout(timeout_s),
        headers=dict(_IDENTITY_ONLY),
        **_guarded_kwargs("catalogue"),
    )


# ------------------------------------------------------------- the factory
def build_transport_factory(
    spec: McpConnectionSpec,
    http_client: Any,
    headers: dict[str, str],
) -> TransportFactory:
    """Return a zero-arg callable producing a FRESH transport each call.

    The transport is single-use (see the module docstring), so reconnecting
    means calling this again -- never re-entering the previous one.
    """
    if spec.transport == "streamable-http":

        def _streamable() -> Any:
            from mcp.client.streamable_http import (  # noqa: PLC0415
                streamable_http_client,
            )

            return streamable_http_client(
                spec.endpoint_url,
                http_client=http_client,
                # DELETE the server-side session on a clean close. Without it a
                # pool that churns 64 slots leaves 64 orphaned sessions on
                # someone else's service.
                terminate_on_close=True,
            )

        return _streamable

    if spec.transport == "sse":

        def _sse() -> Any:
            from mcp.client.sse import sse_client  # noqa: PLC0415

            # sse_client builds its OWN client from a factory, so the headers
            # and the recorder have to be threaded in differently from the
            # Streamable HTTP path. This asymmetry is the whole point of the
            # module.
            def _factory(
                headers: dict[str, str] | None = None,
                timeout: Any = None,
                auth: Any = None,
            ) -> Any:
                return http_client

            return sse_client(
                spec.endpoint_url,
                headers=dict(headers),
                timeout=spec.connect_timeout_s,
                sse_read_timeout=_STREAM_READ_TIMEOUT_S,
                httpx_client_factory=_factory,
            )

        return _sse

    # Unreachable via McpConnectionSpec, which refuses a non-remote transport at
    # construction. Kept so a future transport cannot be added to the enum and
    # silently fall through to nothing.
    raise ValueError(f"unsupported transport: {spec.transport!r}")
