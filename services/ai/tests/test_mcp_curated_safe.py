"""The catalogue projection a BROWSER receives. No database required.

WHY NOT IN test_mcp_curated_db.py. That file self-skips unless
`TEST_DATABASE_URL` is set, and on this machine it has never run — so putting a
security property there would mean shipping it untested. The SQL belongs there;
the question "what leaves the process" belongs somewhere that always executes.

WHAT THIS PROTECTS. `/v1/mcp/curated` is the only catalogue read a browser can
reach (through a Convex action), and the row it reads from carries
`endpoint_url` — the internal location this deployment dials — plus operator
`notes` and the `trusted` flag. None of the three is a secret, and none of the
three is a UI's business. Dropping them in PYTHON rather than in Convex is the
point: a value that never crosses the process boundary cannot be leaked by a
later change on the other side of it.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from httpx import ASGITransport

from app.main import create_app
from app.mcp.registry import curated
from tests.conftest import make_settings

pytestmark = pytest.mark.anyio

SERVICE_KEY = "test-service-key-aaaaaaaaaaaaaaaaaaaa"
AUTH = {"x-service-key": SERVICE_KEY}

#: Distinctive on purpose: every assertion below searches the WHOLE response
#: body for these, so a leak through a field nobody thought of still fails.
SECRET_ENDPOINT = "https://internal-endpoint.invalid/mcp"
OPERATOR_NOTE = "flaky above 50rps, renew cert in March"

ROW = {
    "server_name": "test.fixture/fake",
    "slug": "fake",
    "display_name": "Fake Server",
    "category": "productivity",
    "transport": "streamable-http",
    "endpoint_url": SECRET_ENDPOINT,
    "auth_kind": "oauth",
    "trusted": True,
    "enabled": True,
    "pinned_version": None,
    "notes": OPERATOR_NOTE,
    "catalogue_status": "active",
    "latest_version": "1.2.3",
    "title": "Fake",
    "description": "A fixture server.",
}


# ------------------------------------------------------------ a fake engine
class _Result:
    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows

    def mappings(self) -> _Result:
        return self

    def all(self) -> list[dict]:
        return self._rows


class _Conn:
    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows

    async def execute(self, *_a: Any, **_k: Any) -> _Result:
        return _Result(self._rows)


class _Begin:
    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows

    async def __aenter__(self) -> _Conn:
        return _Conn(self._rows)

    async def __aexit__(self, *_exc: Any) -> bool:
        return False


class FakeEngine:
    """Just enough SQLAlchemy for `list_curated`.

    Hand-rolled rather than sqlite, because the query is Postgres-shaped and the
    thing under test is the PROJECTION, not the SQL. The SQL is covered by the
    DB-gated file.
    """

    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows

    def begin(self) -> _Begin:
        return _Begin(self._rows)


def _app(rows: list[dict], **overrides):
    base = {"mcp_connections_enabled": True}
    base.update(overrides)
    app = create_app()
    app.state.settings = make_settings("http://x", **base)
    app.state.db = FakeEngine(rows)
    app.state.mcp_pool = None
    app.state.tool_registry = None
    return app


# ------------------------------------------------------------------- unit
async def test_the_safe_projection_drops_the_endpoint_the_note_and_the_trust():
    rows = await curated.list_curated(FakeEngine([dict(ROW)]), safe=True)
    assert len(rows) == 1
    row = rows[0]
    assert "endpoint_url" not in row
    assert "notes" not in row
    # `trusted` is the operator's decision about believing a server's own
    # annotations. Surfaced, a user would read it as a safety rating.
    assert "trusted" not in row
    # And what a card actually needs IS there.
    assert row["display_name"] == "Fake Server"
    assert row["category"] == "productivity"
    assert row["description"] == "A fixture server."


async def test_internal_callers_still_get_the_endpoint():
    """`safe` defaults to False so nothing that legitimately needs the endpoint
    changed behaviour when the projection was added."""
    rows = await curated.list_curated(FakeEngine([dict(ROW)]))
    assert rows[0]["endpoint_url"] == SECRET_ENDPOINT
    assert rows[0]["notes"] == OPERATOR_NOTE


async def test_the_projection_is_an_ALLOWLIST_not_a_denylist():
    """A column added to `_SELECT` later must be named before it can be seen.

    Asserted mechanically: a row carrying a field nobody has approved comes back
    without it, which is the failure direction that cannot leak. A denylist would
    ship the new column and stop only once somebody noticed.
    """
    hostile = {**ROW, "some_future_column": "leaked", "api_key": "sk-live-xyz"}
    row = (await curated.list_curated(FakeEngine([hostile]), safe=True))[0]
    assert "some_future_column" not in row
    assert "api_key" not in row
    assert set(row) == set(curated._SAFE_FIELDS)


# ------------------------------------------------------------------ route
async def test_the_route_body_contains_no_endpoint_and_no_note():
    """The whole response searched as TEXT, not field by field.

    A field-by-field assertion only covers the fields the author thought of.
    Searching the serialized body catches a leak through a nested structure or a
    field added later.
    """
    app = _app([dict(ROW)])
    c = httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    try:
        res = await c.get("/v1/mcp/curated", headers=AUTH)
    finally:
        await c.aclose()

    assert res.status_code == 200, res.text
    body = res.text
    assert SECRET_ENDPOINT not in body
    assert OPERATOR_NOTE not in body
    assert "internal-endpoint" not in body
    payload = res.json()
    assert payload["count"] == 1
    assert payload["servers"][0]["slug"] == "fake"


async def test_the_route_still_requires_the_service_key():
    """Unchanged by the projection work, and re-asserted because this route now
    carries product data a browser reads."""
    app = _app([dict(ROW)])
    c = httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    try:
        assert (await c.get("/v1/mcp/curated")).status_code == 401
    finally:
        await c.aclose()


# ================================================== the global kill switch
async def test_the_catalogue_is_INERT_when_mcp_is_disabled():
    """§87. A kill switch that leaves the storefront open is not a kill switch.

    `mcp_connections_enabled=False` was already structural for EXECUTION — no
    pool, no vault, no flow, and every connection route answers 503. But this
    route ignored the flag, so a deployment with MCP turned off still handed the
    browser a full catalogue of servers whose Connect button could only 503.

    It is also what makes a DARK LAUNCH actually dark: the curated rows can be
    seeded and verified on production while the page still says the feature is
    unavailable.
    """
    app = _app([dict(ROW)], mcp_connections_enabled=False)
    c = httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    try:
        res = await c.get("/v1/mcp/curated", headers=AUTH)
    finally:
        await c.aclose()

    assert res.status_code == 200, res.text
    body = res.json()
    # A STATE, not an error: "off here" and "could not ask" need different words
    # in the UI and only one of them has a retry.
    assert body["enabled"] is False
    assert body["servers"] == []
    assert body["count"] == 0
    # And the row's own identity did not leak through the disabled path either.
    assert "fake" not in res.text


async def test_the_catalogue_reports_enabled_when_mcp_is_on():
    """The control. Without this the test above would pass on a route that
    always returned nothing."""
    app = _app([dict(ROW)])
    c = httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    try:
        res = await c.get("/v1/mcp/curated", headers=AUTH)
    finally:
        await c.aclose()
    body = res.json()
    assert body["enabled"] is True
    assert [s["slug"] for s in body["servers"]] == ["fake"]


# ------------------------------------------------------------ everyday order
async def test_the_catalogue_lists_everyday_connectors_first():
    """The page renders in the order the API returns. Sorted by category then
    slug, Apify and Bitly sat above Gmail; a user opening Connectors should see
    mail, calendar, files, chat and code before an analytics SDK."""
    rows = [
        {
            **ROW,
            "slug": s,
            "server_name": f"x/{s}",
            "display_name": s.title(),
            "category": c,
        }
        for s, c in (
            ("apify", "browser"),
            ("bitly", "business"),
            ("gmail", "email"),
            ("zapier", "productivity"),
            ("slack", "communication"),
            ("github", "developer"),
            ("wix", "business"),
        )
    ]
    out = await curated.list_curated(FakeEngine(rows), safe=True)
    slugs = [r["slug"] for r in out]
    assert slugs[:3] == ["gmail", "slack", "github"]
    assert slugs.index("zapier") < slugs.index("apify")
    # Unranked servers keep a stable alphabetical tail.
    assert slugs[-3:] == ["apify", "bitly", "wix"]
