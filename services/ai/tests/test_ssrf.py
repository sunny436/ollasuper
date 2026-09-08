"""SSRF boundary — attack the model-supplied URL with every bypass variant."""

from __future__ import annotations

import ipaddress

import pytest

from app.ssrf import (
    SsrfError,
    _ip_is_forbidden,
    _walk_urls,
    assert_payload_urls_safe,
    assert_public_url,
)

# --- IP classification (no DNS) ---------------------------------------------


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1", "127.0.0.53", "0.0.0.0", "10.0.0.1", "172.16.0.1",
        "192.168.1.1", "169.254.169.254", "169.254.1.1", "100.64.0.1",
        "224.0.0.1", "::1", "fe80::1", "fc00::1", "fd00:ec2::254",
        "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::",
    ],
)
def test_forbidden_ips(ip):
    assert _ip_is_forbidden(ipaddress.ip_address(ip)) is True


@pytest.mark.parametrize("ip", ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"])
def test_public_ips_allowed(ip):
    assert _ip_is_forbidden(ipaddress.ip_address(ip)) is False


# --- URL-level bypasses (IP literals need no DNS) ---------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",                 # loopback
        "http://127.0.0.1:3210/__cvx",       # Convex port on loopback
        "https://[::1]/",                    # ipv6 loopback
        "http://169.254.169.254/latest/meta-data/",  # AWS metadata
        "http://[fd00:ec2::254]/",           # ipv6 metadata
        "http://10.0.0.5/",                  # RFC1918
        "http://192.168.0.1/",               # RFC1918
        "http://172.16.5.5/",                # RFC1918
        "http://100.64.1.1/",                # CGNAT
        "http://0.0.0.0/",                   # unspecified
        "http://2130706433/",                # decimal 127.0.0.1
        "http://0x7f000001/",                # hex 127.0.0.1
        "http://user:pass@127.0.0.1/",       # creds bypass
        "http://evil@127.0.0.1/",            # creds bypass
        "http://93.184.216.34:22/",          # public host, ssh port
        "http://93.184.216.34:6379/",        # public host, redis port
        "file:///etc/passwd",                # scheme
        "gopher://127.0.0.1:6379/_x",        # scheme
        "ftp://127.0.0.1/",                  # scheme
        "dict://127.0.0.1:11211/",           # scheme
        "http://[::ffff:127.0.0.1]/",        # ipv4-mapped ipv6 loopback
    ],
)
def test_ssrf_urls_refused(url):
    with pytest.raises(SsrfError):
        assert_public_url(url)


def test_localhost_name_refused():
    # DNS-resolved: localhost -> 127.0.0.1 -> blocked (real resolution).
    with pytest.raises(SsrfError):
        assert_public_url("http://localhost/")


def test_a_real_public_url_is_allowed():
    # example.com resolves to a public IP; must NOT raise (needs network).
    assert_public_url("https://example.com/")


def test_a_public_url_with_explicit_443_is_allowed():
    assert_public_url("https://example.com:443/path?q=1")


# --- payload walking (URLs anywhere, any field name) ------------------------


def test_walk_finds_urls_in_nested_payload():
    payload = {
        "query": "hi",
        "opts": {"callback": "http://127.0.0.1/x", "n": 3},
        "list": ["https://example.com", "not-a-url", {"u": "http://10.0.0.1/"}],
    }
    urls = set(_walk_urls(payload))
    assert "http://127.0.0.1/x" in urls
    assert "http://10.0.0.1/" in urls
    assert "https://example.com" in urls
    assert "not-a-url" not in urls


async def test_payload_with_an_internal_url_is_refused():
    with pytest.raises(SsrfError):
        await assert_payload_urls_safe({"url": "http://169.254.169.254/"})


async def test_payload_with_only_public_urls_passes():
    await assert_payload_urls_safe({"url": "https://example.com", "n": 1})


async def test_payload_with_no_urls_is_a_noop():
    await assert_payload_urls_safe({"q": "just text", "n": 5})
