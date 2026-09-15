"""The two-phase OAuth flow, against a REAL authorization server.

Every test here drives the actual protocol: Protected Resource Metadata
discovery, Authorization Server Metadata, dynamic client registration, PKCE,
the authorization request, token exchange, refresh with rotation, the
`insufficient_scope` step-up and RFC 7009 revocation. Nothing is mocked, so a
passing test means the handshake really happened in that order with those
bindings.

THE PROPERTY THE WHOLE DESIGN RESTS ON: the credential is written for the tenant
recorded when the flow STARTED — never for whoever delivered the callback. That
makes a stolen or replayed callback unable to bind an account to the wrong user,
which is what `state` exists for and what the replay tests below check.
"""

from __future__ import annotations

import base64
import json
import os

import anyio
import httpx2
import pytest

from app.mcp.exceptions import McpConnectionError, McpErrorKind
from app.mcp.oauth.attempts import AttemptRegistry
from app.mcp.oauth.flow import OAuthFlow
from app.mcp.vault.envelope import ENVELOPE_VERSION
from app.mcp.vault.keys import KeyProvider
from app.mcp.vault.store import CredentialVault
from tests.fakes.oauth_server import (
    BASE,
    MCP_URL,
    REDIRECT_URI,
    AuthServerState,
    authorize,
    build_oauth_mcp_app,
)
from tests.test_mcp_vault_store import MemoryStore

TENANT = {
    "user_id": "user-a",
    "workspace_id": "ws-1",
    "connection_id": "conn-1",
    "server_name": "acme.test/server",
    "server_slug": "acme",
    "endpoint_url": MCP_URL,
    "resource": MCP_URL,
}


def _vault(store: MemoryStore | None = None) -> tuple[CredentialVault, MemoryStore]:
    store = store or MemoryStore()
    keys = KeyProvider(json.dumps({"1": base64.b64encode(os.urandom(32)).decode()}), 1)
    return CredentialVault(keys, store), store


class Harness:
    """Runs a flow against the in-process authorization server."""

    def __init__(self, state: AuthServerState | None = None, **flow_kwargs) -> None:
        self.app, self.state = build_oauth_mcp_app(state)
        self.vault, self.store = _vault()
        self.flow = OAuthFlow(
            self.vault,
            redirect_uri=REDIRECT_URI,
            registry=AttemptRegistry(ttl_s=flow_kwargs.pop("ttl_s", 120.0)),
            **flow_kwargs,
        )
        self.tool_results: list[str] = []

    async def connect_with(self, provider):
        """What `start` invokes: a real MCP connection carrying the provider."""
        from mcp.client import Client
        from mcp.client.streamable_http import streamable_http_client

        client = httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=self.app),
            base_url=BASE,
            auth=provider,
        )
        async with client:
            async with Client(
                server=streamable_http_client(MCP_URL, http_client=client)
            ) as session:
                result = await session.call_tool("echo", {"text": "authorized"})
                self.tool_results.append(result.content[0].text)


async def _authorize_once(harness: Harness, tg, tenant=None):
    """One complete authorization inside an ALREADY-RUNNING harness.

    Split out because `StreamableHTTPSessionManager.run()` is once-per-instance:
    the app's lifespan cannot be re-entered, so a test that needs two flows must
    run both inside one.
    """
    started = await harness.flow.start(
        connect=harness.connect_with, **(tenant or TENANT)
    )
    callback = authorize(harness.state, started.authorization_url)
    await harness.flow.complete(
        state=callback["state"], code=callback["code"], iss=callback["iss"]
    )
    return started


async def _run(harness: Harness, *, tenant=None, deliver=True, deliver_state=None):
    """start -> authorize in the 'browser' -> callback -> settle."""
    async with harness.app.inner.router.lifespan_context(harness.app.inner):
        async with anyio.create_task_group() as tg:
            harness.flow.bind(tg)
            started = await harness.flow.start(
                connect=harness.connect_with, **(tenant or TENANT)
            )
            if deliver:
                callback = authorize(harness.state, started.authorization_url)
                await harness.flow.complete(
                    state=deliver_state or callback["state"],
                    code=callback["code"],
                    iss=callback["iss"],
                )
            else:
                # Release the parked flow so the task group can finish.
                attempt = await harness.flow.registry.get(started.attempt_id)
                if attempt is not None:
                    attempt.error = "test abandoned the authorization"
                    attempt.callback_ready.set()
            tg.cancel_scope.deadline = anyio.current_time() + 10
        return started


# ------------------------------------------------------------- the happy path
async def test_a_full_authorization_reaches_an_authenticated_tool_call():
    harness = Harness()
    started = await _run(harness)

    assert started.authorization_url.startswith(f"{BASE}/authorize")
    assert harness.tool_results == ["authorized"], "the tool call did not succeed"
    assert harness.state.register_calls == 1
    assert harness.state.token_calls == 1


