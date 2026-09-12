"""`VaultTokenStorage` — the SDK's TokenStorage over the encrypted vault.

THE TEST THAT MATTERS IS `test_a_token_stored_before_it_expired_reads_as_invalid`.
It drives the REAL `OAuthClientProvider`, because the bug it guards against
lives in the SDK's behaviour, not in ours:

    _initialize()      loads tokens from storage and never sets token_expiry_time
    is_token_valid()   treats a missing expiry as VALID

so a token persisted with its relative `expires_in` looks fresh forever. Asserting
on our own conversion function would pass while the integration still broke; this
asserts on `provider.context.is_token_valid()` after a simulated restart.

The clamp case is here for the same reason: `expires_in = 0` means "expires
exactly now", which the SDK's `<=` comparison accepts. A `max(0, ...)` in the
conversion reintroduces the bug, and only a test at this level catches it.
"""

from __future__ import annotations

import base64
import json
import os
from datetime import UTC, datetime, timedelta

import pytest

from app.mcp.oauth.storage import CredentialIdentity, VaultTokenStorage
from app.mcp.vault.keys import KeyProvider
from app.mcp.vault.store import CredentialVault
from tests.test_mcp_vault_store import MemoryStore

IDENTITY = CredentialIdentity(
    user_id="user-a",
    workspace_id="ws-1",
    connection_id="conn-1",
    server_name="acme.test/server",
    resource="https://api.example.test/mcp",
)


def _storage(store: MemoryStore | None = None):
    store = store or MemoryStore()
    keys = KeyProvider(
        json.dumps({"1": base64.b64encode(os.urandom(32)).decode()}), 1
    )
    return VaultTokenStorage(CredentialVault(keys, store), IDENTITY), store


def _token(**overrides):
    from mcp.shared.auth import OAuthToken

    base = {
        "access_token": "opaque-runtime-token-abc",
        "token_type": "Bearer",
        "expires_in": 3600,
        "refresh_token": "refresh-xyz",
        "scope": "mcp:read",
    }
    base.update(overrides)
    return OAuthToken(**base)


async def _noop(*_args, **_kwargs):
    return None


def _provider(storage):
    """The provider OllaSuper actually builds — NOT a bare OAuthClientProvider.

    That distinction is the test: the expiry fix needs BOTH an absolute
    timestamp in storage and the `_initialize` override in `provider.py`. A test
    against the bare SDK class would fail, and a test against our own conversion
    function would pass while the integration stayed broken.
    """
    from app.mcp.oauth.provider import build_provider

    return build_provider(
        server_url="https://api.example.test/mcp",
        storage=storage,
        redirect_uri="https://cb.test/mcp/oauth/callback",
        redirect_handler=_noop,
        callback_handler=_noop,
    )


def _bare_provider(storage):
    """The SDK class as shipped, for the test that documents WHY the override
    exists."""
    from mcp.client.auth import OAuthClientProvider
    from mcp.shared.auth import OAuthClientMetadata

    return OAuthClientProvider(
        server_url="https://api.example.test/mcp",
        client_metadata=OAuthClientMetadata(
            redirect_uris=["https://cb.test/mcp/oauth/callback"]
        ),
        storage=storage,
    )


# ------------------------------------------------------------------ round trip
async def test_a_token_round_trips_through_the_vault():
    storage, _store = _storage()
    await storage.set_tokens(_token())
    got = await storage.get_tokens()
    assert got is not None
    assert got.access_token == "opaque-runtime-token-abc"
    assert got.refresh_token == "refresh-xyz"
    assert got.scope == "mcp:read"


async def test_only_ciphertext_reaches_the_store():
    storage, store = _storage()
    await storage.set_tokens(_token())
    assert store.saw
    for envelope in store.saw:
        assert "opaque-runtime-token-abc" not in envelope
        assert "refresh-xyz" not in envelope


async def test_a_missing_credential_reads_as_none():
    storage, _store = _storage()
    assert await storage.get_tokens() is None


# ------------------------------------------------------- THE expiry regression
async def test_a_token_stored_before_it_expired_reads_as_invalid():
    """Simulates a restart. Driven through the REAL provider, because the bug is
    in how the SDK interprets what we hand it."""
    storage, store = _storage()
    await storage.set_tokens(_token(expires_in=3600))

    # Age the stored row past its expiry without touching the ciphertext.
    row = next(iter(store.rows.values()))
    row.expires_at = datetime.now(UTC) - timedelta(hours=1)

    provider = _provider(storage)
    await provider._initialize()  # noqa: SLF001 — exactly what __aenter__ does

    assert provider.context.current_tokens is not None, "the token was not loaded"
    assert provider.context.is_token_valid() is False, (
        "an expired token read as valid after reload — the relative/absolute "
        "expiry conversion has regressed"
    )


async def test_the_unpatched_sdk_would_treat_the_same_token_as_valid():
    """Documents precisely why `provider.py` overrides `_initialize`.

    The SDK loads `current_tokens` from storage but never calls
    `update_token_expiry`, and `is_token_valid()` reads a missing expiry as
    valid. Storing an absolute timestamp does not help on its own, because
    nothing on that path reads `expires_in`. If this assertion ever flips, the
    SDK has fixed it upstream and our override can go.
    """
    storage, store = _storage()
    await storage.set_tokens(_token(expires_in=3600))
    next(iter(store.rows.values())).expires_at = datetime.now(UTC) - timedelta(hours=1)

    bare = _bare_provider(storage)
    await bare._initialize()  # noqa: SLF001
    assert bare.context.token_expiry_time is None
    assert bare.context.is_token_valid() is True


