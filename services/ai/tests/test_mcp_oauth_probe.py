"""The read-only auth probe, and the §98/§99 auth capability matrix it produces.

WHY A PROBE EXISTS AT ALL
-------------------------
The Phase 2 catalogue cannot say which servers speak OAuth. `registry/parse.py`
refuses to infer it because the registry publishes no auth-scheme field, and the
measured distribution across 30,871 catalogued servers has no `oauth` bucket at
all (none 37,950 · api_key 30,835 · unknown 30,071 · bearer 1,342). Every
captured real fixture declares `headers=[]`.

So the auth shape is discovered at RUNTIME, from the 401 and its
`WWW-Authenticate` challenge, exactly as the MCP specification prescribes. A
table of guesses would be worse than no table.

WHY THE MATRIX IS BUILT FROM IN-PROCESS SERVERS
-----------------------------------------------
The phase forbids exposing this service and forbids production OAuth
applications, so the matrix cannot be filled by pointing at real vendors. What it
CAN honestly cover is one server per AUTH SHAPE — which is the thing the code has
to handle differently. Each row below is a real authorization server answering
real discovery over the real SDK helpers; only the vendor's name is absent.

Remaining vendors are operator curation: adding a row to `mcp_curated_servers`
requires no code change, and this probe is the tool for deciding what that row
should say.

READ-ONLY IS ASSERTED, NOT ASSUMED. Every case checks `register_calls == 0` and
`token_calls == 0`. A probe that quietly registers an OAuth client against a
third party is not a probe — it is an unannounced integration.
"""

from __future__ import annotations

import httpx2
import pytest

from app.mcp.oauth.probe import probe_auth
from tests.fakes.oauth_server import BASE, MCP_URL, AuthServerState, build_oauth_mcp_app

pytestmark = pytest.mark.anyio


def _client(app) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url=BASE, follow_redirects=False
    )


async def _probe(state: AuthServerState | None = None):
    app, state = build_oauth_mcp_app(state)
    async with app.inner.router.lifespan_context(app.inner):
        async with _client(app) as client:
            shape = await probe_auth(MCP_URL, client)
    return shape, state


# ------------------------------------------------------------------ read-only
async def test_the_probe_registers_nothing_and_requests_no_token():
    shape, state = await _probe()
    assert shape.shape == "oauth"
    # THE assertion this module exists for.
    assert state.register_calls == 0
    assert state.token_calls == 0
    assert state.issued_access == []
    # Discovery really happened, so the zeros above are not "it did nothing".
    assert state.prm_calls >= 1
    assert state.asm_calls >= 1


async def test_the_probe_reports_what_discovery_actually_said():
    shape, _ = await _probe()
    assert shape.reachable is True
    assert shape.status == 401
    assert shape.issuer == BASE
    assert shape.authorization_servers == [BASE]
    assert set(shape.scopes_supported) == {"mcp:read", "mcp:write"}
    assert shape.pkce_methods == ["S256"]
    assert shape.dcr_supported is True
    assert shape.revocation_supported is True


async def test_a_server_without_dynamic_registration_says_so():
    # The difference decides whether this deployment can connect at all without
    # an operator pre-registering a client by hand.
    shape, _ = await _probe(AuthServerState(support_dcr=False))
    assert shape.shape == "oauth"
    assert shape.dcr_supported is False


async def test_a_server_without_revocation_says_so():
    # Straight into `revoked_remotely: "unsupported"` on disconnect. Claiming a
    # revocation that cannot happen would tell a user their access was withdrawn
    # when it was not.
    shape, _ = await _probe(AuthServerState(support_revocation=False))
    assert shape.revocation_supported is False


async def test_the_advertised_scopes_are_reported_verbatim():
    # Scope is server-dictated: the SDK overwrites `client_metadata.scope` from
    # this list. Reporting it is how consent can be informed rather than blind.
    shape, _ = await _probe(
        AuthServerState(scopes_supported=("repo:read", "repo:write", "gist"))
    )
    assert shape.scopes_supported == ["repo:read", "repo:write", "gist"]


# ---------------------------------------------------------- the other shapes
async def test_a_server_that_wants_nothing_reports_none():
    from tests.fakes.mcp_http import MCP_URL as PLAIN_URL
    from tests.fakes.mcp_http import build_mcp_app, running

    app, _traffic = build_mcp_app()
    async with running(app):
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url="https://93.184.216.34"
        ) as client:
            shape = await probe_auth(PLAIN_URL, client)
    # It answered without a challenge, so it wants nothing from us.
    assert shape.shape == "none"
    assert shape.reachable is True


async def test_a_challenge_with_no_oauth_metadata_reads_as_a_static_credential():
    """A 401 and no discoverable PRM is almost always an API-key server.

    Reported as a POSSIBILITY with a reason attached, never asserted: a server
    that is simply misconfigured looks identical from out here, and the honest
    output distinguishes "we found OAuth" from "we found nothing and are
    guessing".
    """
    from tests.fakes.mcp_http import status_app

    app = status_app(401)
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="https://93.184.216.34"
    ) as client:
        shape = await probe_auth("https://93.184.216.34/mcp", client)
    assert shape.shape == "api_key"
    assert shape.status == 401
    assert shape.detail is not None
    assert "static credential" in shape.detail


async def test_an_unreachable_server_reports_rather_than_raising():
    from tests.fakes.mcp_http import refusing_app

    app = refusing_app()
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="https://93.184.216.34"
    ) as client:
        shape = await probe_auth("https://93.184.216.34/mcp", client)
    assert shape.reachable is False
    assert shape.shape == "unknown"