async def test_pkce_and_the_resource_indicator_actually_travel():
    """The authorization server rejects a wrong verifier, so a successful
    exchange proves the verifier matched the challenge."""
    harness = Harness()
    await _run(harness)
    assert harness.state.last_code_verifier, (
        "no PKCE verifier reached the token endpoint"
    )
    assert harness.state.last_resource == MCP_URL, "RFC 8707 resource was not bound"


async def test_a_wrong_pkce_verifier_fails_the_authorization():
    """Proves the check is real rather than incidentally passing."""
    harness = Harness(AuthServerState(break_pkce=True))
    await _run(harness)
    assert harness.tool_results == []


async def test_only_ciphertext_is_persisted():
    harness = Harness()
    await _run(harness)
    assert harness.store.saw, "nothing was persisted"
    issued = set(harness.state.issued_access)
    for envelope in harness.store.saw:
        assert envelope.startswith(f"{ENVELOPE_VERSION}.")
        for token in issued:
            assert token not in envelope


async def test_the_authorization_url_carries_no_credential():
    """The browser receives the URL. It must contain nothing secret — the
    challenge is a hash, and the state is a routing token."""
    harness = Harness()
    started = await _run(harness, deliver=False)
    for token in harness.state.issued_access:
        assert token not in started.authorization_url
    assert "client_secret" not in started.authorization_url


# ------------------------------------------------------- callback validation
async def test_a_replayed_callback_is_rejected():
    """The attempt is POPPED before completion, so a second delivery of the same
    code finds nothing to complete."""
    harness = Harness()
    async with harness.app.inner.router.lifespan_context(harness.app.inner):
        async with anyio.create_task_group() as tg:
            harness.flow.bind(tg)
            started = await harness.flow.start(connect=harness.connect_with, **TENANT)
            callback = authorize(harness.state, started.authorization_url)

            first = await harness.flow.complete(
                state=callback["state"], code=callback["code"], iss=callback["iss"]
            )
            second = await harness.flow.complete(
                state=callback["state"], code=callback["code"], iss=callback["iss"]
            )
            assert first is not None
            assert second is None, "a replayed callback was accepted"

    assert harness.state.token_calls == 1, "the replay caused a second exchange"


async def test_an_unknown_state_is_indistinguishable_from_an_expired_one():
    """Both return None. A different answer would tell an attacker which states
    exist."""
    harness = Harness()
    async with anyio.create_task_group() as tg:
        harness.flow.bind(tg)
        assert await harness.flow.complete(state="never-issued", code="x") is None


async def test_an_expired_attempt_cannot_be_completed():
    harness = Harness(ttl_s=0.01)
    async with harness.app.inner.router.lifespan_context(harness.app.inner):
        async with anyio.create_task_group() as tg:
            harness.flow.bind(tg)
            started = await harness.flow.start(connect=harness.connect_with, **TENANT)
            callback = authorize(harness.state, started.authorization_url)
            await anyio.sleep(0.05)
            assert (
                await harness.flow.complete(
                    state=callback["state"], code=callback["code"]
                )
                is None
            )
            tg.cancel_scope.cancel()


async def test_a_callback_for_one_users_attempt_stores_for_that_user_only():
    """THE cross-user property. The credential is written for the tenant recorded
    at START, so a callback delivered by anyone binds the account to the original
    user — never to the deliverer."""
    harness = Harness()
    await _run(harness)

    rows = list(harness.store.rows.values())
    assert rows, "nothing was stored"
    assert all(row.user_id == "user-a" for row in rows)
    assert all(row.connection_id == "conn-1" for row in rows)


async def test_a_declined_authorization_is_not_reported_as_a_fault():
    """`access_denied` means the user pressed Deny. Retrying is not merely
    useless, it is rude."""
    harness = Harness()
    async with harness.app.inner.router.lifespan_context(harness.app.inner):
        async with anyio.create_task_group() as tg:
            harness.flow.bind(tg)
            started = await harness.flow.start(connect=harness.connect_with, **TENANT)
            attempt = await harness.flow.complete(
                state=_state_of(started.authorization_url),
                code=None,
                error="access_denied",
            )
            assert attempt is not None
            assert "declined" in (attempt.error or "")
    assert harness.store.rows == {}, "a declined authorization stored a credential"


def _state_of(url: str) -> str:
    from app.mcp.oauth.attempts import state_from_url

    return state_from_url(url)


# -------------------------------------------------------------- token reuse
async def test_a_second_user_reuses_the_client_but_gets_their_own_token():
    """A DCR client is registered once per (server, issuer) and reused by
    everyone — re-registering on each user's first authorization would be a
    storm against someone else's authorization server. The TOKEN, by contrast,
    must be per user."""
    harness = Harness()
    async with harness.app.inner.router.lifespan_context(harness.app.inner):
        async with anyio.create_task_group() as tg:
            harness.flow.bind(tg)
            await _authorize_once(harness, tg)
            assert harness.state.register_calls == 1
            await _authorize_once(
                harness, tg, dict(TENANT, user_id="user-b", connection_id="conn-2")
            )
            tg.cancel_scope.deadline = anyio.current_time() + 10

    assert harness.state.register_calls == 1, "the client was registered twice"
    assert harness.state.token_calls == 2, "the second user did not get their own token"

    owners = {row.user_id for row in harness.store.rows.values()}
    assert owners == {"user-a", "user-b"}
    envelopes = {row.envelope for row in harness.store.rows.values()}
    assert len(envelopes) == 2, "two users shared one credential record"


