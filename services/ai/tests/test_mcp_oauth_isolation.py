"""Isolation, end to end — the §64/§65 properties, driven through the real flow.

The crypto tests prove the AAD binds. The store tests prove a wrong binding
fails. This file proves the two are actually WIRED together in the path a real
authorization takes, which is the part a binding can be correct and still not
protect anything.

THE FIVE DIMENSIONS, and why each one is separate rather than folded into
"tenant": user, workspace, connection, server and RESOURCE. The last is the one
most easily forgotten and the most expensive to get wrong — a token minted for
one MCP server, found by a lookup for another, is the confused-deputy problem in
its purest form. RFC 8707 binds the token at the authorization server; the AAD
and the lookup key bind it here, so it fails on both sides.

DEFENCE IN DEPTH IS TESTED AS DEPTH. Two independent mechanisms must each refuse
on their own:

  1. the LOOKUP — a query for the wrong tenant or resource finds no row at all;
  2. the AAD — even handed the right row and the right key, decryption fails.

A test that only checked (1) would pass against an implementation with no
encryption; one that only checked (2) would pass against an implementation that
handed every user the same row.
"""

from __future__ import annotations

import base64
import json
import os

import anyio
import pytest

from app.mcp.vault.aad import AadKind, build_aad
from app.mcp.vault.envelope import AuthenticationFailed, unseal
from app.mcp.vault.keys import KeyProvider
from app.mcp.vault.store import CredentialVault
from tests.fakes.oauth_server import MCP_URL, authorize
from tests.test_mcp_oauth_flow import TENANT, Harness, _authorize_once

pytestmark = pytest.mark.anyio

USER_B = dict(TENANT, user_id="user-b", connection_id="conn-2")


async def _two_users() -> Harness:
    """Two real authorizations against one server, inside one lifespan."""
    harness = Harness()
    async with harness.app.inner.router.lifespan_context(harness.app.inner):
        async with anyio.create_task_group() as tg:
            harness.flow.bind(tg)
            await _authorize_once(harness, tg)
            await _authorize_once(harness, tg, USER_B)
            tg.cancel_scope.deadline = anyio.current_time() + 15
    return harness


def _row_for(harness: Harness, user_id: str):
    rows = [r for r in harness.store.rows.values() if r.user_id == user_id]
    assert len(rows) == 1, f"expected one row for {user_id}, got {len(rows)}"
    return rows[0]


# ------------------------------------------------------- the lookup boundary
async def test_each_user_gets_their_own_credential_row():
    harness = await _two_users()
    rows = list(harness.store.rows.values())
    assert len(rows) == 2
    assert {r.user_id for r in rows} == {"user-a", "user-b"}
    # Two DISTINCT ciphertexts. Identical envelopes would mean one credential
    # wearing two rows.
    assert len({r.envelope for r in rows}) == 2
    assert len({r.credential_id for r in rows}) == 2


async def test_one_user_cannot_read_the_others_credential():
    """The realistic attack: a bug upstream that passes the wrong user id.

    Everything else is correct — the connection is real, the key is right, the
    row exists — and the read must still produce nothing.
    """
    harness = await _two_users()
    b_row = _row_for(harness, "user-b")

    # A asks for B's connection while claiming to be A. The lookup finds B's
    # row — the key is the connection — and the tenant check refuses it.
    found = await harness.vault.get(
        user_id="user-a",
        workspace_id=TENANT["workspace_id"],
        connection_id=b_row.connection_id,
        server_name=b_row.server_name,
        resource=b_row.resource,
    )
    assert found is None

    # AND THE VICTIM IS UNTOUCHED. This is the half that is easy to miss: a
    # refusal that marked B's row unreadable would cost B a re-authorization
    # every time anyone guessed their connection id.
    assert harness.store.marked == []
    still_works = await harness.vault.get(
        user_id="user-b",
        workspace_id=USER_B["workspace_id"],
        connection_id=b_row.connection_id,
        server_name=b_row.server_name,
        resource=b_row.resource,
    )
    assert still_works is not None


