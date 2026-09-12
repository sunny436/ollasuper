"""Build the HTTP client and the transport FACTORY for one connection.

THIS FILE EXISTS FOR ONE REASON: the two remote MCP transports take credentials
in incompatible ways, and nothing above this layer should have to know that.

    streamable_http_client(url, *, http_client, terminate_on_close)
        -> no `headers` parameter, no `auth` parameter. Authentication can ONLY
           be injected by handing it a pre-built httpx2 client.
    sse_client(url, headers=..., timeout=..., auth=..., ...)
        -> takes headers directly, and builds its own client from a factory.

`Client(server=<url string>)` is therefore NEVER used: the SDK would construct
the transport with no `http_client`, so it could carry no Authorization header
at all.

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
here would be theatre. Verified by reading `mcp/shared/_httpx_utils.py`.

TLS IS NEVER WEAKENED. There is no `verify=` argument anywhere in this module,
and a test asserts the string does not appear in `app/mcp/`.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.mcp.models import McpConnectionSpec
from app.mcp.status import StatusRecorder

__all__ = ["TransportFactory", "build_http_client", "build_transport_factory"]

TransportFactory = Callable[[], Any]

# The SDK's own defaults, restated because we build the client instead of using
# `create_mcp_http_client`: 30s connect/write/pool, 300s read. The long read is
# not a mistake -- a Streamable HTTP GET stream is held open deliberately, and a
# short read timeout would tear down a healthy idle session.
_CONNECT_TIMEOUT_S = 30.0
_STREAM_READ_TIMEOUT_S = 300.0


def build_http_client(
    spec: McpConnectionSpec,
    headers: dict[str, str],
    recorder: StatusRecorder,
    *,
    transport: Any = None,
    auth: Any = None,
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
    timeouts, the status hook, TLS handling -- stays exactly as built here, so a
    test cannot drift away from the client production actually uses. Note what
    it is NOT: there is no `verify=` argument in this module, and no way to
    reach one, so no test can weaken TLS to make a fixture work.
    """
    import httpx2  # noqa: PLC0415 -- the SDK's HTTP stack, not the repo's httpx

    kwargs: dict[str, Any] = {
        "headers": dict(headers),
        "timeout": httpx2.Timeout(
            max(_CONNECT_TIMEOUT_S, spec.connect_timeout_s),
            read=_STREAM_READ_TIMEOUT_S,
        ),
        # The hook the SDK's error path erases the status from. See status.py.
        "event_hooks": {"response": [recorder]},
    }
    if transport is not None:
        kwargs["transport"] = transport
    if auth is not None:
        kwargs["auth"] = auth
    return httpx2.AsyncClient(**kwargs)


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
