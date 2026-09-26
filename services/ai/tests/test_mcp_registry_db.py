"""Catalogue persistence + search — DB-backed.

Gated exactly like `tests/test_knowledge_db.py`: self-skips unless
TEST_DATABASE_URL points at a Postgres with `alembic upgrade head` applied, so
`uv run pytest` stays hermetic and offline. CI runs the migration first.

The ALGORITHM (watermark, resume, tombstones, idempotency) is proven without a
database in `test_mcp_registry_sync.py` — deliberately, because those are the
rules that are easiest to get subtly wrong and they should not be testable only
where a server happens to be running. What is tested HERE is the SQL those rules
run on: upsert convergence, the COALESCE that protects `latest_version`, and
that search never needs the registry.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.mcp.registry import store
from app.mcp.registry.parse import ServerRecord, VersionRecord

pytestmark = pytest.mark.db

NOW = datetime(2026, 6, 1, tzinfo=UTC)


@pytest.fixture
async def engine():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL not set")
    eng = create_async_engine(url.replace("postgresql://", "postgresql+psycopg://"))
    async with eng.begin() as conn:
        await conn.execute(text("TRUNCATE mcp_server_versions, mcp_servers CASCADE"))
        await conn.execute(text("DELETE FROM mcp_sync_state"))
    yield eng
    await eng.dispose()


def _srv(name: str, *, latest: str | None = "1.0.0", status="active", desc="a server"):
    return ServerRecord(
        name=name,
        title=name,
        description=desc,
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


def _ver(
    name: str,
    version: str,
    *,
    latest=True,
    status="active",
    transports=None,
    auth="unknown",
):
    return VersionRecord(
        server_name=name,
        version=version,
        is_latest=latest,
        status=status,
        published_at=NOW,
        upstream_updated_at=NOW,
        schema_version="https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        remotes=[{"type": "streamable-http", "url": "https://x.test/mcp"}],
        packages=[],
        transports=transports or ["streamable-http"],
        auth_kind=auth,
        raw={"name": name, "version": version},
    )


async def test_insert_then_replay_converges(engine):
    """Idempotency is what makes a failed sync safe to simply re-run."""
    first = await store.upsert_page(engine, [_srv("a/x")], [_ver("a/x", "1.0.0")])
    assert first.inserted == 1

    second = await store.upsert_page(engine, [_srv("a/x")], [_ver("a/x", "1.0.0")])
    assert second.inserted == 0 and second.updated == 1

    stats = await store.catalogue_stats(engine)
    assert stats.servers == 1 and stats.versions == 1, "a replay created duplicates"


async def test_a_non_latest_row_cannot_blank_latest_version(engine):
    """A single registry page carries EVERY version of a server, and only the
    `isLatest` one supplies latest_version. Without the COALESCE, whichever row
    landed last would decide the field."""
    await store.upsert_page(
        engine, [_srv("a/x", latest="2.0.0")], [_ver("a/x", "2.0.0")]
    )
    # Now a NON-latest row for the same server, carrying latest_version=None.
    await store.upsert_page(
        engine, [_srv("a/x", latest=None)], [_ver("a/x", "1.0.0", latest=False)]
    )
    row = await store.get_server(engine, "a/x")
    assert row["latest_version"] == "2.0.0"


async def test_a_new_latest_version_demotes_the_previous_one(engine):
    await store.upsert_page(
        engine, [_srv("a/x", latest="1.0.0")], [_ver("a/x", "1.0.0")]
    )
    await store.upsert_page(
        engine, [_srv("a/x", latest="2.0.0")], [_ver("a/x", "2.0.0")]
    )
    versions = await store.list_versions(engine, "a/x")
    latest = [v for v in versions if v["is_latest"]]
    assert len(latest) == 1 and latest[0]["version"] == "2.0.0"


async def test_two_servers_sharing_a_version_do_not_collide(engine):
    await store.upsert_page(
        engine,
        [_srv("pub.a/srv"), _srv("pub.b/srv")],
        [_ver("pub.a/srv", "1.0.0"), _ver("pub.b/srv", "1.0.0")],
    )
    stats = await store.catalogue_stats(engine)
    assert stats.servers == 2 and stats.versions == 2


async def test_a_tombstone_is_kept_not_deleted(engine):
    """Phase 3 may hold a connection pinned to a version the registry removed."""
    await store.upsert_page(engine, [_srv("gone/x")], [_ver("gone/x", "1.0.0")])
    counts = await store.upsert_page(
        engine,
        [_srv("gone/x", status="deleted")],
        [_ver("gone/x", "1.0.0", status="deleted")],
    )
    assert counts.deleted == 1
    assert await store.get_server(engine, "gone/x") is not None
    assert await store.list_versions(engine, "gone/x")


async def test_search_finds_by_description_not_just_name(engine):
    """The registry's own search is name-substring only; the local catalogue can
    do better, which is a reason to have a catalogue at all."""
    await store.upsert_page(
        engine,
        [_srv("acme/tool", desc="Connect to your Notion workspace and pages")],
        [_ver("acme/tool", "1.0.0")],
    )
    hits = await store.search_servers(engine, query="notion workspace")
    assert [h["name"] for h in hits] == ["acme/tool"]


async def test_search_supports_prefix_without_a_trigram_index(engine):
    await store.upsert_page(
        engine, [_srv("acme/notion")], [_ver("acme/notion", "1.0.0")]
    )
    assert [h["name"] for h in await store.search_servers(engine, query="noti")] == [
        "acme/notion"
    ]


async def test_search_finds_words_inside_a_registry_name(engine):
    """The english parser reads "io.github.x/notion-mcp" as ONE path token, so a
    word or prefix query never reaches "notion" inside it. Measured on the
    production catalogue: every name tokenises that way."""
    await store.upsert_page(
        engine,
        [_srv("io.github.acme/notion-mcp", desc="a server")],
        [_ver("io.github.acme/notion-mcp", "1.0.0")],
    )
    for q in ("notion", "Notion-MCP", "acme/noti"):
        hits = await store.search_servers(engine, query=q)
        assert [h["name"] for h in hits] == ["io.github.acme/notion-mcp"], q


async def test_search_takes_wildcards_in_the_query_literally(engine):
    await store.upsert_page(
        engine, [_srv("acme/notion")], [_ver("acme/notion", "1.0.0")]
    )
    for q in ("%", "%%", "_", "   "):
        assert await store.search_servers(engine, query=q) == [], q


async def test_search_filters_on_transport_and_auth(engine):
    await store.upsert_page(
        engine,
        [_srv("a/remote"), _srv("b/local")],
        [
            _ver("a/remote", "1.0.0", transports=["streamable-http"], auth="bearer"),
            _ver("b/local", "1.0.0", transports=["stdio"], auth="none"),
        ],
    )
    assert [
        h["name"] for h in await store.search_servers(engine, transport="stdio")
    ] == ["b/local"]
    assert [
        h["name"] for h in await store.search_servers(engine, auth_kind="bearer")
    ] == ["a/remote"]


async def test_deleted_servers_are_excluded_from_the_default_search(engine):
    await store.upsert_page(
        engine,
        [_srv("gone/x", status="deleted")],
        [_ver("gone/x", "1.0.0", status="deleted")],
    )
    assert await store.search_servers(engine) == []
    assert await store.search_servers(engine, status="deleted")


async def test_search_never_contacts_the_registry(engine):
    """§25: a registry outage makes the catalogue stale, never unavailable.

    There is no network client in this path at all — the assertion is structural
    rather than mocked: `store` imports no HTTP library.
    """
    import app.mcp.registry.store as st

    assert "httpx" not in dir(st)
    await store.upsert_page(engine, [_srv("a/x")], [_ver("a/x", "1.0.0")])
    assert await store.search_servers(engine, query="server")


async def test_keyset_pagination_does_not_repeat_rows(engine):
    servers, versions = [], []
    for i in range(5):
        name = f"p{i}/srv"
        s = _srv(name)
        servers.append(
            ServerRecord(
                **{**s.__dict__, "upstream_updated_at": NOW - timedelta(days=i)}
            )
        )
        versions.append(_ver(name, "1.0.0"))
    await store.upsert_page(engine, servers, versions)

    page1 = await store.search_servers(engine, limit=2)
    cur = (page1[-1]["upstream_updated_at"], page1[-1]["name"])
    page2 = await store.search_servers(engine, limit=2, cursor=cur)
    assert {r["name"] for r in page1}.isdisjoint({r["name"] for r in page2})


async def test_catalogue_stats_reports_freshness(engine):
    port = store.PostgresSyncPort(engine)
    await port.mark_attempt()
    stats = await store.catalogue_stats(engine)
    assert stats.last_attempt_at is not None
    assert stats.last_success_at is None, "an attempt is not a success"
