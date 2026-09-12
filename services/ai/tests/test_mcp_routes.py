"""The /v1/mcp connection routes: auth, 503-when-disabled, and the refusals
that must happen before any packet leaves.

Mirrors `test_tools_route.py`'s app wiring.

THE POINT OF THE AUTH TESTS. Every mutating route accepts `user_id` and
`workspace_id` in its BODY, which is only safe because the router sits behind
`require_service_key` and the caller is a Convex action that has already run
`requireUserId` + `requireMember`. If any of these routes ever answered without
a service key, a client-supplied `user_id` would become an impersonation
primitive. So the 401 tests are not boilerplate — they are the thing holding the
tenancy model up.
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

MUTATING = [
    ("/v1/mcp/connections/preflight", BODY),
    ("/v1/mcp/connections/conn-1/connect", BODY),
    ("/v1/mcp/connections/conn-1/refresh", BODY),
    ("/v1/mcp/connections/conn-1/disconnect", BODY),
    ("/v1/mcp/connections/conn-1/status", BODY),
]


def _app(*, pool=None, db=None, **setting_overrides):
    app = create_app()
    app.state.settings = make_settings("http://x", **setting_overrides)
    app.state.db = db
    app.state.mcp_pool = pool
    app.state.tool_registry = None
    return app


async def _client(app):
    return httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    )


# --------------------------------------------------------------------- auth
@pytest.mark.parametrize(("path", "body"), MUTATING)
async def test_every_connection_route_requires_the_service_key(path, body):
    """Without this, a client-supplied user_id would be an impersonation
    primitive."""
    app = _app()
    c = await _client(app)
    try:
        assert (await c.post(path, json=body)).status_code == 401
    finally:
        await c.aclose()


async def test_the_read_routes_require_the_service_key_too():
    app = _app()
    c = await _client(app)
    try:
        assert (await c.get("/v1/mcp/curated")).status_code == 401
        assert (await c.get("/v1/mcp/pool")).status_code == 401
    finally:
        await c.aclose()


async def test_a_wrong_service_key_is_refused():
    app = _app()
    c = await _client(app)
    try:
        r = await c.get("/v1/mcp/curated", headers={"x-service-key": "nope"})
        assert r.status_code == 401
    finally:
        await c.aclose()


# ------------------------------------------------------------ not configured
@pytest.mark.parametrize(
    "path",
    [
        "/v1/mcp/connections/conn-1/connect",
        "/v1/mcp/connections/conn-1/refresh",
        "/v1/mcp/connections/conn-1/disconnect",
        "/v1/mcp/connections/conn-1/status",
    ],
)
async def test_connection_routes_503_when_connections_are_disabled(path):
    """503, not 500: MCP connections being off is a deployment state, not a
    bug, and the difference decides whether an operator reads a stack trace."""
    app = _app(pool=None, db=object())
    c = await _client(app)
    try:
        r = await c.post(path, json=BODY, headers=AUTH)
        assert r.status_code == 503
        assert "not enabled" in r.json()["detail"]
    finally:
        await c.aclose()


async def test_the_catalogue_routes_503_without_a_database():
    """PHASE 8 made the flag the OUTER gate, so this test has to turn MCP on.

    It used to pass with the feature disabled — reaching the database check only
    because no flag check stood in front of it. Now `mcp_connections_enabled`
    is answered first (a deployment with MCP off has nothing to serve, database
    or not), so asserting the DB refusal requires the feature to be on. The
    ordering is deliberate: "off here" is a product state, "no catalogue
    database" is a misconfiguration, and only the second is a 503.
    """
    app = _app(db=None, mcp_connections_enabled=True)
    c = await _client(app)
    try:
        assert (await c.get("/v1/mcp/curated", headers=AUTH)).status_code == 503
    finally:
        await c.aclose()


async def test_the_pool_route_reports_a_credential_free_summary():
    class FakePool:
        def snapshot(self):
            return {"sessions": 2, "by_server": ["fake"], "limits": {}}

    app = _app(pool=FakePool())
    c = await _client(app)
    try:
        r = await c.get("/v1/mcp/pool", headers=AUTH)
        assert r.status_code == 200
        assert r.json()["sessions"] == 2
        assert "token" not in r.text.lower()
    finally:
        await c.aclose()


# -------------------------------------------------------------- validation
async def test_a_body_that_disagrees_with_the_path_is_refused():
    """A mismatch means the caller built the request from two sources, and
    acting on either would be acting on something nobody asked for."""
    app = _app(pool=object(), db=object())
    c = await _client(app)
    try:
        r = await c.post(
            "/v1/mcp/connections/conn-OTHER/connect", json=BODY, headers=AUTH
        )
        assert r.status_code == 400
        assert "disagree" in r.json()["detail"]
    finally:
        await c.aclose()


async def test_an_unknown_field_is_rejected_rather_than_silently_dropped():
    """`extra="forbid"`, matching `GenerateRequest`: an unknown field means the
    two planes are at different versions, and that must fail at the boundary."""
    app = _app(pool=object(), db=object())
    c = await _client(app)
    try:
        r = await c.post(
            "/v1/mcp/connections/preflight",
            json={**BODY, "impersonate": "someone-else"},
            headers=AUTH,
        )
        assert r.status_code == 422
    finally:
        await c.aclose()


@pytest.mark.parametrize(
    "missing", ["connection_id", "server_name", "user_id", "workspace_id"]
)
async def test_the_tenant_identity_is_mandatory(missing):
    """There is no default user and no default workspace. A route that accepted
    a connection operation without both would be a route that acted on
    somebody's behalf without knowing who."""
    app = _app(pool=object(), db=object())
    body = {k: v for k, v in BODY.items() if k != missing}
    c = await _client(app)
    try:
        r = await c.post(
            "/v1/mcp/connections/preflight", json=body, headers=AUTH
        )
        assert r.status_code == 422
    finally:
        await c.aclose()