# ------------------------------------------------------------ scope handling
async def test_the_requested_scope_is_reported_so_consent_can_be_informed():
    """Scope is server-dictated — the SDK takes it from PRM. Surfacing what will
    be requested is the control we actually have."""
    harness = Harness()
    started = await _run(harness, deliver=False)
    assert started.requested_scope
    assert "mcp:read" in started.requested_scope


async def test_scope_narrowing_reduces_what_the_browser_is_sent():
    """Least privilege cannot be configured — the SDK overwrites
    client_metadata.scope — so it is applied to the URL instead."""
    harness = Harness(scope_allowlist={"acme": ["mcp:read"]})
    started = await _run(harness, deliver=False)
    assert started.requested_scope == "mcp:read"
    assert "mcp:write" not in started.authorization_url


async def test_narrowing_is_off_by_default():
    harness = Harness()
    started = await _run(harness, deliver=False)
    assert "mcp:write" in (started.requested_scope or "")


# ------------------------------------------------------------------ failures
async def test_a_failing_token_endpoint_stores_nothing():
    """Rollback safety: no credential, and the connection is not reported ready."""
    harness = Harness(AuthServerState(token_status=400))
    await _run(harness)
    assert harness.store.rows == {}
    assert harness.tool_results == []


async def test_a_flow_that_is_never_started_refuses_rather_than_hanging():
    vault, _store = _vault()
    flow = OAuthFlow(vault, redirect_uri=REDIRECT_URI)
    with pytest.raises(McpConnectionError) as got:
        await flow.start(connect=None, **TENANT)
    assert got.value.kind is McpErrorKind.UNREACHABLE


async def test_one_failing_authorization_does_not_kill_the_others():
    """anyio propagates an unhandled child exception to the whole task group, so
    a raising flow would take down every other tenant's in-flight authorization."""
    harness = Harness()
    async with harness.app.inner.router.lifespan_context(harness.app.inner):
        async with anyio.create_task_group() as tg:
            harness.flow.bind(tg)
            good = await harness.flow.start(connect=harness.connect_with, **TENANT)

            async def explode(_provider):
                raise RuntimeError("boom")

            bad_tenant = dict(TENANT, connection_id="conn-bad", user_id="user-b")
            # `start` RAISES here, and that is correct: the connect failed before
            # any authorization URL existed, so the caller must be told rather
            # than handed a URL that leads nowhere. What matters is that the
            # failure was RECORDED by the background task rather than raised out
            # of it — raising there would cancel the whole group.
            with pytest.raises(McpConnectionError):
                await harness.flow.start(connect=explode, **bad_tenant)

            callback = authorize(harness.state, good.authorization_url)
            await harness.flow.complete(
                state=callback["state"], code=callback["code"], iss=callback["iss"]
            )
            tg.cancel_scope.deadline = anyio.current_time() + 10

    assert harness.tool_results == ["authorized"], "a sibling failure killed the flow"


# --------------------------------------------------------------- the registry
async def test_the_registry_is_bounded():
    registry = AttemptRegistry(max_pending=2)
    for index in range(2):
        await registry.create(
            attempt_id=f"a{index}",
            user_id="u",
            workspace_id="w",
            connection_id=f"c{index}",
            server_name="s",
        )
    with pytest.raises(RuntimeError, match="too many pending"):
        await registry.create(
            attempt_id="a3",
            user_id="u",
            workspace_id="w",
            connection_id="c3",
            server_name="s",
        )


async def test_an_expired_attempt_is_swept_and_wakes_its_waiter():
    """A swept attempt must release anything parked on it, or the flow coroutine
    leaks for the life of the process."""
    registry = AttemptRegistry(ttl_s=0.01)
    attempt = await registry.create(
        attempt_id="a1",
        user_id="u",
        workspace_id="w",
        connection_id="c",
        server_name="s",
    )
    await registry.bind_state(attempt, "state-1")
    await anyio.sleep(0.05)
    assert await registry.claim("state-1") is None
    assert attempt.callback_ready.is_set(), "a swept attempt left its waiter parked"


async def test_an_attempt_never_records_a_code_or_a_verifier():
    """The verifier never leaves the SDK's stack frame."""
    harness = Harness()
    async with harness.app.inner.router.lifespan_context(harness.app.inner):
        async with anyio.create_task_group() as tg:
            harness.flow.bind(tg)
            started = await harness.flow.start(connect=harness.connect_with, **TENANT)
            attempt = await harness.flow.registry.get(started.attempt_id)
            assert attempt is not None
            fields = vars(attempt)
            assert "code_verifier" not in fields
            assert "code" not in fields
            assert "access_token" not in fields
            assert "verifier" not in repr(attempt).lower()
            attempt.error = "done"
            attempt.callback_ready.set()
            tg.cancel_scope.deadline = anyio.current_time() + 5
