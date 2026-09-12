"""The five `/v1/mcp/oauth/*` routes: who may call them, and what they refuse.

WHY THE 401 TESTS ARE THE LOAD-BEARING ONES. Every body here carries `user_id`
and `workspace_id`, which is safe ONLY because the router sits behind
`require_service_key` and the caller is a Convex action that has already run
`requireUserId` and verified connection ownership. If one of these routes ever
answered without a service key, a client-supplied `user_id` would become an
impersonation primitive pointed straight at somebody else's credential vault.

THE SECOND RULE THESE TESTS PIN DOWN: curation is the gate. The catalogue holds
30,871 servers. Without the curated check a caller could name any of them and
make this deployment start an OAuth flow — with its own client identity —
against a third party nobody approved.

THE THIRD: the callback body carries NO tenant, deliberately. The credential is
written for whoever STARTED the flow, found by `state`. Accepting a user id on
the callback would let the callback declare whose account to bind, which is
exactly the cross-user binding the design prevents. `extra="forbid"` makes that
a 422 rather than a silently-ignored field.
"""

from __future__ import annotations

import httpx
import pytest
from httpx import ASGITransport

from app.main import create_app
from tests.conftest import make_settings

SERVICE_KEY = "test-service-key-aaaaaaaaaaaaaaaaaaaa"
AUTH = {"x-service-key": SERVICE_KEY}

BODY = {
    "connection_id": "conn-1",
    "server_name": "test.fixture/fake",
    "user_id": "user-a",
    "workspace_id": "ws-1",
}

TENANT_ROUTES = [
    "/v1/mcp/oauth/probe",
    "/v1/mcp/oauth/start",
    "/v1/mcp/oauth/status",
    "/v1/mcp/oauth/disconnect",
]
ALL_ROUTES = [*TENANT_ROUTES, "/v1/mcp/oauth/callback"]


def _body_for(path: str) -> dict:
    return {"state": "st_abc", "code": "c"} if path.endswith("callback") else BODY


def _app(*, flow=None, vault=None, db=None, pool=None, **setting_overrides):
    app = create_app()
    app.state.settings = make_settings("http://x", **setting_overrides)
    app.state.db = db
    app.state.mcp_pool = pool
    app.state.mcp_vault = vault
    app.state.mcp_oauth_flow = flow
    app.state.tool_registry = None
    return app


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# --------------------------------------------------------------------- auth
@pytest.mark.parametrize("path", ALL_ROUTES)
async def test_every_oauth_route_requires_the_service_key(path):
    app = _app()
    async with _client(app) as c:
        assert (await c.post(path, json=_body_for(path))).status_code == 401


@pytest.mark.parametrize("path", ALL_ROUTES)
async def test_a_wrong_service_key_is_refused(path):
    app = _app()
    async with _client(app) as c:
        r = await c.post(
            path, json=_body_for(path), headers={"x-service-key": "nope"}
        )
        assert r.status_code == 401


# ------------------------------------------------------------ not configured
@pytest.mark.parametrize(
    "path", ["/v1/mcp/oauth/start", "/v1/mcp/oauth/callback"]
)
async def test_the_flow_routes_503_when_oauth_is_off(path):
    """503, not 500. OAuth being disabled is a deployment state, and the
    difference decides whether an operator reads a stack trace or a sentence."""
    app = _app(db=object(), flow=None)
    async with _client(app) as c:
        r = await c.post(path, json=_body_for(path), headers=AUTH)
        assert r.status_code == 503
        assert "not enabled" in r.json()["detail"]


async def test_status_and_disconnect_503_without_a_vault():
    """Fail CLOSED. There is no default key and no unencrypted fallback: an
    unkeyed vault must refuse, never quietly store plaintext."""
    app = _app(db=_CuratedDb(), vault=None)
    async with _client(app) as c:
        for path in ("/v1/mcp/oauth/status", "/v1/mcp/oauth/disconnect"):
            r = await c.post(path, json=BODY, headers=AUTH)
            assert r.status_code == 503, path
            assert "vault" in r.json()["detail"]


async def test_every_tenant_route_503s_without_the_catalogue_database():
    app = _app(db=None, vault=object(), flow=object())
    async with _client(app) as c:
        for path in TENANT_ROUTES:
            r = await c.post(path, json=BODY, headers=AUTH)
            assert r.status_code == 503, path


# ------------------------------------------------------------------ curation
class _CuratedDb:
    """Stands in for the catalogue engine. `curated.resolve` is patched around
    it, so what matters here is only that `app.state.db` is not None."""


