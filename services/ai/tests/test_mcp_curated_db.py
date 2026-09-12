"""The curated set — DB-backed.

Gated exactly like `test_mcp_registry_db.py`: self-skips unless
TEST_DATABASE_URL points at a Postgres with `alembic upgrade head` applied, so
`uv run pytest` stays hermetic and offline. CI runs the migration first.

WHAT IS TESTED HERE vs ELSEWHERE. The connection STATE MACHINE is proven without
a database in `test_mcp_lifecycle.py` (the catalogue lookup is injected), because
the rules that are easiest to get subtly wrong should not be testable only where
a server happens to be running. What is tested HERE is the SQL those rules run
on: the join across curation + catalogue + version, the two CHECK constraints
that make stdio and plaintext unrepresentable, and the fact that a sync cannot
overwrite an operator's decision.

HONEST STATUS: these have never been executed on the development machine, which
has no Docker and no Postgres. They are written to be run, not to be assumed.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.mcp.models import McpConfigError
from app.mcp.registry import curated, store
from app.mcp.registry.parse import ServerRecord, VersionRecord

pytestmark = pytest.mark.db

NOW = datetime(2026, 6, 1, tzinfo=UTC)
REMOTE = [{"type": "streamable-http", "url": "https://api.example.test/mcp"}]


@pytest.fixture
async def engine():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL not set")
    eng = create_async_engine(url.replace("postgresql://", "postgresql+psycopg://"))
    async with eng.begin() as conn:
        await conn.execute(
            text(
                "TRUNCATE mcp_curated_servers, mcp_server_versions, "
                "mcp_servers CASCADE"
            )
        )
    yield eng
    await eng.dispose()


def _srv(name: str, *, latest: str | None = "1.0.0", status: str = "active"):
    return ServerRecord(
        name=name,
        title=name,
        description="a server",
        status=status,
        status_changed_at=NOW,
        status_message=None,
        latest_version=latest,
        publisher=name.split("/")[0],
        repository_url="https://example.test/repo",
        repository_source="github",
        repository_subfolder=None,
        upstream_updated_at=NOW,
    )


def _ver(name: str, version: str, *, remotes=None, status: str = "active"):
    return VersionRecord(
        server_name=name,
        version=version,
        is_latest=version == "1.0.0",
        status=status,
        published_at=NOW,
        upstream_updated_at=NOW,
        schema_version="https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        remotes=REMOTE if remotes is None else remotes,
        packages=[],
        transports=["streamable-http"],
        auth_kind="none",
        raw={"name": name, "version": version},
    )


async def _catalogue(engine, name="acme/server", versions=("1.0.0",), **srv_kw):
    await store.upsert_page(
        engine,
        [_srv(name, **srv_kw)],
        [_ver(name, v) for v in versions],
    )
    return name


async def _curate(engine, name, **overrides):
    kwargs = {
        "server_name": name,
        "slug": "acme",
        "display_name": "Acme",
        "category": "productivity",
        "transport": "streamable-http",
        "endpoint_url": "https://api.example.test/mcp",
        "auth_kind": "none",
        "enabled": True,
    }
    kwargs.update(overrides)
    await curated.upsert_curated(engine, **kwargs)


# ------------------------------------------------------------------- basics
async def test_an_uncurated_catalogue_server_resolves_to_nothing(engine):
    name = await _catalogue(engine)
    assert await curated.resolve(engine, name) is None


async def test_curating_joins_catalogue_and_version_metadata(engine):
    name = await _catalogue(engine)
    await _curate(engine, name)
    target = await curated.resolve(engine, name)
    assert target is not None
    assert target.slug == "acme"
    assert target.catalogue_status == "active"
    assert target.version == "1.0.0"
    assert target.version_mode == "latest_at_connect"
    assert target.remotes == REMOTE


async def test_a_pin_wins_over_the_catalogues_latest(engine):
    """A catalogue sync moving `latest_version` must never silently re-point a
    pinned connection at a different server build."""
    name = await _catalogue(engine, versions=("1.0.0", "2.0.0"))
    await _curate(engine, name, pinned_version="2.0.0")
    target = await curated.resolve(engine, name)
    assert target.version == "2.0.0"
    assert target.version_mode == "pinned"


async def test_upserting_a_curation_is_idempotent(engine):
    name = await _catalogue(engine)
    await _curate(engine, name, notes="first")
    await _curate(engine, name, notes="second")
    rows = await curated.list_curated(engine, enabled_only=False)
    assert len(rows) == 1
    assert rows[0]["notes"] == "second"


# ------------------------------------------------------------ default-closed
async def test_curation_defaults_to_disabled_and_untrusted(engine):
    """Both flags default FALSE, and they are two decisions: `enabled` makes a
    server connectable, `trusted` makes its self-reported readOnlyHint
    believable. Collapsing them would silently disarm the approval gate for a
    newly added server's tools."""
    name = await _catalogue(engine)
    await curated.upsert_curated(
        engine,
        server_name=name,
        slug="acme",
        display_name="Acme",
        category="productivity",
        transport="streamable-http",
        endpoint_url="https://api.example.test/mcp",
    )
    target = await curated.resolve(engine, name)
    assert target.enabled is False
    assert target.trusted is False