async def test_an_unexpired_token_survives_a_restart_as_valid():
    """The other half: the fix must not invalidate healthy tokens."""
    storage, store = _storage()
    await storage.set_tokens(_token(expires_in=3600))
    row = next(iter(store.rows.values()))
    row.expires_at = datetime.now(UTC) + timedelta(minutes=30)

    provider = _provider(storage)
    await provider._initialize()  # noqa: SLF001
    assert provider.context.is_token_valid() is True


async def test_the_remaining_lifetime_is_never_clamped_at_zero():
    """`expires_in = 0` means "expires exactly now", which the SDK's `<=`
    comparison ACCEPTS. A max(0, ...) here silently reintroduces the bug."""
    storage, store = _storage()
    await storage.set_tokens(_token(expires_in=3600))
    row = next(iter(store.rows.values()))
    row.expires_at = datetime.now(UTC) - timedelta(seconds=5)

    got = await storage.get_tokens()
    assert got.expires_in is not None
    assert got.expires_in < 0, f"expected a negative lifetime, got {got.expires_in}"


async def test_a_token_with_no_expiry_stays_without_one():
    storage, _store = _storage()
    await storage.set_tokens(_token(expires_in=None))
    got = await storage.get_tokens()
    assert got.expires_in is None


async def test_the_absolute_expiry_is_stored_in_plaintext_for_cheap_checks():
    """The refresh path asks "is this expired?" constantly; requiring a
    decryption for that would be a needless use of the key."""
    storage, store = _storage()
    await storage.set_tokens(_token(expires_in=600))
    row = next(iter(store.rows.values()))
    assert row.expires_at is not None
    assert not row.is_expired()
    assert row.scope == "mcp:read"


# ------------------------------------------------------------- robustness
async def test_a_corrupt_credential_forces_reauthorization_rather_than_wedging():
    storage, store = _storage()
    await storage.set_tokens(_token())
    row = next(iter(store.rows.values()))
    row.envelope = row.envelope[:-4] + "AAAA"

    assert await storage.get_tokens() is None, "a corrupt row must not raise"
    assert store.marked, "the row was not flagged unreadable"


async def test_a_payload_without_an_access_token_is_refused():
    storage, store = _storage()
    await storage.set_tokens(_token())
    # Re-seal a payload that is structurally valid JSON but not a token.
    await storage._vault.put(  # noqa: SLF001 — constructing the broken state
        {"token_type": "Bearer"}, **IDENTITY.as_tenant()
    )
    assert await storage.get_tokens() is None


async def test_a_persistence_failure_raises_so_authorization_fails(monkeypatch):
    """Rollback safety: the SDK re-raises out of `_auth_flow`, so the connection
    is never reported CONNECTED holding a token nothing can read."""
    storage, _store = _storage()

    async def boom(*_args, **_kwargs):
        raise RuntimeError("convex unavailable")

    monkeypatch.setattr(storage._vault, "put", boom)  # noqa: SLF001
    with pytest.raises(RuntimeError):
        await storage.set_tokens(_token())


# ----------------------------------------------------------- client records
async def test_client_info_round_trips_and_is_not_keyed_by_user():
    """A DCR client is registered once per (server, issuer) and reused by every
    user — keying it per user would re-register on each new user's first
    authorization, which is a registration storm against someone else's AS."""
    from mcp.shared.auth import OAuthClientInformationFull

    store = MemoryStore()
    first, _ = _storage(store)
    info = OAuthClientInformationFull(
        client_id="dyn-client-1",
        client_secret="cs-secret-value",
        redirect_uris=["https://cb.test/mcp/oauth/callback"],
    )
    await first.set_client_info(info)

    other_user = VaultTokenStorage(
        first._vault,  # noqa: SLF001 — same vault, different tenant
        CredentialIdentity(
            user_id="user-b",
            workspace_id="ws-2",
            connection_id="conn-2",
            server_name=IDENTITY.server_name,
            resource=IDENTITY.resource,
        ),
    )
    got = await other_user.get_client_info()
    assert got is not None
    assert got.client_id == "dyn-client-1"


async def test_a_client_secret_is_encrypted_like_a_token():
    """It is a credential. "Configuration" is not a safe place to keep one."""
    from mcp.shared.auth import OAuthClientInformationFull

    storage, store = _storage()
    await storage.set_client_info(
        OAuthClientInformationFull(
            client_id="dyn-1",
            client_secret="cs-super-secret",
            redirect_uris=["https://cb.test/cb"],
        )
    )
    assert store.clients
    for record in store.clients.values():
        assert "cs-super-secret" not in record.envelope
        assert record.envelope.startswith("v1.")


async def test_a_client_record_for_another_server_is_not_returned():
    from mcp.shared.auth import OAuthClientInformationFull

    store = MemoryStore()
    storage, _ = _storage(store)
    await storage.set_client_info(
        OAuthClientInformationFull(
            client_id="a", redirect_uris=["https://cb.test/cb"]
        )
    )
    elsewhere = VaultTokenStorage(
        storage._vault,  # noqa: SLF001
        CredentialIdentity(
            user_id="user-a",
            workspace_id="ws-1",
            connection_id="conn-1",
            server_name="other.test/server",
            resource="https://other.test/mcp",
        ),
    )
    assert await elsewhere.get_client_info() is None


async def test_an_unparseable_client_record_reads_as_none():
    storage, store = _storage()
    await storage._vault.put_client(  # noqa: SLF001
        {"not": "a client"}, server_name=IDENTITY.server_name, issuer=IDENTITY.resource
    )
    assert await storage.get_client_info() is None


def test_the_identity_never_renders_a_secret():
    assert "token" not in repr(IDENTITY).lower()
    assert IDENTITY.user_id in repr(IDENTITY)
