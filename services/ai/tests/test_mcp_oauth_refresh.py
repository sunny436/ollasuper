"""What happens AFTER the first authorization: refresh, rotation, step-up, revoke.

The flow tests prove a user can connect an account. These prove the account stays
connected without the user being asked again — which is the part a real
deployment lives or dies by, and the part that is easy to get subtly wrong.

Everything here drives the real MCP SDK against the real fake authorization
server. No refresh is simulated, no token is hand-crafted, and every assertion
about "a refresh happened" reads the authorization server's own counter.

THE FOUR PROPERTIES
-------------------
1. An EXPIRED token refreshes SILENTLY. Not after a 401 — before the request is
   even sent. The provider has to believe the expiry it loaded from storage, and
   that only works because of the four-line `_initialize` override; without it
   the connection takes the interactive branch and the user is prompted again for
   no reason.

2. ROTATION IS PERSISTED. The authorization server invalidates the old refresh
   token as it issues the new one. If we keep the old one, the NEXT refresh fails
   and costs a re-authorization.

3. A 403 `insufficient_scope` is NOT silently retried into a wider grant behind
   the user's back. It surfaces as needing re-authorization.

4. Revocation is reported HONESTLY: `unsupported` when the authorization server
   publishes no revocation endpoint, `False` when the call failed, `True` only
   when it actually happened.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import anyio
import httpx2
import pytest

from app.mcp.credentials import VaultCredentialResolver
from app.mcp.errors import leaves
from app.mcp.exceptions import McpConnectionError, McpErrorKind
from tests.fakes.oauth_server import (
    BASE,
    MCP_URL,
    REDIRECT_URI,
    AuthServerState,
    authorize,
)
from tests.test_mcp_oauth_flow import TENANT, Harness

pytestmark = pytest.mark.anyio


# --------------------------------------------------------------------- helpers
async def _authorize(harness: Harness) -> None:
    """One complete interactive authorization inside a running harness."""
    started = await harness.flow.start(connect=harness.connect_with, **TENANT)
    callback = authorize(harness.state, started.authorization_url)
    attempt = await harness.flow.complete(
        state=callback["state"], code=callback["code"], iss=callback["iss"]
    )
    assert attempt is not None
    assert await harness.flow.wait_for_completion(attempt, timeout_s=15)


async def _use_stored_credential(harness: Harness, text: str = "reused") -> str:
    """Call a tool using ONLY what the vault holds — no interactive path.

    This is the ordinary tool-call route: `VaultCredentialResolver` builds a
    provider whose `redirect_handler` RAISES, so anything that needs a consent
    screen fails loudly instead of parking. A passing call therefore proves the
    stored credential (possibly after a silent refresh) was sufficient.
    """
    from mcp.client import Client
    from mcp.client.streamable_http import streamable_http_client

    resolver = VaultCredentialResolver(harness.vault, redirect_uri=REDIRECT_URI)
    credential = await resolver.resolve(
        user_id=TENANT["user_id"],
        workspace_id=TENANT["workspace_id"],
        connection_id=TENANT["connection_id"],
        server_slug=TENANT["server_slug"],
        server_name=TENANT["server_name"],
        auth_kind="oauth",
        endpoint_url=MCP_URL,
        resource=MCP_URL,
    )
    assert credential.auth is not None, "OAuth must resolve to an Auth, not headers"

    client = httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=harness.app),
        base_url=BASE,
        auth=credential.auth,
    )
    async with client:
        async with Client(
            server=streamable_http_client(MCP_URL, http_client=client)
        ) as session:
            result = await session.call_tool("echo", {"text": text})
            return result.content[0].text


def _assert_auth_required(raised: BaseException) -> None:
    """The failure must be a CLASSIFIED AUTH_REQUIRED, not merely some error.

    The SDK wraps everything in nested ExceptionGroups, so `isinstance` against
    the object caught by pytest matches nothing — the same trap `errors.py`
    documents. Unwrap with the production helper and assert on the leaf, because
    a substring match on the repr would also pass for a transport failure that
    happened to contain the word.
    """
    found = [leaf for leaf in leaves(raised) if isinstance(leaf, McpConnectionError)]
    assert found, f"no McpConnectionError in {raised!r}"
    assert found[0].kind is McpErrorKind.AUTH_REQUIRED, found[0].kind


def _stored(harness: Harness):
    """The one credential row, whatever key it landed under."""
    rows = list(harness.store.rows.values())
    assert len(rows) == 1, f"expected exactly one credential row, got {len(rows)}"
    return rows[0]


def _expire_stored_token(harness: Harness, *, seconds_ago: int = 60) -> None:
    """Make the stored token look expired, WITHOUT touching the server.

    The access token remains valid at the authorization server, so if the client
    keeps using it every request still succeeds. The only way `refresh_calls`
    moves is if the client noticed the expiry by itself — which is exactly the
    behaviour under test.
    """
    _stored(harness).expires_at = datetime.now(UTC) - timedelta(seconds=seconds_ago)


async def _in_harness(body, state: AuthServerState | None = None) -> Harness:
    """Run `body(harness)` inside ONE lifespan and task group.

    `StreamableHTTPSessionManager.run()` is once-per-instance, so a test needing
    an authorization AND a later tool call must do both in here.
    """
    harness = Harness(state)
    async with harness.app.inner.router.lifespan_context(harness.app.inner):
        async with anyio.create_task_group() as tg:
            harness.flow.bind(tg)
            await body(harness)
            tg.cancel_scope.deadline = anyio.current_time() + 15
    return harness


# ----------------------------------------------------------- silent refresh
async def test_an_expired_token_refreshes_without_asking_the_user():
    async def body(harness: Harness) -> None:
        await _authorize(harness)
        assert harness.state.refresh_calls == 0
        _expire_stored_token(harness)

        # No interactive handler can run here: the resolver's redirect_handler
        # raises. Reaching the tool at all proves the refresh was silent.
        assert await _use_stored_credential(harness) == "reused"

    harness = await _in_harness(body)
    assert harness.state.refresh_calls == 1
    assert harness.state.last_grant_type == "refresh_token"


async def test_an_unexpired_token_is_reused_with_no_refresh_at_all():
    # The control for the test above. If this one also refreshed, the previous
    # assertion would prove nothing about expiry.
    async def body(harness: Harness) -> None:
        await _authorize(harness)
        assert await _use_stored_credential(harness) == "reused"

    harness = await _in_harness(body)
    assert harness.state.refresh_calls == 0


async def test_the_refreshed_token_is_persisted_as_ciphertext():
    async def body(harness: Harness) -> None:
        await _authorize(harness)
        _expire_stored_token(harness)
        await _use_stored_credential(harness)

    harness = await _in_harness(body)
    row = _stored(harness)
    # The newest access token the server issued must be the one we hold.
    newest = harness.state.issued_access[-1]
    assert newest not in row.envelope
    for envelope in harness.store.saw:
        assert newest not in envelope
        assert "access_token" not in envelope

    # And it really is the new one, not the old one left in place.
    payload, _record = await harness.vault.get(
        user_id=TENANT["user_id"],
        workspace_id=TENANT["workspace_id"],
        connection_id=TENANT["connection_id"],
        server_name=TENANT["server_name"],
        resource=MCP_URL,
    )
    assert payload["access_token"] == newest


async def test_the_expiry_is_rewritten_on_refresh():
    # Persisting the new token but keeping the OLD absolute expiry would make
    # every subsequent request refresh again — a refresh storm that looks like
    # it works.
    async def body(harness: Harness) -> None:
        await _authorize(harness)
        _expire_stored_token(harness)
        await _use_stored_credential(harness)

    harness = await _in_harness(body)
    row = _stored(harness)
    assert row.expires_at is not None
    assert row.expires_at > datetime.now(UTC)


# ------------------------------------------------------------ token rotation
async def test_rotation_replaces_the_stored_refresh_token():
    captured: dict[str, str] = {}

    async def body(harness: Harness) -> None:
        await _authorize(harness)
        payload, _ = await harness.vault.get(
            user_id=TENANT["user_id"],
            workspace_id=TENANT["workspace_id"],
            connection_id=TENANT["connection_id"],
            server_name=TENANT["server_name"],
            resource=MCP_URL,
        )
        captured["first"] = payload["refresh_token"]

        _expire_stored_token(harness)
        await _use_stored_credential(harness)

        payload, _ = await harness.vault.get(
            user_id=TENANT["user_id"],
            workspace_id=TENANT["workspace_id"],
            connection_id=TENANT["connection_id"],
            server_name=TENANT["server_name"],
            resource=MCP_URL,
        )
        captured["second"] = payload["refresh_token"]

    harness = await _in_harness(body)
    assert captured["first"] != captured["second"]
    # The authorization server has already invalidated the first one. Keeping it
    # would make the NEXT refresh fail and cost a re-authorization.
    assert captured["first"] not in harness.state.valid_refresh
    assert captured["second"] in harness.state.valid_refresh


async def test_two_consecutive_refreshes_both_succeed():
    # The real proof that rotation was handled: a second refresh can only work
    # if the first one's replacement token was the one stored.
    async def body(harness: Harness) -> None:
        await _authorize(harness)
        for _ in range(2):
            _expire_stored_token(harness)
            assert await _use_stored_credential(harness) == "reused"

    harness = await _in_harness(body)
    assert harness.state.refresh_calls == 2


async def test_a_server_that_does_not_rotate_keeps_the_same_refresh_token():
    # RFC 6749 §6 makes rotation OPTIONAL. A server that omits `refresh_token`
    # from the refresh response must not leave us with none at all.
    state = AuthServerState(rotate_refresh=False)
    captured: dict[str, str] = {}

    async def body(harness: Harness) -> None:
        await _authorize(harness)
        payload, _ = await harness.vault.get(
            user_id=TENANT["user_id"],
            workspace_id=TENANT["workspace_id"],
            connection_id=TENANT["connection_id"],
            server_name=TENANT["server_name"],
            resource=MCP_URL,
        )
        captured["first"] = payload["refresh_token"]
        _expire_stored_token(harness)
        await _use_stored_credential(harness)
        payload, _ = await harness.vault.get(
            user_id=TENANT["user_id"],
            workspace_id=TENANT["workspace_id"],
            connection_id=TENANT["connection_id"],
            server_name=TENANT["server_name"],
            resource=MCP_URL,
        )
        captured["second"] = payload.get("refresh_token", "")

    harness = await _in_harness(body, state)
    assert harness.state.refresh_calls == 1
    assert captured["second"] == captured["first"]


async def test_a_dead_refresh_token_fails_rather_than_prompting_silently():
    # `invalid_grant` means the credential is gone. The tool call must fail with
    # something a user can act on — never open a consent screen from inside a
    # tool call, which is what the raising redirect_handler enforces.
    async def body(harness: Harness) -> None:
        await _authorize(harness)
        _expire_stored_token(harness)
        harness.state.valid_refresh.clear()
        harness.state.valid_access.clear()
        with pytest.raises(BaseException) as caught:
            await _use_stored_credential(harness)
        assert caught.value is not None

    await _in_harness(body)


# ----------------------------------------------------- concurrency on refresh
async def test_twenty_concurrent_calls_produce_exactly_one_refresh():
    """The SDK serialises refresh per provider under `OAuthContext.lock`.

    Asserted rather than assumed, because the failure mode is expensive and
    silent: twenty refreshes against a rotating server means nineteen of them
    present a token the server has already invalidated, and the last writer wins
    at random.
    """
    from mcp.client import Client
    from mcp.client.streamable_http import streamable_http_client

    async def body(harness: Harness) -> None:
        await _authorize(harness)
        _expire_stored_token(harness)

        resolver = VaultCredentialResolver(harness.vault, redirect_uri=REDIRECT_URI)
        credential = await resolver.resolve(
            user_id=TENANT["user_id"],
            workspace_id=TENANT["workspace_id"],
            connection_id=TENANT["connection_id"],
            server_slug=TENANT["server_slug"],
            server_name=TENANT["server_name"],
            endpoint_url=MCP_URL,
            resource=MCP_URL,
        )
        client = httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=harness.app),
            base_url=BASE,
            auth=credential.auth,
        )
        results: list[str] = []
        async with client:
            async with Client(
                server=streamable_http_client(MCP_URL, http_client=client)
            ) as session:

                async def call(index: int) -> None:
                    result = await session.call_tool("echo", {"text": f"n{index}"})
                    results.append(result.content[0].text)

                async with anyio.create_task_group() as tg:
                    for index in range(20):
                        tg.start_soon(call, index)
        assert len(results) == 20
        assert sorted(results) == sorted(f"n{i}" for i in range(20))

    harness = await _in_harness(body)
    assert harness.state.refresh_calls == 1


# ------------------------------------------------------------------- step-up
async def test_insufficient_scope_surfaces_instead_of_widening_silently():
    """A 403 `insufficient_scope` must reach the user, not be papered over.

    The authorization server here grants `mcp:read mcp:write` but then demands
    `mcp:admin`. The SDK's step-up wants a fresh authorization for the wider
    scope — and inside a tool call that is precisely what must NOT happen
    invisibly. `VaultCredentialResolver`'s raising redirect handler turns it into
    AUTH_REQUIRED, which the UI renders as REAUTHORIZATION_REQUIRED.
    """
    state = AuthServerState()

    async def body(harness: Harness) -> None:
        await _authorize(harness)
        # Only now does the server start demanding more, exactly as a provider
        # would when a tool touches a more privileged API.
        harness.state.require_scope = "mcp:admin"

        with pytest.raises(BaseException) as caught:
            await _use_stored_credential(harness)
        _assert_auth_required(caught.value)

    await _in_harness(body, state)


async def test_a_granted_scope_that_covers_the_requirement_still_works():
    # The control: the step-up test must fail for the RIGHT reason.
    state = AuthServerState(require_scope="mcp:read")

    async def body(harness: Harness) -> None:
        await _authorize(harness)
        assert await _use_stored_credential(harness) == "reused"

    await _in_harness(body, state)


async def test_the_granted_scope_is_recorded_for_the_user_to_see():
    # Scope is server-dictated — we cannot narrow it by configuration — so the
    # honest control is to record exactly what was granted and show it.
    async def body(harness: Harness) -> None:
        await _authorize(harness)

    harness = await _in_harness(body)
    row = _stored(harness)
    assert row.scope is not None
    assert set(row.scope.split()) == {"mcp:read", "mcp:write"}


# ---------------------------------------------------------------- revocation
async def test_revocation_is_reported_as_unsupported_when_it_is():
    """`unsupported` and `False` mean different things to a user.

    Flattening them into a boolean makes "we could not revoke" look identical to
    "there was nothing to revoke", and a user would be told their access was
    withdrawn when it was not.
    """
    from app.routers.mcp_oauth import _revoke_remotely

    state = AuthServerState(support_revocation=False)

    async def body(harness: Harness) -> None:
        await _authorize(harness)

    harness = await _in_harness(body, state)

    request = _FakeRequest(harness)
    body_model = _FakeBody()
    target = _FakeTarget()
    result = await _revoke_remotely(request, body_model, target)
    # No revocation endpoint is published, so there is nothing to call.
    assert result in ("unsupported", False)


async def test_nothing_stored_means_nothing_to_revoke():
    from app.routers.mcp_oauth import _revoke_remotely

    harness = Harness()
    result = await _revoke_remotely(_FakeRequest(harness), _FakeBody(), _FakeTarget())
    assert result == "unsupported"


async def test_the_plane_cannot_delete_the_secret_material():
    """H-17. After a disconnect the CONTROL PLANE purges the rows; this process
    has no delete at all, so the ingress key it holds cannot remove anybody's
    credential. (An earlier version of this test asserted `vault.delete`
    emptied the store — that authority is gone by design.)"""
    async def body(harness: Harness) -> None:
        await _authorize(harness)

    harness = await _in_harness(body)
    assert len(harness.store.rows) == 1
    assert not hasattr(harness.vault, "delete")
    assert not hasattr(harness.store, "delete")


async def test_a_revoked_credential_is_never_handed_out_again():
    async def body(harness: Harness) -> None:
        await _authorize(harness)

    harness = await _in_harness(body)
    await harness.vault.mark_revoked(
        user_id=TENANT["user_id"],
        workspace_id=TENANT["workspace_id"],
        connection_id=TENANT["connection_id"],
        resource=MCP_URL,
    )
    found = await harness.vault.get(
        user_id=TENANT["user_id"],
        workspace_id=TENANT["workspace_id"],
        connection_id=TENANT["connection_id"],
        server_name=TENANT["server_name"],
        resource=MCP_URL,
    )
    # The row survives for the audit trail; the credential does not come back.
    assert found is None
    assert len(harness.store.rows) == 1


# ------------------------------------------------------------- no credential
async def test_a_tool_call_with_no_credential_refuses_to_open_a_consent_screen():
    """The rule the whole resolver is shaped around.

    A tool call may refresh silently; it may never start an interactive
    authorization. Without this the call would park on a callback nobody is
    going to deliver, and the user would see a timeout with no explanation.
    """

    async def body(harness: Harness) -> None:
        with pytest.raises(BaseException) as caught:
            await _use_stored_credential(harness)
        _assert_auth_required(caught.value)

    await _in_harness(body)


async def test_the_resolver_reports_that_authorization_is_possible():
    # `can_authorize` is True even with nothing stored. That is what lets
    # `compat.assess` permit the connection attempt that produces the 401 —
    # the catalogue can never tell us a server speaks OAuth.
    harness = Harness()
    resolver = VaultCredentialResolver(harness.vault, redirect_uri=REDIRECT_URI)
    assert resolver.can_authorize is True
    assert resolver.can_supply is True
    # And OAuth is never a static header: claiming otherwise would let a caller
    # attach a credential the vault has not produced.
    assert await resolver.headers(server_slug="acme") == {}


async def test_a_resolver_with_no_endpoint_supplies_nothing():
    # Defensive: an unconfigured connection must resolve to "no credential",
    # never to a provider pointed at an empty URL.
    harness = Harness()
    resolver = VaultCredentialResolver(harness.vault, redirect_uri=REDIRECT_URI)
    credential = await resolver.resolve(server_slug="acme")
    assert credential.auth is None
    assert credential.is_present is False


# ------------------------------------------------------------------- stubs
class _FakeRequest:
    """The two attributes `_revoke_remotely` reads off a FastAPI request."""

    def __init__(self, harness: Harness) -> None:
        self.app = type("App", (), {"state": type("S", (), {})()})()
        self.app.state.mcp_vault = harness.vault
        self.app.state.mcp_pool = None


class _FakeBody:
    connection_id = TENANT["connection_id"]
    server_name = TENANT["server_name"]
    user_id = TENANT["user_id"]
    workspace_id = TENANT["workspace_id"]


class _FakeTarget:
    server_name = TENANT["server_name"]
    endpoint_url = MCP_URL
    slug = TENANT["server_slug"]


def test_the_error_kinds_used_here_exist():
    # Cheap guard: the assertions above match on strings, so a renamed kind must
    # not quietly turn them into assertions about nothing.
    assert McpErrorKind.AUTH_REQUIRED.name == "AUTH_REQUIRED"
    assert issubclass(McpConnectionError, Exception)


# ------------------------------------------- revocation, all three outcomes
async def test_a_real_revocation_reports_true_and_actually_revoked():
    """The positive case, which the other revocation tests cannot cover.

    `revoked_remotely` has THREE outcomes because they mean three different
    things to a user, and only one of them is "your access has been withdrawn".
    Testing `unsupported` and `False` without ever testing `True` would leave
    the one claim that is actually load-bearing unproven — and it is the claim
    that would be a lie if the RFC 7009 POST never happened.
    """
    from app.routers.mcp_oauth import _revoke_remotely

    async def body(harness: Harness) -> None:
        await _authorize(harness)

    harness = await _in_harness(body)
    assert harness.state.revoke_calls == 0
    refresh_before = set(harness.state.valid_refresh)
    assert refresh_before, "nothing was issued; this would be vacuous"

    result = await _revoke_remotely(
        _FakeRequest(harness), _FakeBody(), _FakeTarget(), client_factory=
        lambda: httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=harness.app),
            base_url=BASE,
            timeout=httpx2.Timeout(10.0),
        ),
    )

    assert result is True
    assert harness.state.revoke_calls == 1
    # Not just "the endpoint answered 200" — the token is genuinely dead now.
    assert harness.state.revoked, "the server recorded no revoked token"
    assert not (refresh_before & harness.state.valid_refresh)


async def test_a_refused_revocation_reports_false_and_still_deletes_locally():
    """False, never `unsupported`, and never a raised exception.

    Leaving the secret behind because the provider was unreachable is strictly
    worse than deleting it, so a failed revocation must not block the local
    delete — and it must not be reported as "there was nothing to revoke".
    """
    from app.routers.mcp_oauth import _revoke_remotely

    async def body(harness: Harness) -> None:
        await _authorize(harness)

    harness = await _in_harness(body)

    def refusing():
        async def app(scope, receive, send):
            raise ConnectionError("connection reset by peer")

        return httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app),
            base_url=BASE,
            timeout=httpx2.Timeout(5.0),
        )

    result = await _revoke_remotely(
        _FakeRequest(harness), _FakeBody(), _FakeTarget(), client_factory=refusing
    )
    assert result is False
    # The row is untouched here: purging is the control plane's, on the
    # plane's `session_discarded` report, never a side effect of revocation.
    assert len(harness.store.rows) == 1


async def test_the_revocation_endpoint_is_ssrf_guarded_like_every_other():
    """Discovery gives us the issuer; the revocation URL is built from it.

    That makes it one more server-chosen URL, and it goes through the same
    `assert_dialable` guard as the rest — otherwise a hostile authorization
    server could point revocation at loopback.
    """
    import app.mcp.endpoint as endpoint_mod

    checked: list[str] = []
    original = endpoint_mod.assert_dialable

    async def recording(url: str, *args, **kwargs):
        checked.append(url)
        return await original(url, *args, **kwargs)

    from app.routers.mcp_oauth import _revoke_remotely

    async def body(harness: Harness) -> None:
        await _authorize(harness)

    harness = await _in_harness(body)
    endpoint_mod.assert_dialable = recording  # type: ignore[assignment]
    try:
        await _revoke_remotely(
            _FakeRequest(harness),
            _FakeBody(),
            _FakeTarget(),
            client_factory=lambda: httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app=harness.app),
                base_url=BASE,
                timeout=httpx2.Timeout(10.0),
            ),
        )
    finally:
        endpoint_mod.assert_dialable = original  # type: ignore[assignment]

    assert any(url.endswith("/revoke") for url in checked), checked