async def test_a_credential_is_not_found_under_another_connection():
    harness = await _two_users()
    found = await harness.vault.get(
        user_id="user-a",
        workspace_id=TENANT["workspace_id"],
        connection_id="conn-does-not-exist",
        server_name=TENANT["server_name"],
        resource=MCP_URL,
    )
    # No row at all — the lookup key leads with the connection.
    assert found is None


async def test_a_token_for_one_resource_is_not_found_for_another():
    """THE audience boundary. A token minted for server A must never be handed
    to a request bound for server B — that is the confused deputy."""
    harness = await _two_users()
    found = await harness.vault.get(
        user_id="user-a",
        workspace_id=TENANT["workspace_id"],
        connection_id=TENANT["connection_id"],
        server_name=TENANT["server_name"],
        resource="https://someone-elses-server.test/mcp",
    )
    assert found is None


async def test_the_resource_indicator_really_travelled_to_the_server():
    # The other half of the audience binding, enforced by the authorization
    # server rather than by us (RFC 8707).
    harness = await _two_users()
    assert harness.state.last_resource == MCP_URL


# ---------------------------------------------------------- the AAD boundary
@pytest.mark.parametrize(
    "override",
    [
        {"user_id": "user-b"},
        {"workspace_id": "ws-other"},
        {"connection_id": "conn-2"},
        {"server_name": "evil.test/server"},
        {"resource": "https://evil.test/mcp"},
        {"kind": AadKind.OAUTH_CLIENT},
    ],
    ids=["user", "workspace", "connection", "server", "resource", "kind"],
)
async def test_the_right_key_is_not_enough_to_open_the_wrong_binding(override):
    """Encryption as defence in depth, stated precisely.

    This test holds the CORRECT key and the CORRECT ciphertext and changes one
    binding field. If it ever passes, the AAD has stopped contributing anything
    and the only protection left is the authorization check — which is exactly
    the single point of failure the encryption exists to remove.
    """
    harness = await _two_users()
    row = _row_for(harness, "user-a")

    fields = {
        "kind": row.kind,
        "credential_id": row.credential_id,
        "user_id": row.user_id,
        "workspace_id": row.workspace_id,
        "connection_id": row.connection_id,
        "server_name": row.server_name,
        "resource": row.resource,
    }
    # The unmodified binding opens it — so a failure below is the override's
    # doing and not a broken fixture.
    key = harness.vault._keys.key_for(row.key_version)
    assert unseal(
        row.envelope, aad=build_aad(**fields), key=key, key_version=row.key_version
    )

    fields.update(override)
    with pytest.raises(AuthenticationFailed):
        unseal(
            row.envelope, aad=build_aad(**fields), key=key, key_version=row.key_version
        )


async def test_a_credential_cannot_be_moved_between_deployments():
    """A stolen row is useless without the master key.

    The scenario is a leaked database restored into a second deployment: same
    row, same tenancy, different key material.
    """
    harness = await _two_users()
    row = _row_for(harness, "user-a")

    other_keys = KeyProvider(
        json.dumps({"1": base64.b64encode(os.urandom(32)).decode()}), 1
    )
    other = CredentialVault(other_keys, harness.store)
    found = await other.get(
        user_id=row.user_id,
        workspace_id=row.workspace_id,
        connection_id=row.connection_id,
        server_name=row.server_name,
        resource=row.resource,
    )
    assert found is None


# ------------------------------------------------- the shared client record
async def test_the_client_record_is_shared_but_the_tokens_are_not():
    """A DCR client belongs to the DEPLOYMENT; a token belongs to a user.

    Getting this backwards either registers a client per user — a storm against
    somebody else's authorization server — or shares one token between users.
    """
    harness = await _two_users()
    assert harness.state.register_calls == 1
    assert harness.state.token_calls == 2
    assert len(harness.store.clients) == 1
    assert len(harness.store.rows) == 2