async def test_an_empty_identity_string_is_refused():
    app = _app(pool=object(), db=object())
    c = await _client(app)
    try:
        r = await c.post(
            "/v1/mcp/connections/preflight",
            json={**BODY, "user_id": ""},
            headers=AUTH,
        )
        assert r.status_code == 422
    finally:
        await c.aclose()


# ------------------------------------------------------------ the flag
async def test_the_lifespan_builds_no_pool_when_the_flag_is_off():
    """With the flag off the deployment is byte-identical to Phase 2: no task
    group, no sweeper, nothing that can open a connection."""
    from contextlib import AsyncExitStack

    app = create_app()
    settings = make_settings("http://x", mcp_connections_enabled=False)

    import app.main as main_mod

    async with AsyncExitStack() as stack:
        stack.enter_context(_patched(main_mod, "get_settings", lambda: settings))
        async with main_mod.lifespan(app):
            assert app.state.mcp_pool is None


class _patched:
    """Tiny context-managed monkeypatch, so this test needs no fixture."""

    def __init__(self, obj, name, value):
        self.obj, self.name, self.value = obj, name, value

    def __enter__(self):
        self.old = getattr(self.obj, self.name)
        setattr(self.obj, self.name, self.value)
        return self

    def __exit__(self, *exc):
        setattr(self.obj, self.name, self.old)
        return False


# ------------------------------------------------- the Phase 4 gating seam
def _patch_curated(monkeypatch, row):
    """Point `lifecycle.preflight`/`connect` at a fixed curated row.

    `resolve_target` is a KEYWORD DEFAULT captured at import time, so patching
    `curated.resolve` has no effect on these two — the router passes no
    `resolve_target` of its own. Patching the default is the seam that actually
    exists, and getting this wrong is why the first draft of these tests died on
    a real database call.
    """
    from app.mcp import lifecycle as lifecycle_mod

    async def resolve(_engine, _name):
        return row

    for fn in (lifecycle_mod.preflight, lifecycle_mod.connect):
        monkeypatch.setitem(fn.__kwdefaults__, "resolve_target", resolve)

def _oauth_only_row():
    """A curated server that speaks OAuth and nothing else.

    Built from the REAL `CuratedTarget` dataclass rather than a hand-rolled
    stub, so a field added to the row cannot leave this test asserting against a
    shape production no longer has — the first draft used a stub and died on a
    missing `version_mode`.
    """
    from app.mcp.registry.curated import CuratedTarget

    return CuratedTarget(
        server_name="test.fixture/fake",
        slug="acme",
        display_name="Acme",
        category="productivity",
        transport="streamable-http",
        endpoint_url="https://acme.test/mcp",
        auth_kind="oauth",
        trusted=True,
        enabled=True,
        version="1.0.0",
        version_mode="pinned",
        catalogue_status="active",
        version_status="active",
        remotes=[{"type": "streamable-http", "url": "https://acme.test/mcp"}],
        packages=None,
    )


async def test_an_oauth_server_is_connectable_once_oauth_is_enabled(monkeypatch):
    """THE gate Phase 4 turns from closed to open, asserted at the ROUTE.

    The catalogue can never tell us a server speaks OAuth — `registry/parse.py`
    refuses to infer it — so OAuth is discovered at RUNTIME from the 401. That
    only happens if `compat.assess` PERMITS the attempt, which it does only when
    `credentials_available` is true.

    THIS IS WHERE IT WENT WRONG, and why no other test caught it: the gate was
    computed from a per-request `EnvCredentialResolver` built inside the router,
    while the object that actually attaches the credential is the POOL's
    resolver, set to `VaultCredentialResolver` in the lifespan. Two different
    objects answering one question — measured: the route said
    `credentials_available=False` and every OAuth server was refused before a
    packet left, with the flow enabled and keyed.
    """
    _patch_curated(monkeypatch, _oauth_only_row())

    class VaultLikeResolver:
        """What the lifespan installs on the pool when OAuth is on."""

        can_supply = True
        can_authorize = True

        async def headers(self, **_kwargs):
            return {}

        async def resolve(self, **_kwargs):
            from app.mcp.credentials import ResolvedCredential

            return ResolvedCredential()

    class Pool:
        _resolver = VaultLikeResolver()

    app = _app(pool=Pool(), db=object())
    c = await _client(app)
    try:
        r = await c.post("/v1/mcp/connections/preflight", json=BODY, headers=AUTH)
        assert r.status_code == 200
        report = r.json()
        # NO error_kind is the whole assertion. A refusal here is SILENT: the
        # connection never dials, so the 401 that starts discovery never fires
        # and the user sees "needs authorization" forever.
        assert report["error_kind"] is None, report
        assert report["error_detail"] is None, report
        assert report["state"] == "configured"
        assert report["user_action_required"] is False
    finally:
        await c.aclose()


