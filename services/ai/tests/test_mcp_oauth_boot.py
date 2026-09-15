"""What the lifespan builds — and, more importantly, what it refuses to build.

THREE STATES, and the difference between them has to be visible at boot rather
than discovered on a user's first authorization:

  1. `mcp_oauth_enabled=False` — no vault, no flow, and the pooled resolver is
     the Phase 3 one. The deployment is byte-identical to Phase 3.
  2. enabled AND keyed — vault, flow, and the vault-backed resolver.
  3. enabled but UNKEYED — the service REFUSES TO START.

(3) is the one worth the test. There is deliberately no generated default key:
a key minted at boot would encrypt credentials that no later process — no
restart, no second worker, no rollback — could ever read, and the failure would
surface as every user's account silently disconnecting. Failing at boot is the
only honest option, and it is the behaviour an operator is most likely to hit,
because setting the flag is easier to remember than filling in a key.
"""

from __future__ import annotations

import base64
import json
import os
from contextlib import AsyncExitStack

import pytest

import app.main as main_mod
from app.main import create_app
from app.mcp.vault.keys import VaultKeyError
from tests.conftest import make_settings
from tests.test_mcp_routes import _patched

pytestmark = pytest.mark.anyio

KEYS = json.dumps({"1": base64.b64encode(os.urandom(32)).decode()})


def _settings(**overrides):
    return make_settings("http://x", mcp_connections_enabled=True, **overrides)


async def _boot(settings):
    """Run the real lifespan and hand back the app it configured."""
    app = create_app()
    async with AsyncExitStack() as stack:
        stack.enter_context(_patched(main_mod, "get_settings", lambda: settings))
        async with main_mod.lifespan(app):
            yield app


async def test_oauth_off_builds_no_vault_and_no_flow():
    settings = _settings(mcp_oauth_enabled=False)
    async for app in _boot(settings):
        assert app.state.mcp_vault is None
        assert app.state.mcp_oauth_flow is None
        # The pool still exists — Phase 3 connections are unaffected.
        assert app.state.mcp_pool is not None


async def test_oauth_on_and_keyed_builds_both():
    settings = _settings(
        mcp_oauth_enabled=True,
        mcp_credential_keys=KEYS,
        mcp_credential_active_key_version=1,
    )
    async for app in _boot(settings):
        assert app.state.mcp_vault is not None
        assert app.state.mcp_oauth_flow is not None
        # The flow must have a task group, or `start` refuses with
        # "the OAuth flow is not running" on the first authorization.
        assert app.state.mcp_oauth_flow._task_group is not None


async def test_the_pooled_resolver_becomes_the_vault_backed_one():
    """The seam that makes a pooled tool call able to refresh silently.

    With OAuth off the pool keeps the Phase 3 static resolver; with it on the
    pool must hold the vault-backed one, or a stored credential would never
    reach a session.
    """
    from app.mcp.credentials import EnvCredentialResolver, VaultCredentialResolver

    settings = _settings(
        mcp_oauth_enabled=True,
        mcp_credential_keys=KEYS,
        mcp_credential_active_key_version=1,
    )
    async for app in _boot(settings):
        resolver = app.state.mcp_pool._resolver
        assert isinstance(resolver, VaultCredentialResolver)

    async for app in _boot(_settings(mcp_oauth_enabled=False)):
        assert isinstance(app.state.mcp_pool._resolver, EnvCredentialResolver)


@pytest.mark.parametrize(
    "keys",
    ["", "   ", "not json", "{}", '{"1": "short"}', '{"1": "!!!not-base64!!!"}'],
    ids=["empty", "blank", "garbage", "no-versions", "short-key", "bad-base64"],
)
async def test_enabled_but_unkeyed_refuses_to_start(keys):
    """FAIL CLOSED at boot. No default key, no plaintext fallback, no warning-
    and-continue — any of those would produce a deployment that looks healthy
    and loses every credential written to it."""
    settings = _settings(
        mcp_oauth_enabled=True,
        mcp_credential_keys=keys,
        mcp_credential_active_key_version=1,
    )
    app = create_app()
    with pytest.raises(VaultKeyError) as caught:
        async with AsyncExitStack() as stack:
            stack.enter_context(_patched(main_mod, "get_settings", lambda: settings))
            async with main_mod.lifespan(app):
                pass
    # The message has to be actionable — an operator reads it and knows what to
    # set. And it must never echo whatever material WAS supplied.
    message = str(caught.value)
    assert "MCP_CREDENTIAL_KEYS" in message
    if keys.strip():
        assert keys.strip() not in message