async def test_concurrent_first_time_authorizations_do_not_storm_registration():
    """N users arriving at once must not each register their own client.

    THE HONEST BOUND, because there is no registration lock. MEASURED over three
    runs: five concurrent first-time authorizations produced exactly ONE
    registration every time — but that is in-process scheduling, not a
    guarantee, and with real network latency more are possible. So the assertion
    is the property that actually matters (not one per user) rather than a
    number that would be flaky against a real server.

    A lock was considered and rejected: it cannot be held across
    `get_client_info` and `set_client_info`, which are separate SDK callbacks
    with the registration request between them, so a failed registration would
    leave it held forever. The consequence of the race is bounded — each
    registration is a valid client, `put_client` keeps one record per
    `(server, issuer)`, and the surplus is waste rather than incorrectness.
    """
    harness = Harness()
    tenants = [
        dict(TENANT, user_id=f"user-{i}", connection_id=f"conn-{i}") for i in range(5)
    ]

    async with harness.app.inner.router.lifespan_context(harness.app.inner):
        async with anyio.create_task_group() as tg:
            harness.flow.bind(tg)

            async def one(tenant: dict) -> None:
                started = await harness.flow.start(
                    connect=harness.connect_with, **tenant
                )
                callback = authorize(harness.state, started.authorization_url)
                await harness.flow.complete(
                    state=callback["state"],
                    code=callback["code"],
                    iss=callback["iss"],
                )

            async with anyio.create_task_group() as inner:
                for tenant in tenants:
                    inner.start_soon(one, tenant)
            tg.cancel_scope.deadline = anyio.current_time() + 20

    assert len(harness.store.rows) == 5, "not every user got a credential"
    assert harness.state.token_calls == 5
    # What must never happen is one registration per user.
    assert harness.state.register_calls < 5, (
        f"registered {harness.state.register_calls} clients for 5 users — "
        "the client record is not being reused"
    )


async def test_five_concurrent_users_each_hold_a_distinct_credential():
    harness = Harness()
    tenants = [
        dict(TENANT, user_id=f"user-{i}", connection_id=f"conn-{i}") for i in range(5)
    ]
    async with harness.app.inner.router.lifespan_context(harness.app.inner):
        async with anyio.create_task_group() as tg:
            harness.flow.bind(tg)

            async def one(tenant: dict) -> None:
                started = await harness.flow.start(
                    connect=harness.connect_with, **tenant
                )
                callback = authorize(harness.state, started.authorization_url)
                await harness.flow.complete(
                    state=callback["state"],
                    code=callback["code"],
                    iss=callback["iss"],
                )

            async with anyio.create_task_group() as inner:
                for tenant in tenants:
                    inner.start_soon(one, tenant)
            tg.cancel_scope.deadline = anyio.current_time() + 20

    rows = list(harness.store.rows.values())
    assert len({r.user_id for r in rows}) == 5
    assert len({r.envelope for r in rows}) == 5
    assert len({r.credential_id for r in rows}) == 5

    # And each one opens only under its own binding.
    for row in rows:
        key = harness.vault._keys.key_for(row.key_version)
        mine = build_aad(
            kind=row.kind,
            credential_id=row.credential_id,
            user_id=row.user_id,
            workspace_id=row.workspace_id,
            connection_id=row.connection_id,
            server_name=row.server_name,
            resource=row.resource,
        )
        assert unseal(row.envelope, aad=mine, key=key, key_version=row.key_version)
        for other in rows:
            if other.credential_id == row.credential_id:
                continue
            theirs = build_aad(
                kind=other.kind,
                credential_id=other.credential_id,
                user_id=other.user_id,
                workspace_id=other.workspace_id,
                connection_id=other.connection_id,
                server_name=other.server_name,
                resource=other.resource,
            )
            with pytest.raises(AuthenticationFailed):
                unseal(row.envelope, aad=theirs, key=key, key_version=row.key_version)


# ------------------------------------------------------------ the store view
async def test_the_store_never_saw_a_plaintext_token_for_either_user():
    harness = await _two_users()
    # Both users' access tokens, as the authorization server actually issued
    # them — not reconstructed from what we stored.
    for token in harness.state.issued_access:
        for envelope in harness.store.saw:
            assert token not in envelope
    assert len(harness.state.issued_access) == 2
