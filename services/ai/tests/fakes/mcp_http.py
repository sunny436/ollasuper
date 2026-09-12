"""Real Streamable HTTP MCP servers, in-process, over zero sockets.

HOW. `MCPServer.streamable_http_app()` is a Starlette app; httpx2 can speak to a
Starlette app directly through `ASGITransport`; and the SDK's
`streamable_http_client` accepts a pre-built httpx2 client. So the ENTIRE real
protocol runs — `server/discover`, initialize, negotiation, `tools/list`,
`tools/call`, `notifications/cancelled`, the session-id header, the terminating
DELETE — with no socket, no port, no certificate and no network. Offline CI safe.

WHY THE HOST IS A LITERAL PUBLIC IP. The endpoint guard (`app/mcp/endpoint.py`)
is NOT bypassed in these tests: it runs for real against every fixture URL. A
literal IP is checked without DNS, and 93.184.216.34 is public, so the guard
passes offline and the tests exercise the same code path production does. Using
a fake hostname would have forced either a DNS dependency or a test-only bypass,
and a security guard that tests skip is a security guard that rots.

WHY `TransportSecuritySettings` IS PASSED. `streamable_http_app()` turns DNS
rebinding protection ON by default, so without an `allowed_hosts` entry every
request answers 421 Misdirected Request and the failure looks like a protocol
bug. Found the hard way.

NOTHING HERE REACHES OUT. No filesystem, no shell, no network, no credential.
The tools are arithmetic and echo.
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import anyio
from pydantic import BaseModel


class Filter(BaseModel):
    """A nested argument model.

    MODULE SCOPE IS REQUIRED. This file uses `from __future__ import
    annotations`, so every annotation is a string, and the SDK resolves tool
    signatures with `inspect.signature(..., eval_str=True)` against MODULE
    globals. A function-local class raises `InvalidSignature`.
    """

    label: str
    limit: int | None = None


# A public, routable literal — passes `assert_public_url` with no DNS lookup.
HOST = "93.184.216.34"
BASE_URL = f"https://{HOST}"
MCP_URL = f"{BASE_URL}/mcp"


@dataclass
class Traffic:
    """What the transport actually saw. Lets a test assert on round trips."""

    requests: list[tuple[str, str]] = field(default_factory=list)
    cancelled: list[str] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.requests)

    def reset(self) -> None:
        self.requests.clear()
        self.cancelled.clear()


def build_mcp_app(
    *,
    name: str = "fake",
    traffic: Traffic | None = None,
    tool_count: int = 0,
    big_schema: bool = False,
    nested: bool = False,
) -> tuple[Any, Traffic]:
    """A real MCP server behind a real Streamable HTTP app."""
    from mcp.server.mcpserver import MCPServer
    from mcp.server.transport_security import TransportSecuritySettings
    from mcp_types import ToolAnnotations

    traffic = traffic or Traffic()
    server = MCPServer(name=name)

    @server.tool(
        name="echo",
        description="Return the text you were given.",
        annotations=ToolAnnotations(read_only_hint=True),
    )
    def echo(text: str) -> str:
        return text

    @server.tool(
        name="add",
        description="Add two integers.",
        annotations=ToolAnnotations(read_only_hint=True),
    )
    def add(a: int, b: int) -> int:
        return a + b

    @server.tool(
        name="write_note",
        description="Claims to modify something.",
        annotations=ToolAnnotations(destructive_hint=True),
    )
    def write_note(note: str) -> str:
        return f"wrote: {note}"

    @server.tool(name="always_fails", description="Raise, to exercise error paths.")
    def always_fails() -> str:
        raise ValueError("deliberate test failure")

    @server.tool(name="slow", description="Sleep, so a caller can cancel it.")
    async def slow(seconds: float = 30.0) -> str:
        try:
            await anyio.sleep(seconds)
        except BaseException:
            # Records that the CLIENT's cancellation actually reached the
            # server. This is the only honest way to test §54: the protocol
            # notification is advisory, so the proof is that it arrived, not
            # that work stopped.
            traffic.cancelled.append("slow")
            raise
        return "finished"

    @server.tool(name="huge", description="Return a very large payload.")
    def huge(size: int = 500_000) -> str:
        return "A" * min(size, 2_000_000)

    if nested:
        @server.tool(name="search", description="Nested-argument tool.")
        def search(
            query: str,
            filters: Filter,
            tags: list[str] = [],  # noqa: B006 - the mutable default is the POINT
        ) -> str:
            # A list default is what real MCP servers write, and it is what
            # makes pydantic emit the `{"type":"array","default":[]}` node the
            # $defs regression depends on. Replacing it with None would change
            # the schema under test.
            return f"{query}:{filters.label}:{len(tags or [])}"

    if big_schema:

        @server.tool(name="fat", description="A tool with an enormous schema.")
        def fat(blob: str = "x" * 100_000) -> str:
            return "ok"

    for i in range(tool_count):
        # Distinct closures; the SDK reads __name__ so each needs its own.
        def _make(idx: int):
            def _tool(value: str = "") -> str:
                return f"{idx}:{value}"

            return _tool

        server.tool(name=f"gen_{i}", description=f"generated {i}")(_make(i))

    app = server.streamable_http_app(
        transport_security=TransportSecuritySettings(
            allowed_hosts=[HOST, f"{HOST}:443"],
            allowed_origins=[BASE_URL],
        )
    )
    return _counting(app, traffic), traffic


def build_colliding_app() -> tuple[Any, Traffic]:
    """A SECOND server exposing a tool name the first one also uses.

    `ToolRegistry._by_id` is a flat map that silently overwrites on collision,
    and `search`/`echo` exist on half the MCP ecosystem, so this is the case
    that has to be reachable from a test.
    """
    from mcp.server.mcpserver import MCPServer
    from mcp.server.transport_security import TransportSecuritySettings
    from mcp_types import ToolAnnotations

    traffic = Traffic()
    server = MCPServer(name="other")

    @server.tool(
        name="echo",
        description="A DIFFERENT echo, on a different server.",
        annotations=ToolAnnotations(read_only_hint=True),
    )
    def echo(text: str) -> str:
        return f"other:{text}"

    app = server.streamable_http_app(
        transport_security=TransportSecuritySettings(
            allowed_hosts=[HOST, f"{HOST}:443"], allowed_origins=[BASE_URL]
        )
    )
    return _counting(app, traffic), traffic


def _counting(app: Any, traffic: Traffic) -> Any:
    """Wrap an ASGI app so a test can count real HTTP round trips."""

    async def wrapped(scope, receive, send):
        if scope.get("type") == "http":
            traffic.requests.append((scope.get("method", ""), scope.get("path", "")))
        await app(scope, receive, send)

    # The Starlette lifespan lives on the inner app; expose it for `running`.
    wrapped.inner = app  # type: ignore[attr-defined]
    return wrapped


# ---------------------------------------------------------------- fault apps
def status_app(status: int, *, headers: dict[str, str] | None = None) -> Any:
    """An endpoint that answers one fixed HTTP status. For error classification:
    the SDK collapses 401/403/429/500/503 into one indistinguishable exception,
    so each has to be produced for real."""

    async def app(scope, receive, send):
        raw = [(b"content-type", b"application/json")]
        for key, value in (headers or {}).items():
            raw.append((key.encode(), value.encode()))
        await send({"type": "http.response.start", "status": status, "headers": raw})
        await send({"type": "http.response.body", "body": b'{"error":"fixture"}'})

    return app


def flaky_app(app, *, healthy_requests: int, then_status: int) -> Any:
    """Serve a REAL MCP server for the first N requests, then fail with a fixed
    status.

    Produces an ESTABLISHED-session failure, which is a different code path from
    a failed connect: a 404 at connect time means "there is no MCP endpoint
    here", the same 404 mid-session means "your session id expired". Same status,
    opposite remedy.
    """
    state = {"n": 0}
    body = b'{"error":"fixture"}'

    async def wrapped(scope, receive, send):
        if scope.get("type") != "http":
            await app(scope, receive, send)
            return
        state["n"] += 1
        if state["n"] <= healthy_requests:
            await app(scope, receive, send)
            return
        await send(
            {
                "type": "http.response.start",
                "status": then_status,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": body})

    wrapped.inner = getattr(app, "inner", app)  # type: ignore[attr-defined]
    return wrapped


def malformed_app() -> Any:
    """200 OK with a body that is not a valid initialize result."""

    async def app(scope, receive, send):
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": b'{"not":"jsonrpc"}'})

    return app


def redirect_app(location: str, status: int = 307) -> Any:
    """A redirect. The SDK follows one only within the endpoint's own origin and
    refuses an https->http downgrade; this proves we inherit that."""

    async def app(scope, receive, send):
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(b"location", location.encode())],
            }
        )
        await send({"type": "http.response.body", "body": b""})

    return app


def refusing_app(exc: BaseException | None = None) -> Any:
    """A transport that dies rather than answering — connection reset."""

    async def app(scope, receive, send):
        raise exc or ConnectionError("connection reset by peer")

    return app


# ------------------------------------------------------------------ plumbing
@contextlib.asynccontextmanager
async def running(app: Any) -> AsyncIterator[Any]:
    """Drive the Starlette lifespan an MCP app needs.

    `StreamableHTTPSessionManager` starts in the app's lifespan; without this
    every request fails in a way that looks like a protocol error.
    """
    inner = getattr(app, "inner", app)
    router = getattr(inner, "router", None)
    if router is None or not hasattr(router, "lifespan_context"):
        yield app  # a plain fault app has no lifespan
        return
    async with router.lifespan_context(inner):
        yield app


def patch_transport(monkeypatch: Any, app: Any) -> None:
    """Route the pool's httpx2 client at an in-process ASGI app.

    Patches the FACTORY, not the guard: `assert_dialable` still runs for real
    against the fixture URL, and the URL still has to pass it. Only the socket
    is replaced.
    """
    import httpx2

    import app.mcp.session as session_mod
    from app.mcp.transport import build_http_client as real_build

    def fake_build(spec, headers, recorder, **kwargs):
        # The PRODUCTION factory, with only the socket layer replaced. Headers,
        # timeouts, the status hook and any `auth=` come from the real code
        # path, so this fixture cannot drift away from the client production
        # builds.
        #
        # `**kwargs` is deliberate: an earlier version pinned the exact
        # parameter list, so adding `auth=` to the real factory broke fifty
        # tests with a signature error instead of a behavioural one.
        kwargs.setdefault("transport", httpx2.ASGITransport(app=app))
        return real_build(spec, headers, recorder, **kwargs)

    monkeypatch.setattr(session_mod, "build_http_client", fake_build)


def spec(
    *,
    connection_id: str = "conn-1",
    slug: str = "fake",
    user_id: str = "user-a",
    workspace_id: str = "ws-1",
    transport: str = "streamable-http",
    url: str = MCP_URL,
    trusted: bool = True,
    auth_kind: str = "none",
    **overrides: Any,
):
    """An `McpConnectionSpec` aimed at the in-process fixture."""
    from app.mcp.models import McpConnectionSpec, McpServerIdentity

    return McpConnectionSpec(
        connection_id=connection_id,
        identity=McpServerIdentity(slug=slug, display_name=slug, trusted=trusted),
        server_name=f"test.fixture/{slug}",
        version="1.0.0",
        transport=transport,
        endpoint_url=url,
        auth_kind=auth_kind,
        user_id=user_id,
        workspace_id=workspace_id,
        **overrides,
    )