async def test_the_same_server_is_still_refused_with_oauth_off(monkeypatch):
    """The control. If this also passed, the test above would prove nothing —
    it would just mean the auth gate had been removed entirely."""
    _patch_curated(monkeypatch, _oauth_only_row())

    class Phase3Pool:
        """No `can_authorize`: exactly the Phase 3 static resolver."""

        class _R:
            can_supply = False

            def supplies(self, _slug):
                return False

        _resolver = _R()

    app = _app(pool=Phase3Pool(), db=object())
    c = await _client(app)
    try:
        r = await c.post("/v1/mcp/connections/preflight", json=BODY, headers=AUTH)
        report = r.json()
        assert report["error_kind"] == "auth_required", report
        assert "no credential is available" in report["error_detail"], report
        assert report["user_action_required"] is True
    finally:
        await c.aclose()


async def test_a_dev_token_still_opens_the_gate_without_oauth(monkeypatch):
    """Phase 3's path must keep working, and must stay PER-REQUEST.

    `_resolver` is rebuilt from settings on every call precisely so an operator
    rotating a development token does not need a restart. Reading the gate off
    the pool's boot-time resolver alone would quietly take that away.
    """
    _patch_curated(monkeypatch, _oauth_only_row())

    app = _app(
        pool=object(),
        db=object(),
        mcp_test_credentials='{"acme": "dev-token-for-tests"}',
    )
    c = await _client(app)
    try:
        r = await c.post("/v1/mcp/connections/preflight", json=BODY, headers=AUTH)
        assert r.json()["error_kind"] is None, r.json()
    finally:
        await c.aclose()


async def test_the_gate_survives_a_pool_that_has_no_resolver(monkeypatch):
    # Defensive: `mcp_connections_enabled=False` leaves no pool at all, and a
    # future pool might not expose its resolver. Neither may raise on a route
    # that is only answering "could this be connected?".
    _patch_curated(monkeypatch, _oauth_only_row())

    for pool in (None, object()):
        app = _app(pool=pool, db=object())
        c = await _client(app)
        try:
            r = await c.post("/v1/mcp/connections/preflight", json=BODY, headers=AUTH)
            assert r.status_code == 200, r.text
        finally:
            await c.aclose()


def test_only_one_module_decides_whether_a_credential_can_be_obtained():
    """A guard on the bug class, not the bug.

    `credentials_available` was answered in TWO places: `lifecycle._can_supply`,
    which knew about `can_authorize`, and an inline
    `resolver.supplies(...) or resolver.can_supply` in this router, which did
    not. The second one won at the route, so with the vault live and keyed every
    OAuth server was refused before dialling — silently, because a refusal looks
    exactly like "this server needs authorization".

    Nothing about that was visible in a diff. So the rule is enforced instead:
    outside `lifecycle.py`, no module may read `can_supply`/`can_authorize`/
    `supplies` off a resolver to decide this. Found in the AST, so a comment
    explaining the rule cannot trip it.
    """
    import ast
    import pathlib

    watched = {"can_supply", "can_authorize", "supplies"}
    offenders: list[str] = []
    roots = [
        *pathlib.Path("app/mcp").rglob("*.py"),
        *pathlib.Path("app/routers").glob("*.py"),
    ]
    # `lifecycle.py` owns the answer; `credentials.py` DEFINES the properties.
    # Everywhere else must ask, not re-derive.
    owners = {"lifecycle.py", "credentials.py"}
    for path in roots:
        if path.name in owners:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr in watched:
                offenders.append(f"{path}:{node.lineno} reads .{node.attr}")
    assert not offenders, (
        "these read a resolver's capability directly instead of calling "
        f"lifecycle.can_supply_credentials(): {offenders}"
    )


def test_the_public_name_is_the_one_lifecycle_actually_uses():
    # The alias exists so a reintroduced private copy is obvious. If they ever
    # stop being the same object, there are two implementations again.
    from app.mcp import lifecycle as lifecycle_mod

    assert lifecycle_mod._can_supply is lifecycle_mod.can_supply_credentials