async def test_an_active_version_with_no_material_refuses_to_start():
    # A typo in the version number is the same failure as a missing key, and
    # must be just as loud.
    settings = _settings(
        mcp_oauth_enabled=True,
        mcp_credential_keys=KEYS,
        mcp_credential_active_key_version=7,
    )
    app = create_app()
    with pytest.raises(VaultKeyError) as caught:
        async with AsyncExitStack() as stack:
            stack.enter_context(_patched(main_mod, "get_settings", lambda: settings))
            async with main_mod.lifespan(app):
                pass
    # It names the version AND what is available, so the typo is obvious.
    assert "MCP_CREDENTIAL_ACTIVE_KEY_VERSION=7" in str(caught.value)


# ------------------------------------------------------------ scope allowlist
def test_the_scope_allowlist_is_off_by_default():
    """Narrowing is DEFAULT OFF, and that is a decision rather than an oversight.

    When the authorization server omits `scope` from the token response the SDK
    back-fills the WIDE `client_metadata.scope`, so a narrowed request would be
    recorded as a wider grant unless corrected. Subtle enough that an operator
    must opt in.
    """
    assert main_mod._scope_allowlist(make_settings("http://x")) == {}


@pytest.mark.parametrize("raw", ["", "   "])
def test_an_absent_allowlist_is_empty(raw):
    # Empty means "request what the server asks for" — the specification's own
    # behaviour, not a silent widening of anything.
    settings = make_settings("http://x", mcp_oauth_scope_allowlist=raw)
    assert main_mod._scope_allowlist(settings) == {}


@pytest.mark.parametrize(
    "raw", ["not json", "[]", '"a string"', "null", '{"gmail": "x"}', '{"gmail": [1]}']
)
def test_a_malformed_allowlist_refuses_boot(raw):
    """Audit M-01. An earlier version logged and returned {} — an operator who
    had narrowed Gmail to read-only and then made a typo silently got
    full-scope authorizations. A narrowing that cannot be parsed must not
    widen; boot refuses so the operator sees it."""
    settings = make_settings("http://x", mcp_oauth_scope_allowlist=raw)
    with pytest.raises(RuntimeError, match="MCP_OAUTH_SCOPE_ALLOWLIST"):
        main_mod._scope_allowlist(settings)


def test_a_well_formed_allowlist_is_parsed_per_server():
    settings = make_settings(
        "http://x",
        mcp_oauth_scope_allowlist=json.dumps(
            {"acme": ["mcp:read"], "other": ["a", "b"]}
        ),
    )
    assert main_mod._scope_allowlist(settings) == {
        "acme": ["mcp:read"],
        "other": ["a", "b"],
    }


def test_the_credential_keys_are_registered_as_a_secret():
    """`Settings.secrets()` feeds the log redactor. A master key that is not in
    it would be redacted only by shape — and base64 has no shape."""
    settings = make_settings("http://x", mcp_credential_keys=KEYS)
    assert KEYS in settings.secrets()


def test_environment_credentials_refuse_boot_unless_explicitly_allowed():
    """Audit M-08. `MCP_TEST_CREDENTIALS` holds a real third-party secret in a
    process env var; it is a development convenience, not a production
    credential source. Without `MCP_ALLOW_ENV_CREDENTIALS` the service refuses
    to boot with it set — loudly, at startup, not silently on a user's turn."""
    raw = '{"github": "ghp_x"}'
    with pytest.raises(RuntimeError, match="MCP_ALLOW_ENV_CREDENTIALS"):
        main_mod._env_credentials(make_settings("http://x", mcp_test_credentials=raw))
    allowed = make_settings(
        "http://x", mcp_test_credentials=raw, mcp_allow_env_credentials=True
    )
    assert main_mod._env_credentials(allowed) == {"github": "ghp_x"}
    assert main_mod._env_credentials(make_settings("http://x")) == {}
