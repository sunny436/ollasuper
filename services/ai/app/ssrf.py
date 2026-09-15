"""SSRF boundary for model-supplied URLs before they leave OllaSuper.

WHERE THIS SITS. OllaSuper's own outbound HTTP always goes to a FIXED host
(ollagraph_base_url + a path from the trusted spec), so the model cannot redirect
OUR request — there is no SSRF against this infrastructure. The risk is different:
a tool payload can carry a `url` FIELD that Ollagraph's server then fetches. A
prompt injection could aim that at a loopback / private / cloud-metadata target.
We do not rely on Ollagraph to defend itself — this refuses to SEND such a URL.

WHAT IT ENFORCES (default-closed):
  * scheme is http/https only (no file:, gopher:, dict:, ftp:, data:, ...);
  * no embedded credentials (user:pass@ - a classic parser-confusion bypass);
  * a real host, and an explicit port only if 80/443 (blocks :3210 Convex, :6379
    redis, :8770 the AI plane, :22, ... internal services on odd ports);
  * DNS is RESOLVED and EVERY returned address is checked - so localhost,
    foo.nip.io->127.0.0.1, a decimal/octal/hex IP that glibc expands, and an
    A-record that points inside are all caught on the resolved IP, not the string;
  * loopback, private (RFC1918/ULA), link-local, CGNAT (100.64/10), multicast,
    reserved, unspecified, and cloud metadata (169.254.169.254, fd00:ec2::254)
    are all refused, in v4 and v6 (incl. IPv4-mapped v6).

HONEST RESIDUAL (documented, not hidden): the actual fetch runs on Ollagraph, and
we cannot pin the socket to the IP we validated. A DNS-REBINDING attacker who
returns a public IP to our resolver and an internal IP to Ollagraph's, within the
TOCTOU window, could still slip past - but that targets OLLAGRAPH's network, needs
attacker-controlled authoritative DNS, and does not reach OllaSuper's own hosts.
Everything checkable from this side is checked; that specific race is Ollagraph's
to close and is called out rather than papered over.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

_ALLOWED_SCHEMES = {"http", "https"}
_ALLOWED_PORTS = {80, 443}
_METADATA = {
    ipaddress.ip_address("169.254.169.254"),
    ipaddress.ip_address("fd00:ec2::254"),
}
_CGNAT = ipaddress.ip_network("100.64.0.0/10")


class SsrfError(ValueError):
    """A URL that must never be forwarded to an external fetcher."""


def _ip_is_forbidden(ip: ipaddress._BaseAddress) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if ip in _METADATA:
        return True
    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return True
    if isinstance(ip, ipaddress.IPv4Address) and ip in _CGNAT:
        return True
    return not ip.is_global


def address_is_forbidden(ip: ipaddress._BaseAddress) -> bool:
    """The address policy, exported for a transport that pins the socket to the
    address it validated (`app/mcp/transport.py`). ONE policy, two enforcement
    points: this module checks a URL before it is sent anywhere; the MCP
    transport checks every resolved address at connect time and dials only a
    literal that passed. A second copy of the matrix would be a second thing
    to keep correct."""
    return _ip_is_forbidden(ip)


def _resolved_ips(host: str, port: int) -> list[ipaddress._BaseAddress]:
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise SsrfError(f"could not resolve host: {host}") from e
    ips = [ipaddress.ip_address(info[4][0]) for info in infos]
    if not ips:
        raise SsrfError(f"host resolved to nothing: {host}")
    return ips


def assert_public_url(url: str) -> None:
    """Raise SsrfError unless `url` is an http(s) URL whose host resolves only to
    public, non-metadata addresses on a standard port. Synchronous (does DNS)."""
    if not isinstance(url, str) or not url:
        raise SsrfError("empty url")
    parts = urlsplit(url.strip())
    if parts.scheme.lower() not in _ALLOWED_SCHEMES:
        raise SsrfError(f"scheme not allowed: {parts.scheme!r}")
    if parts.username or parts.password or "@" in (parts.netloc or ""):
        raise SsrfError("credentials in url are not allowed")
    host = parts.hostname
    if not host:
        raise SsrfError("url has no host")
    try:
        port = parts.port
    except ValueError as e:
        raise SsrfError("invalid port") from e
    if port is not None and port not in _ALLOWED_PORTS:
        raise SsrfError(f"port not allowed: {port}")
    effective_port = port or (443 if parts.scheme.lower() == "https" else 80)

    stripped = host.strip("[]")
    try:
        literal = ipaddress.ip_address(stripped)
    except ValueError:
        literal = None
    ips = [literal] if literal is not None else _resolved_ips(host, effective_port)
    for ip in ips:
        if _ip_is_forbidden(ip):
            raise SsrfError(f"url resolves to a blocked address: {ip}")


def _walk_urls(value: object) -> list[str]:
    found: list[str] = []
    if isinstance(value, str):
        v = value.strip().lower()
        if v.startswith("http://") or v.startswith("https://"):
            found.append(value.strip())
    elif isinstance(value, dict):
        for v in value.values():
            found.extend(_walk_urls(v))
    elif isinstance(value, list):
        for v in value:
            found.extend(_walk_urls(v))
    return found


async def assert_payload_urls_safe(payload: object) -> None:
    """Walk a tool payload and SSRF-check every http(s) URL in it. Runs the
    blocking DNS work off the event loop. Refuses the whole call if any URL is
    unsafe - a partial call could still exfiltrate."""
    urls = _walk_urls(payload)
    if not urls:
        return

    def _check_all() -> None:
        for u in urls:
            assert_public_url(u)

    await asyncio.to_thread(_check_all)