class _Row:
    def __init__(self, *, enabled: bool = True) -> None:
        self.slug = "fake"
        self.server_name = "test.fixture/fake"
        self.endpoint_url = "https://fake.test/mcp"
        self.transport = "streamable-http"
        self.auth_kind = "oauth"
        self.version = "1.0.0"
        self.trusted = True
        self.enabled = enabled


@pytest.mark.parametrize("path", TENANT_ROUTES)
async def test_an_uncurated_server_is_404_not_an_oauth_flow(path, monkeypatch):
    """Curation is the gate on 30,871 catalogued servers.

    Without it a caller names any server in the registry and this deployment
    registers an OAuth client against it — a third party nobody approved, using
    our identity.
    """
    from app.mcp.registry import curated

    async def resolve(_engine, _name):
        return None

    monkeypatch.setattr(curated, "resolve", resolve)
    app = _app(db=_CuratedDb(), vault=object(), flow=object())
    async with _client(app) as c:
        r = await c.post(path, json=BODY, headers=AUTH)
        assert r.status_code == 404, path
        assert "curated" in r.json()["detail"]


@pytest.mark.parametrize("path", TENANT_ROUTES)
async def test_a_disabled_curated_row_is_refused_exactly_like_an_absent_one(
    path, monkeypatch
):
    # An operator turning a server off must stop new authorizations, not merely
    # hide it from a list.
    from app.mcp.registry import curated

    async def resolve(_engine, _name):
        return _Row(enabled=False)

    monkeypatch.setattr(curated, "resolve", resolve)
    app = _app(db=_CuratedDb(), vault=object(), flow=object())
    async with _client(app) as c:
        assert (await c.post(path, json=BODY, headers=AUTH)).status_code == 404


# ---------------------------------------------------------------- validation
@pytest.mark.parametrize("path", TENANT_ROUTES)
async def test_an_unknown_field_is_rejected_rather_than_dropped(path):
    """`extra="forbid"`, matching `GenerateRequest`: an unknown field means the
    two planes are at different versions, and that must fail at the boundary
    rather than be silently dropped into an authorization."""
    app = _app(db=_CuratedDb(), vault=object(), flow=object())
    async with _client(app) as c:
        r = await c.post(
            path, json={**BODY, "impersonate": "someone-else"}, headers=AUTH
        )
        assert r.status_code == 422, path


@pytest.mark.parametrize(
    "missing", ["connection_id", "server_name", "user_id", "workspace_id"]
)
async def test_the_tenant_identity_is_mandatory(missing):
    """There is no default user and no default workspace. A route that authorized
    an account without both would be acting on somebody's behalf without knowing
    whose."""
    app = _app(db=_CuratedDb(), vault=object(), flow=object())
    body = {k: v for k, v in BODY.items() if k != missing}
    async with _client(app) as c:
        r = await c.post("/v1/mcp/oauth/start", json=body, headers=AUTH)
        assert r.status_code == 422


async def test_an_empty_identity_string_is_refused():
    app = _app(db=_CuratedDb(), vault=object(), flow=object())
    async with _client(app) as c:
        r = await c.post(
            "/v1/mcp/oauth/start", json={**BODY, "user_id": ""}, headers=AUTH
        )
        assert r.status_code == 422


async def test_the_callback_refuses_to_be_told_which_tenant_it_is_for():
    """THE cross-user binding control, expressed as a schema.

    `CallbackBody` has no tenant fields at all, so a callback that tries to
    declare one is a 422 — not a field that is accepted and then ignored, which
    would be one refactor away from being honoured.
    """
    app = _app(db=_CuratedDb(), vault=object(), flow=_Flow())
    async with _client(app) as c:
        for field in ("user_id", "workspace_id", "connection_id"):
            r = await c.post(
                "/v1/mcp/oauth/callback",
                json={"state": "st_abc", "code": "c", field: "user-b"},
                headers=AUTH,
            )
            assert r.status_code == 422, field


async def test_the_callback_requires_a_state():
    app = _app(db=_CuratedDb(), vault=object(), flow=_Flow())
    async with _client(app) as c:
        r = await c.post("/v1/mcp/oauth/callback", json={"code": "c"}, headers=AUTH)
        assert r.status_code == 422
        r = await c.post(
            "/v1/mcp/oauth/callback", json={"state": "", "code": "c"}, headers=AUTH
        )
        assert r.status_code == 422


async def test_an_oversized_code_is_refused_before_it_reaches_the_flow():
    # A bounded field is what stops a hostile redirect making this service
    # allocate, log and forward a megabyte.
    flow = _Flow()
    app = _app(db=_CuratedDb(), vault=object(), flow=flow)
    async with _client(app) as c:
        r = await c.post(
            "/v1/mcp/oauth/callback",
            json={"state": "st_abc", "code": "x" * 4096},
            headers=AUTH,
        )
        assert r.status_code == 422
    assert flow.completed == []


