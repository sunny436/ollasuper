"""Endpoint policy — what Phase 3 refuses to dial.

OFFLINE BY CONSTRUCTION. `assert_public_url` only calls `getaddrinfo` when the
host is a NAME; a literal IP is checked directly. Every case here uses a literal
IP or a scheme/shape rejection, so the suite needs no network and no DNS.

The one test that would need a resolver -- "a name that resolves inside is
refused" -- is covered in `app/ssrf.py`'s own suite; duplicating it here would
buy a network dependency and nothing else.
"""

from __future__ import annotations

import pytest

from app.mcp.endpoint import assert_dialable, assert_dialable_sync
from app.mcp.exceptions import McpConnectionError, McpErrorKind


def _refused(url: str) -> McpConnectionError:
    with pytest.raises(McpConnectionError) as got:
        assert_dialable_sync(url)
    assert got.value.kind is McpErrorKind.ENDPOINT_REJECTED
    return got.value


# ------------------------------------------------------------------ scheme
def test_http_is_refused_even_to_a_public_host():
    """The Authorization header rides this request. ssrf.py permits http to a
    public host, which is right for ITS caller and wrong for this one."""
    err = _refused("http://93.184.216.34/mcp")
    assert "https" in err.detail


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://93.184.216.34/mcp",
        "gopher://93.184.216.34/",
        "data:text/plain,hello",
        "ws://93.184.216.34/mcp",
    ],
)
def test_non_https_schemes_are_refused(url):
    _refused(url)


def test_empty_or_garbage_is_refused_not_crashed():
    _refused("")
    _refused("   ")
    _refused("not-a-url")


# ------------------------------------------------------------ credentials
def test_credentials_in_the_authority_are_refused():
    _refused("https://user:pass@93.184.216.34/mcp")


@pytest.mark.parametrize(
    "key", ["api_key", "apikey", "api-key", "key", "token", "access_token",
            "secret", "password", "auth", "API_KEY", "Token"],
)
def test_a_credential_shaped_query_parameter_is_refused(key):
    """Some MCP servers publish `?key=` endpoints. Such a URL ends up in the
    catalogue, in logs and in error details -- a header is the only right place
    for a secret."""
    err = _refused(f"https://93.184.216.34/mcp?{key}=abc123")
    assert "credential-shaped" in err.detail
    # The refusal must not quote the VALUE back.
    assert "abc123" not in err.detail


def test_an_innocuous_query_parameter_is_allowed():
    assert_dialable_sync("https://93.184.216.34/mcp?version=2&region=eu")


# -------------------------------------------------------------- addresses
@pytest.mark.parametrize(
    "host",
    [
        "127.0.0.1",          # loopback
        "[::1]",              # loopback v6
        "10.0.0.5",           # RFC1918
        "192.168.1.1",        # RFC1918
        "172.16.70.25",       # this very VM
        "169.254.169.254",    # cloud metadata
        "[fd00:ec2::254]",    # cloud metadata v6
        "100.64.0.1",         # CGNAT
        "0.0.0.0",  # noqa: S104 - a refusal fixture, not a bind address
        "[::ffff:127.0.0.1]", # IPv4-mapped loopback
    ],
)
def test_private_and_metadata_addresses_are_refused(host):
    err = _refused(f"https://{host}/mcp")
    assert "SSRF" in err.detail


@pytest.mark.parametrize(
    ("host", "leak"),
    [
        ("10.0.0.5", "10.0.0.5"),
        ("[fd00:ec2::254]", "fd00:ec2::254"),
        ("[::ffff:127.0.0.1]", "127.0.0.1"),
        ("[::1]", "::1"),
        ("169.254.169.254", "169.254.169.254"),
    ],
)
def test_a_refusal_never_names_the_resolved_address(host, leak):
    """The detail is read by a user and written to a log. `assert_public_url`
    says "resolves to a blocked address: 10.0.0.5", which is exactly an
    internal-network oracle: aim this at an internal NAME and the refusal tells
    you what it resolves to.

    The IPv4-mapped case is here because the first fix passed the plain-v4 test
    while still leaking `.0.0.1` out of `::ffff:127.0.0.1`.
    """
    err = _refused(f"https://{host}/mcp")
    assert leak not in err.detail
    assert "<redacted>" in err.detail
    # The RULE must survive redaction -- an unexplained refusal is unactionable.
    assert "SSRF" in err.detail


def test_redaction_leaves_non_address_reasons_intact():
    """Over-broad redaction would make every refusal say the same thing."""
    from app.mcp.endpoint import _redact_addresses

    for message in (
        "scheme not allowed: ftp",
        "could not resolve host: nope.invalid",
        "port not allowed: 3210",
        "credentials in url are not allowed",
    ):
        assert _redact_addresses(message) == message


def test_a_non_standard_port_is_refused():
    """Blocks :3210 (Convex), :8770 (this plane), :6379, :22 ..."""
    _refused("https://93.184.216.34:3210/mcp")
    _refused("https://93.184.216.34:8770/mcp")


def test_a_public_https_endpoint_on_a_standard_port_is_allowed():
    assert_dialable_sync("https://93.184.216.34/mcp")
    assert_dialable_sync("https://93.184.216.34:443/mcp")


# ------------------------------------------------------------------ async
async def test_the_async_wrapper_runs_the_blocking_lookup_off_the_loop():
    """`assert_public_url` calls getaddrinfo, which blocks. Running it inline
    would stall every other generation on this worker."""
    import app.mcp.endpoint as mod

    await assert_dialable("https://93.184.216.34/mcp")
    with pytest.raises(McpConnectionError):
        await assert_dialable("https://127.0.0.1/mcp")
    assert "to_thread" in mod.assert_dialable.__doc__ or True
    src = __import__("inspect").getsource(mod.assert_dialable)
    assert "to_thread" in src, "the blocking DNS call must not run on the loop"
