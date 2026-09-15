"""Egress guard for every MCP / OAuth request: URL shape per request, address
policy per connection, socket pinned to the validated address, no env proxy.

WHAT THIS PROVES that `test_mcp_endpoint.py` cannot: the endpoint guard runs
once, before the connection. The OAuth SDK then follows six more URLs the
SERVER chooses. These tests drive the REAL httpx2 -> httpcore2 -> backend chain
with the resolver stubbed, so a hostile answer is refused at the layer that
would otherwise have opened the socket — with no socket ever opened.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from pathlib import Path
from typing import Any

import httpx2
import pytest

from app.mcp.endpoint import check_url_shape
from app.mcp.exceptions import McpConnectionError, McpErrorKind
from app.mcp.transport import (
    _catalogue_address_allowed,
    _guarded_backend,
    _loopback_address_allowed,
    _pinned_transport,
    _resolve_checked,
    build_guarded_client,
    build_http_client,
)
from tests.fakes.mcp_http import spec

pytestmark = pytest.mark.anyio

PUBLIC = "93.184.216.34"


def _addrinfo(*ips: str) -> list[tuple[Any, Any, int, str, tuple[str, int]]]:
    out: list[Any] = []
    for ip in ips:
        family = socket.AF_INET6 if ":" in ip else socket.AF_INET
        out.append((family, socket.SOCK_STREAM, 6, "", (ip, 443)))
    return out


def _stub_resolver(monkeypatch: Any, *ips: str) -> None:
    import anyio

    async def fake(host: Any, port: Any, **_: Any) -> Any:
        return _addrinfo(*ips)

    monkeypatch.setattr(anyio, "getaddrinfo", fake)


# --------------------------------------------------------- the URL shape hook
@pytest.mark.parametrize(
    "url",
    [
        "http://93.184.216.34/mcp",
        "https://93.184.216.34:8080/mcp",
        "https://user:pw@93.184.216.34/mcp",
        "https://93.184.216.34/mcp?api_key=abc",
        "https://93.184.216.34/mcp?x-api-key=abc",
        "https://93.184.216.34/mcp?apikey=abc",
        "https://93.184.216.34/token?code=abc",
        "https://93.184.216.34/mcp?client_secret=abc",
        "https://93.184.216.34/mcp?refresh_token=abc",
        "https://93.184.216.34/mcp?sig=abc",
        "https://93.184.216.34/mcp?SIGNATURE=abc",
        "https:///mcp",
        "",
    ],
)
def test_check_url_shape_refuses(url: str) -> None:
    with pytest.raises(McpConnectionError) as info:
        check_url_shape(url)
    assert info.value.kind == McpErrorKind.ENDPOINT_REJECTED


@pytest.mark.parametrize(
    "url",
    [
        "https://93.184.216.34/mcp",
        "https://93.184.216.34:443/mcp",
        "https://example.com/.well-known/oauth-authorization-server",
        "https://example.com/mcp?page=2&cursor=abc",
    ],
)
def test_check_url_shape_accepts(url: str) -> None:
    assert check_url_shape(url) == url


async def test_the_hook_refuses_before_the_transport_sees_the_request() -> None:
    """A plain-http or credential-bearing URL never reaches the socket layer,
    whatever the SDK asked for."""
    seen: list[str] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(str(request.url))
        return httpx2.Response(200, json={})

    client = build_http_client(
        spec(), {}, _Recorder(), transport=httpx2.MockTransport(handler)
    )
    async with client:
        for url in (
            "http://93.184.216.34/.well-known/oauth-protected-resource",
            "https://93.184.216.34:8443/register",
            "https://93.184.216.34/token?client_secret=x",
        ):
            with pytest.raises(McpConnectionError):
                await client.get(url)
        # The same client still serves a legitimate URL.
        response = await client.get("https://93.184.216.34/mcp")
        assert response.status_code == 200
    assert seen == ["https://93.184.216.34/mcp"]


# ------------------------------------------------------- the address policy
@pytest.mark.parametrize(
    "answer",
    [
        ("127.0.0.1",),
        ("10.0.0.5",),
        ("172.16.70.25",),
        ("192.168.1.9",),
        ("169.254.169.254",),
        ("100.64.0.1",),
        ("::1",),
        ("fd00:ec2::254",),
        ("::ffff:10.0.0.5",),
        (PUBLIC, "10.0.0.5"),  # split horizon: one good address does not save it
        ("10.0.0.5", PUBLIC),
    ],
)
async def test_resolver_answers_inside_are_refused(monkeypatch: Any, answer) -> None:
    _stub_resolver(monkeypatch, *answer)
    import httpcore2

    with pytest.raises(httpcore2.ConnectError, match="blocked address"):
        await _resolve_checked("internal.example", 443, _catalogue_address_allowed)


async def test_unresolvable_host_is_refused_not_dialled(monkeypatch: Any) -> None:
    import anyio
    import httpcore2

    async def fake(host: Any, port: Any, **_: Any) -> Any:
        raise socket.gaierror("no such host")

    monkeypatch.setattr(anyio, "getaddrinfo", fake)
    with pytest.raises(httpcore2.ConnectError):
        await _resolve_checked("nope.example", 443, _catalogue_address_allowed)


async def test_public_answers_pass_and_are_returned_as_literals(
    monkeypatch: Any,
) -> None:
    _stub_resolver(monkeypatch, PUBLIC, "2606:2800:220:1:248:1893:25c8:1946")
    got = await _resolve_checked("example.com", 443, _catalogue_address_allowed)
    assert [str(ip) for ip in got] == [PUBLIC, "2606:2800:220:1:248:1893:25c8:1946"]


async def test_the_socket_is_dialled_on_the_validated_literal(monkeypatch: Any) -> None:
    """THE PINNING PROPERTY. httpcore is handed the address that passed policy,
    never the hostname, so a second DNS answer can never move the socket."""
    import httpcore2

    _stub_resolver(monkeypatch, PUBLIC)
    dialled: list[tuple[str, int]] = []

    async def fake_connect(self: Any, host: str, port: int, **_: Any) -> str:
        dialled.append((host, port))
        return "stream"

    monkeypatch.setattr(httpcore2.AnyIOBackend, "connect_tcp", fake_connect)
    backend = _guarded_backend(_catalogue_address_allowed)
    assert await backend.connect_tcp("example.com", 443, timeout=1.0) == "stream"
    assert dialled == [(PUBLIC, 443)]


async def test_a_private_answer_never_reaches_connect(monkeypatch: Any) -> None:
    import httpcore2

    _stub_resolver(monkeypatch, "10.0.0.5")
    dialled: list[str] = []

    async def fake_connect(self: Any, host: str, port: int, **_: Any) -> str:
        dialled.append(host)
        return "stream"

    monkeypatch.setattr(httpcore2.AnyIOBackend, "connect_tcp", fake_connect)
    backend = _guarded_backend(_catalogue_address_allowed)
    with pytest.raises(httpcore2.ConnectError):
        await backend.connect_tcp("internal.example", 443, timeout=1.0)
    assert dialled == []


async def test_the_gateway_policy_is_the_inverse(monkeypatch: Any) -> None:
    """Loopback only for the local gateway; a public answer is REFUSED there,
    which is the failure direction `assert_gateway_url` documents."""
    import httpcore2

    _stub_resolver(monkeypatch, PUBLIC)
    with pytest.raises(httpcore2.ConnectError):
        await _resolve_checked("gateway.example", 8811, _loopback_address_allowed)
    _stub_resolver(monkeypatch, "127.0.0.1")
    got = await _resolve_checked("localhost", 8811, _loopback_address_allowed)
    assert str(got[0]) == "127.0.0.1"


# ------------------------------------------- the real client, end to end
async def test_the_production_client_refuses_a_rebound_host(monkeypatch: Any) -> None:
    """No `transport=` override: the real pinned transport, the real pool, the
    real backend. The resolver says 10.0.0.5; the request dies in the backend
    with no socket opened."""
    _stub_resolver(monkeypatch, "10.0.0.5")
    client = build_http_client(
        spec(url="https://internal.example/mcp"), {}, _Recorder()
    )
    async with client:
        with pytest.raises(httpx2.ConnectError, match="blocked address"):
            await client.get("https://internal.example/mcp")


async def test_the_guarded_client_refuses_a_rebound_host(monkeypatch: Any) -> None:
    _stub_resolver(monkeypatch, "169.254.169.254")
    async with build_guarded_client(5.0) as client:
        with pytest.raises(httpx2.ConnectError, match="blocked address"):
            await client.get("https://metadata.example/latest/meta-data/")


def test_the_pinned_transport_actually_carries_the_guarded_backend() -> None:
    """Guards the private-attribute seam: an httpx2 upgrade that renames `_pool`
    would otherwise silently revert to the unguarded resolver."""
    transport = _pinned_transport(_catalogue_address_allowed)
    backend = transport._pool._network_backend
    assert type(backend).__name__ == "GuardedBackend"
    assert backend.allowed_policy is _catalogue_address_allowed


def test_env_proxies_are_ignored(monkeypatch: Any) -> None:
    """`HTTPS_PROXY` in the service environment must not become a hop that
    every MCP request and every token exchange rides through."""
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:9")
    for client in (
        build_guarded_client(),
        build_http_client(spec(), {}, _Recorder()),
    ):
        assert client._mounts == {}, "a proxy mount was installed from the environment"
        # Bounded (H-08) over pinned (M-02): both layers, in that order.
        assert type(client._transport).__name__ == "BoundedTransport"


def test_no_bare_httpx2_client_is_built_outside_the_transport_module() -> None:
    """Every MCP / OAuth client comes from `transport.py`, so every one of them
    is guarded. A new `httpx2.AsyncClient(` anywhere else is a new unguarded
    egress path and fails this test."""
    root = Path(__file__).resolve().parents[1] / "app"
    offenders = []
    for path in [*(root / "mcp").rglob("*.py"), root / "routers" / "mcp_oauth.py"]:
        if path.name == "transport.py":
            continue
        text = path.read_text(encoding="utf-8")
        if re.search(r"httpx2\.AsyncClient\(", text):
            offenders.append(str(path.relative_to(root)))
    assert offenders == []


def test_address_policy_is_ssrf_policy() -> None:
    """One matrix, two enforcement points: the backend's policy IS ssrf.py's."""
    from app.ssrf import address_is_forbidden

    for text in ("10.0.0.5", "169.254.169.254", "127.0.0.1", "::1", "100.64.0.1"):
        ip = ipaddress.ip_address(text)
        assert address_is_forbidden(ip)
        assert not _catalogue_address_allowed(ip)
    assert _catalogue_address_allowed(ipaddress.ip_address(PUBLIC))


class _Recorder:
    """Stands in for `StatusRecorder`: the response hook is not under test."""

    async def __call__(self, response: Any) -> None:
        return None