# ------------------------------------------------------------------ callback
class _Attempt:
    def __init__(self, error: str | None = None) -> None:
        self.error = error


class _Flow:
    """Records what the route asked of it; answers what the test wants."""

    def __init__(
        self, attempt: object | None = None, completed_ok: bool = True
    ) -> None:
        self._attempt = attempt
        self._ok = completed_ok
        self.completed: list[dict] = []

    async def complete(self, *, state, code, iss=None, error=None):
        self.completed.append(
            {"state": state, "code": code, "iss": iss, "error": error}
        )
        return self._attempt

    async def wait_for_completion(self, _attempt, **_kwargs):
        return self._ok


async def test_an_unmatched_state_answers_the_same_as_any_other():
    """No oracle. Expired, replayed and forged must be indistinguishable — a
    different answer for any of them tells an attacker which states exist."""
    app = _app(db=_CuratedDb(), vault=object(), flow=_Flow(attempt=None))
    async with _client(app) as c:
        r = await c.post(
            "/v1/mcp/oauth/callback",
            json={"state": "st_forged", "code": "c"},
            headers=AUTH,
        )
        assert r.status_code == 200
        assert r.json() == {
            "ok": False,
            "auth_state": "ERROR",
            "detail": "no pending authorization",
        }


async def test_a_completed_authorization_reports_connected():
    flow = _Flow(attempt=_Attempt(), completed_ok=True)
    app = _app(db=_CuratedDb(), vault=object(), flow=flow)
    async with _client(app) as c:
        r = await c.post(
            "/v1/mcp/oauth/callback",
            json={"state": "st_abc", "code": "c", "iss": "https://issuer.test"},
            headers=AUTH,
        )
        assert r.json() == {"ok": True, "auth_state": "CONNECTED"}
    # The route forwards verbatim and adds nothing of its own.
    assert flow.completed == [
        {"state": "st_abc", "code": "c", "iss": "https://issuer.test", "error": None}
    ]


async def test_a_failed_authorization_reports_the_classified_detail():
    flow = _Flow(attempt=_Attempt(error="authorization was declined (access_denied)"))
    flow._ok = False
    app = _app(db=_CuratedDb(), vault=object(), flow=flow)
    async with _client(app) as c:
        r = await c.post(
            "/v1/mcp/oauth/callback",
            json={"state": "st_abc", "error": "access_denied"},
            headers=AUTH,
        )
        body = r.json()
        assert body["ok"] is False
        assert body["auth_state"] == "ERROR"
        # A code and a sentence — never the provider's raw body.
        assert "access_denied" in body["detail"]


async def test_no_oauth_response_ever_carries_a_credential():
    """The blanket rule, asserted on the actual bytes.

    Not a code-reading exercise: every response body in this module is scanned
    for the field names that must never cross, so adding one later fails here.
    """
    forbidden = (
        "access_token",
        "refresh_token",
        "client_secret",
        "code_verifier",
        "authorization_code",
    )
    flow = _Flow(attempt=_Attempt(), completed_ok=True)
    app = _app(db=_CuratedDb(), vault=_Vault(), flow=flow)
    async with _client(app) as c:
        bodies = [
            (
                await c.post(
                    "/v1/mcp/oauth/callback",
                    json={"state": "st_abc", "code": "supersecretcode"},
                    headers=AUTH,
                )
            ).text
        ]
        from app.mcp.registry import curated

        original = curated.resolve

        async def resolve(_engine, _name):
            return _Row()

        curated.resolve = resolve  # type: ignore[assignment]
        try:
            bodies.append(
                (
                    await c.post("/v1/mcp/oauth/status", json=BODY, headers=AUTH)
                ).text
            )
        finally:
            curated.resolve = original  # type: ignore[assignment]

    for text in bodies:
        for name in forbidden:
            assert name not in text, f"{name} appeared in {text}"
        assert "supersecretcode" not in text


# -------------------------------------------------------------------- status
class _Vault:
    """A vault holding one credential, so `status` has something to project."""

    def __init__(self, found: bool = True) -> None:
        self._found = found

    async def get(self, **_kwargs):
        if not self._found:
            return None
        from datetime import UTC, datetime, timedelta

        from app.mcp.vault.models import CredentialRecord

        record = CredentialRecord(
            credential_id="cred_1",
            user_id="user-a",
            workspace_id="ws-1",
            connection_id="conn-1",
            server_name="test.fixture/fake",
            resource="https://fake.test/mcp",
            kind="oauth_token",
            envelope="v1.1.AAAAAAAAAAAAAAAA.Y2lwaGVy",
            key_version=1,
            expires_at=datetime.now(UTC) + timedelta(hours=1),
            scope="mcp:read mcp:write",
        )
        return {"access_token": "at-secret", "refresh_token": "rt-secret"}, record

    async def delete(self, **_kwargs):
        return True