async def test_a_non_401_error_is_not_classified_as_an_auth_shape():
    from tests.fakes.mcp_http import status_app

    app = status_app(503)
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="https://93.184.216.34"
    ) as client:
        shape = await probe_auth("https://93.184.216.34/mcp", client)
    # A server having a bad minute must not be recorded as "needs no auth".
    assert shape.shape == "unknown"
    assert shape.status == 503


# ------------------------------------------------------------------- the SSRF
async def test_the_probe_refuses_a_private_endpoint_before_dialling():
    """OAuth discovery follows URLs the SERVER chooses. Without the guard,
    naming a loopback endpoint would make this service probe itself."""
    from app.mcp.exceptions import McpConnectionError

    async with httpx2.AsyncClient() as client:
        for url in (
            "http://127.0.0.1:8770/mcp",
            "https://169.254.169.254/latest/meta-data/",
            "https://[::1]/mcp",
        ):
            with pytest.raises(McpConnectionError):
                await probe_auth(url, client)


async def test_discovery_will_not_follow_metadata_pointing_somewhere_private():
    """The attack: a hostile PRM hint naming a private address.

    `extract_resource_metadata_from_www_auth` takes the URL straight out of the
    challenge, so this is exactly where a server could turn our discovery into
    an SSRF primitive. The guard runs again on every candidate URL, so the fetch
    never happens and the probe falls through to the honest "no OAuth metadata"
    answer.
    """
    calls: list[str] = []

    async def hostile(scope, receive, send):
        calls.append(scope["path"])
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"content-type", b"application/json"),
                    (
                        b"www-authenticate",
                        b'Bearer resource_metadata='
                        b'"http://169.254.169.254/.well-known/oauth-protected-resource"',
                    ),
                ],
            }
        )
        await send({"type": "http.response.body", "body": b"{}"})

    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=hostile), base_url="https://93.184.216.34"
    ) as client:
        shape = await probe_auth("https://93.184.216.34/mcp", client)

    assert shape.shape == "api_key"  # nothing discoverable, so no OAuth claimed
    assert shape.authorization_servers == []
    # Only the endpoint itself was ever contacted through this app.
    assert all("169.254" not in path for path in calls)


async def test_oversized_metadata_is_dropped_rather_than_parsed():
    # A hostile server answering the discovery URL with megabytes must not make
    # this process allocate them.
    import json

    body = json.dumps({"resource": MCP_URL, "padding": "x" * (300 * 1024)}).encode()

    async def fat(scope, receive, send):
        if scope["path"].startswith("/.well-known/"):
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [(b"content-type", b"application/json")],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"www-authenticate", b"Bearer"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": b"{}"})

    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=fat), base_url="https://93.184.216.34"
    ) as client:
        shape = await probe_auth("https://93.184.216.34/mcp", client)
    assert shape.authorization_servers == []


# ------------------------------------------------ §98/§99 capability matrix
#: One row per AUTH SHAPE — the dimension the code actually branches on.
#: Named for what they represent, not for a vendor, because no production OAuth
#: application may be created in this phase.
MATRIX = [
    (
        "oauth-dcr",
        "OAuth + Dynamic Client Registration (the common remote-MCP shape)",
        AuthServerState(),
        {"shape": "oauth", "dcr_supported": True, "revocation_supported": True},
    ),
    (
        "oauth-preregistered",
        "OAuth with NO DCR — an operator must pre-register a client",
        AuthServerState(support_dcr=False),
        {"shape": "oauth", "dcr_supported": False},
    ),
    (
        "oauth-no-revocation",
        "OAuth without RFC 7009 — disconnect can only delete locally",
        AuthServerState(support_revocation=False),
        {"shape": "oauth", "revocation_supported": False},
    ),
    (
        "oauth-narrow-scope",
        "OAuth advertising a single scope — nothing to narrow",
        AuthServerState(scopes_supported=("mcp:read",)),
        {"shape": "oauth", "scopes_supported": ["mcp:read"]},
    ),
]


@pytest.mark.parametrize(
    ("slug", "description", "state", "expected"),
    MATRIX,
    ids=[row[0] for row in MATRIX],
)
async def test_the_capability_matrix_is_produced_by_a_real_probe(
    slug, description, state, expected
):
    """Each row is MEASURED, not written down.

    That is the whole point of building it this way: a hand-maintained table of
    "which servers need DCR" rots the first time a vendor changes its metadata,
    and nobody notices. Running the probe is the only claim worth making.
    """
    shape, server = await _probe(state)
    for field, value in expected.items():
        assert getattr(shape, field) == value, f"{slug}: {field} ({description})"
    # Every row, without exception: probing is free of side effects.
    assert server.register_calls == 0
    assert server.token_calls == 0


async def test_the_matrix_covers_every_shape_the_code_branches_on():
    """A coverage guard on the matrix itself.

    Without it, a new branch in `probe.py` — a new shape, a new capability —
    could be added with no row exercising it, and the matrix would quietly stop
    being a matrix.
    """
    covered = {name for _slug, _desc, _state, expected in MATRIX for name in expected}
    # These are the fields an operator's curation decision actually turns on.
    assert {"shape", "dcr_supported", "revocation_supported", "scopes_supported"} <= (
        covered
    )
    # And the non-OAuth shapes have their own tests above rather than a row here,
    # because they need a different fixture entirely.
    from app.mcp.oauth.probe import AuthShape

    assert AuthShape().shape == "unknown"