async def test_a_disabled_server_is_resolvable_but_excluded_from_the_picker(engine):
    """Three states must stay distinguishable: not curated, curated but off,
    curated and on. Collapsing the middle into None reads as "unknown server"."""
    name = await _catalogue(engine)
    await _curate(engine, name, enabled=False)
    assert await curated.resolve(engine, name) is not None
    assert await curated.list_curated(engine, enabled_only=True) == []
    assert len(await curated.list_curated(engine, enabled_only=False)) == 1


# ------------------------------------------------------------- constraints
async def test_stdio_is_unrepresentable_in_the_curated_table(engine):
    """A CHECK rather than a comment: local execution must be impossible to
    configure, not merely discouraged."""
    name = await _catalogue(engine)
    with pytest.raises(Exception, match="(?i)check|constraint"):
        await _curate(engine, name, transport="stdio")


async def test_a_plaintext_endpoint_is_unrepresentable(engine):
    """The Authorization header rides this request."""
    name = await _catalogue(engine)
    with pytest.raises(Exception, match="(?i)check|constraint"):
        await _curate(engine, name, endpoint_url="http://api.example.test/mcp")


async def test_two_servers_cannot_share_a_slug(engine):
    """`ToolRegistry._by_id` is a flat map keyed on "mcp:<slug>:<tool>", so a
    duplicate slug would let one server's tools silently overwrite another's."""
    a = await _catalogue(engine, name="acme/one")
    b = await _catalogue(engine, name="acme/two")
    await _curate(engine, a, slug="shared")
    with pytest.raises(Exception, match="(?i)unique|duplicate"):
        await _curate(engine, b, slug="shared")


async def test_an_illegal_slug_is_refused_before_it_reaches_the_database(engine):
    """One definition of a legal slug -- the identity's -- rather than a second
    regex here that could drift from it."""
    name = await _catalogue(engine)
    for bad in ("With Spaces", "UPPER", "a" * 40, "-leading", ""):
        with pytest.raises(McpConfigError):
            await _curate(engine, name, slug=bad)


async def test_curating_a_server_that_is_not_in_the_catalogue_is_refused(engine):
    """The FK. Curation is a decision ABOUT a catalogued server; without the
    catalogue row there is no version, no remotes and no upstream status."""
    with pytest.raises(Exception, match="(?i)foreign key|violates"):
        await _curate(engine, "never/synced")


# --------------------------------------------- curation survives the sync
async def test_a_catalogue_sync_cannot_overwrite_a_curation_decision(engine):
    """The whole reason this is a separate table: `mcp_servers` is rewritten by
    every sync run, and an operator's decision must not live where a sync
    overwrites it."""
    name = await _catalogue(engine)
    await _curate(engine, name, trusted=True, pinned_version="1.0.0", notes="vetted")

    # A later sync re-upserts the catalogue row with new upstream metadata.
    await store.upsert_page(
        engine, [_srv(name, latest="9.9.9")], [_ver(name, "9.9.9")]
    )

    target = await curated.resolve(engine, name)
    assert target.trusted is True
    assert target.version == "1.0.0", "the pin survived the sync"
    assert target.enabled is True


async def test_an_upstream_deletion_does_not_delete_the_curation(engine):
    """Phase 2 tombstones rather than deleting, and a user may hold a working
    connection to a server the registry withdrew. Destroying the curation row on
    a third party's say-so would sever it silently."""
    name = await _catalogue(engine)
    await _curate(engine, name)
    await store.upsert_page(
        engine,
        [_srv(name, status="deleted")],
        [_ver(name, "1.0.0", status="deleted")],
    )
    target = await curated.resolve(engine, name)
    assert target is not None
    assert target.catalogue_status == "deleted"
    assert target.version_status == "deleted"
    assert target.enabled is True, "curation is ours, not upstream's"


async def test_a_pinned_version_still_resolves_after_upstream_removes_it(engine):
    name = await _catalogue(engine, versions=("1.0.0", "2.0.0"))
    await _curate(engine, name, pinned_version="2.0.0")
    await store.upsert_page(
        engine, [_srv(name)], [_ver(name, "2.0.0", status="deleted")]
    )
    target = await curated.resolve(engine, name)
    assert target.version == "2.0.0"
    assert target.version_status == "deleted"
    assert target.remotes == REMOTE, "the metadata needed to explain it survives"


# --------------------------------------------------------------- the picker
async def test_the_picker_lists_only_enabled_rows_ordered_stably(engine):
    for i, (name, category, enabled) in enumerate(
        [
            ("acme/mail", "email", True),
            ("acme/cal", "calendar", True),
            ("acme/off", "email", False),
        ]
    ):
        await _catalogue(engine, name=name)
        await _curate(
            engine, name, slug=f"s{i}", category=category, enabled=enabled
        )
    rows = await curated.list_curated(engine)
    assert [r["category"] for r in rows] == ["calendar", "email"]
    assert all(r["enabled"] for r in rows)


async def test_the_picker_never_returns_a_credential_column(engine):
    """There is no credential column, and there never will be: Phase 4 owns
    credentials, in a vault, keyed per user -- not in a deployment-wide operator
    table."""
    name = await _catalogue(engine)
    await _curate(engine, name)
    rows = await curated.list_curated(engine)
    forbidden = {"token", "secret", "api_key", "password", "credential"}
    for row in rows:
        assert not forbidden & {k.lower() for k in row}