async def test_status_projects_scope_and_expiry_but_never_the_envelope(monkeypatch):
    from app.mcp.registry import curated

    async def resolve(_engine, _name):
        return _Row()

    monkeypatch.setattr(curated, "resolve", resolve)
    app = _app(db=_CuratedDb(), vault=_Vault(), flow=object())
    async with _client(app) as c:
        r = await c.post("/v1/mcp/oauth/status", json=BODY, headers=AUTH)
        assert r.status_code == 200
        body = r.json()
        assert body["auth_state"] == "CONNECTED"
        assert body["scope"] == "mcp:read mcp:write"
        assert "envelope" not in r.text
        assert "at-secret" not in r.text
        assert "rt-secret" not in r.text


async def test_status_reports_authorization_required_when_nothing_is_stored(
    monkeypatch,
):
    from app.mcp.registry import curated

    async def resolve(_engine, _name):
        return _Row()

    monkeypatch.setattr(curated, "resolve", resolve)
    app = _app(db=_CuratedDb(), vault=_Vault(found=False), flow=object())
    async with _client(app) as c:
        r = await c.post("/v1/mcp/oauth/status", json=BODY, headers=AUTH)
        assert r.json() == {"auth_state": "AUTHORIZATION_REQUIRED", "scope": None}


async def test_an_expired_token_reads_as_expired_not_as_an_error(monkeypatch):
    """TOKEN_EXPIRED, not ERROR: a refresh token may still recover this with
    the user doing nothing at all."""
    from datetime import UTC, datetime, timedelta

    from app.mcp.registry import curated
    from app.mcp.vault.models import CredentialRecord

    async def resolve(_engine, _name):
        return _Row()

    class ExpiredVault(_Vault):
        async def get(self, **_kwargs):
            record = CredentialRecord(
                credential_id="cred_1",
                user_id="user-a",
                workspace_id="ws-1",
                connection_id="conn-1",
                server_name="test.fixture/fake",
                resource="https://fake.test/mcp",
                kind="oauth_token",
                envelope="v1.1.AAAAAAAAAAAAAAAA.Y2lwaGVy",
                key_version=1,
                expires_at=datetime.now(UTC) - timedelta(seconds=1),
                scope="mcp:read",
            )
            return {"access_token": "at"}, record

    monkeypatch.setattr(curated, "resolve", resolve)
    app = _app(db=_CuratedDb(), vault=ExpiredVault(), flow=object())
    async with _client(app) as c:
        r = await c.post("/v1/mcp/oauth/status", json=BODY, headers=AUTH)
        assert r.json()["auth_state"] == "TOKEN_EXPIRED"


# ---------------------------------------------------------------- disconnect
async def test_disconnect_kills_the_session_before_deleting_the_credential(
    monkeypatch,
):
    """Order matters. Deleting first would leave an in-flight tool call holding
    a credential that no longer exists, and still using it."""
    from app.mcp.registry import curated

    async def resolve(_engine, _name):
        return _Row()

    monkeypatch.setattr(curated, "resolve", resolve)

    order: list[str] = []

    class Pool:
        async def discard(self, key):
            order.append(f"discard:{key}")

    class Vault(_Vault):
        async def get(self, **kwargs):
            return None  # nothing to revoke remotely

        async def delete(self, **_kwargs):
            order.append("delete")
            return True

    app = _app(db=_CuratedDb(), vault=Vault(), flow=object(), pool=Pool())
    async with _client(app) as c:
        r = await c.post("/v1/mcp/oauth/disconnect", json=BODY, headers=AUTH)
        body = r.json()

    assert order == ["discard:('user-a', 'ws-1', 'conn-1')", "delete"]
    assert body["deleted_locally"] is True
    assert body["auth_state"] == "NOT_CONNECTED"
    # Never claim a remote revocation that did not happen.
    assert body["revoked_remotely"] == "unsupported"


async def test_disconnect_without_a_pool_still_deletes(monkeypatch):
    # A disabled pool must not stop a user removing their credential.
    from app.mcp.registry import curated

    async def resolve(_engine, _name):
        return _Row()

    monkeypatch.setattr(curated, "resolve", resolve)

    class Vault(_Vault):
        async def get(self, **_kwargs):
            return None

    app = _app(db=_CuratedDb(), vault=Vault(), flow=object(), pool=None)
    async with _client(app) as c:
        r = await c.post("/v1/mcp/oauth/disconnect", json=BODY, headers=AUTH)
        assert r.json()["deleted_locally"] is True
