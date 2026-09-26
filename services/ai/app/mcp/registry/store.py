"""Catalogue persistence + search. Every value is bound; nothing is interpolated.

Mirrors `app/db/store.py`: SQLAlchemy `text()` with named parameters, so a
registry-supplied description — which is a string a stranger published — can
never reach the SQL grammar.

IDEMPOTENCY IS THE LOAD-BEARING PROPERTY of this whole phase. Every write is an
upsert keyed on the registry's own identity, so replaying a page, a whole run, or
an overlapping window converges on the same rows. That, not the cursor, is what
makes a failed sync safe to simply run again.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.mcp.registry.parse import ServerRecord, VersionRecord

__all__ = [
    "CatalogueStats",
    "PostgresSyncPort",
    "UpsertCounts",
    "search_servers",
    "upsert_page",
]


@dataclass
class UpsertCounts:
    inserted: int = 0
    updated: int = 0
    deleted: int = 0

    def add(self, other: UpsertCounts) -> None:
        self.inserted += other.inserted
        self.updated += other.updated
        self.deleted += other.deleted


@dataclass
class CatalogueStats:
    servers: int
    versions: int
    deleted_servers: int
    last_success_at: datetime | None
    last_attempt_at: datetime | None
    last_error: str | None
    watermark: datetime | None


# `latest_version` uses COALESCE(EXCLUDED, existing) rather than a plain
# overwrite, and that is not a stylistic choice — it is required by the data.
# A single page carries EVERY version of a server (observed: three rows for
# ac.inference.sh/mcp), and only the `isLatest` one supplies a latest_version.
# A plain overwrite would let whichever row happened to land last blank the
# field. Same reasoning for the timestamp: never move it backwards.
_UPSERT_SERVER = text("""
    INSERT INTO mcp_servers (
        name, title, description, status, status_changed_at, status_message,
        latest_version, publisher, repository_url, repository_source,
        repository_subfolder, upstream_updated_at, last_synced_at
    ) VALUES (
        :name, :title, :description, :status, :status_changed_at, :status_message,
        :latest_version, :publisher, :repository_url, :repository_source,
        :repository_subfolder, :upstream_updated_at, now()
    )
    ON CONFLICT (name) DO UPDATE SET
        title             = EXCLUDED.title,
        description       = EXCLUDED.description,
        status            = EXCLUDED.status,
        status_changed_at = EXCLUDED.status_changed_at,
        status_message    = EXCLUDED.status_message,
        latest_version    = COALESCE(EXCLUDED.latest_version,
                                     mcp_servers.latest_version),
        publisher         = EXCLUDED.publisher,
        repository_url    = EXCLUDED.repository_url,
        repository_source = EXCLUDED.repository_source,
        repository_subfolder = EXCLUDED.repository_subfolder,
        upstream_updated_at = GREATEST(
            COALESCE(EXCLUDED.upstream_updated_at, mcp_servers.upstream_updated_at),
            COALESCE(mcp_servers.upstream_updated_at, EXCLUDED.upstream_updated_at)
        ),
        last_synced_at    = now()
    RETURNING (xmax = 0) AS inserted
""")

_UPSERT_VERSION = text("""
    INSERT INTO mcp_server_versions (
        server_name, version, is_latest, status, published_at,
        upstream_updated_at, schema_version, remotes, packages, transports,
        auth_kind, raw, last_synced_at
    ) VALUES (
        :server_name, :version, :is_latest, :status, :published_at,
        :upstream_updated_at, :schema_version,
        CAST(:remotes AS jsonb), CAST(:packages AS jsonb), :transports,
        :auth_kind, CAST(:raw AS jsonb), now()
    )
    ON CONFLICT (server_name, version) DO UPDATE SET
        is_latest       = EXCLUDED.is_latest,
        status          = EXCLUDED.status,
        published_at    = EXCLUDED.published_at,
        upstream_updated_at = EXCLUDED.upstream_updated_at,
        schema_version  = EXCLUDED.schema_version,
        remotes         = EXCLUDED.remotes,
        packages        = EXCLUDED.packages,
        transports      = EXCLUDED.transports,
        auth_kind       = EXCLUDED.auth_kind,
        raw             = EXCLUDED.raw,
        last_synced_at  = now()
    RETURNING (xmax = 0) AS inserted
""")

# A server whose latest version is no longer latest must not keep claiming it.
# Runs AFTER the version upserts so the new latest is already visible.
_CLEAR_STALE_LATEST = text("""
    UPDATE mcp_server_versions SET is_latest = false
    WHERE server_name = :server_name AND version <> :version AND is_latest
""")


async def upsert_page(
    engine: AsyncEngine,
    servers: list[ServerRecord],
    versions: list[VersionRecord],
) -> UpsertCounts:
    """Persist one parsed page in ONE transaction.

    Page-scoped rather than run-scoped: a whole-registry transaction would be the
    all-or-nothing shape §7 forbids, and a per-row transaction would pay commit
    latency 2,600 times. A page is the natural unit — it is also the unit the
    cursor checkpoints on.

    `deleted` is COUNTED here but the row is KEPT. The registry sends tombstones
    on every incremental page, and Phase 3 may hold a connection pinned to a
    version the registry has since removed; hard-deleting would erase the only
    record of what that connection was pointed at.
    """
    counts = UpsertCounts()
    async with engine.begin() as conn:
        for srv in servers:
            row = (
                await conn.execute(
                    _UPSERT_SERVER,
                    {
                        "name": srv.name,
                        "title": srv.title,
                        "description": srv.description,
                        "status": srv.status,
                        "status_changed_at": srv.status_changed_at,
                        "status_message": srv.status_message,
                        "latest_version": srv.latest_version,
                        "publisher": srv.publisher,
                        "repository_url": srv.repository_url,
                        "repository_source": srv.repository_source,
                        "repository_subfolder": srv.repository_subfolder,
                        "upstream_updated_at": srv.upstream_updated_at,
                    },
                )
            ).first()
            if row is not None and row[0]:
                counts.inserted += 1
            else:
                counts.updated += 1
            if srv.status == "deleted":
                counts.deleted += 1

        for ver in versions:
            await conn.execute(
                _UPSERT_VERSION,
                {
                    "server_name": ver.server_name,
                    "version": ver.version,
                    "is_latest": ver.is_latest,
                    "status": ver.status,
                    "published_at": ver.published_at,
                    "upstream_updated_at": ver.upstream_updated_at,
                    "schema_version": ver.schema_version,
                    "remotes": json.dumps(ver.remotes),
                    "packages": json.dumps(ver.packages),
                    "transports": ver.transports,
                    "auth_kind": ver.auth_kind,
                    "raw": json.dumps(ver.raw),
                },
            )
        for ver in versions:
            if ver.is_latest:
                await conn.execute(
                    _CLEAR_STALE_LATEST,
                    {"server_name": ver.server_name, "version": ver.version},
                )
    return counts


async def search_servers(
    engine: AsyncEngine,
    *,
    query: str | None = None,
    transport: str | None = None,
    auth_kind: str | None = None,
    status: str | None = "active",
    publisher: str | None = None,
    limit: int = 25,
    cursor: tuple[datetime | None, str] | None = None,
) -> list[dict]:
    """Search the LOCAL catalogue. Never contacts the registry.

    That independence is the point (§25): an upstream outage makes the catalogue
    stale, never unavailable, and `catalogue_stats` exposes the staleness so it
    is visible rather than silent.

    Ranked by full-text relevance when a query is given, else newest-first.
    Keyset pagination on (upstream_updated_at, name) — an OFFSET would skip or
    repeat rows when a sync commits mid-scroll.
    """
    where = ["1=1"]
    params: dict[str, Any] = {"limit": max(1, min(limit, 200))}

    if status:
        where.append("s.status = :status")
        params["status"] = status
    if publisher:
        where.append("s.publisher = :publisher")
        params["publisher"] = publisher
    if query:
        # `websearch_to_tsquery` takes human input safely — quotes, OR, - all
        # handled — where `to_tsquery` would raise on a stray character. The
        # prefix term lets "noti" find "notion" in title/description. The NAME
        # needs its own substring match: the english parser reads a registry
        # name ("io.github.x/notion-mcp") as ONE path token, so no word or
        # prefix query ever reaches the words inside it. A seq scan of the
        # catalogue (31.5k rows on production: ~45 ms) — no trigram index.
        where.append(
            "(s.search_doc @@ websearch_to_tsquery('english', :q)"
            " OR s.search_doc @@ to_tsquery('english', :qprefix)"
            " OR s.name ILIKE :qname ESCAPE '\\')"
        )
        params["q"] = query
        params["qprefix"] = _prefix_query(query)
        params["qname"] = _substring_pattern(query)
    if transport or auth_kind:
        sub = ["v.server_name = s.name"]
        if transport:
            sub.append(":transport = ANY(v.transports)")
            params["transport"] = transport
        if auth_kind:
            sub.append("v.auth_kind = :auth_kind")
            params["auth_kind"] = auth_kind
        where.append(
            "EXISTS (SELECT 1 FROM mcp_server_versions v WHERE "
            + " AND ".join(sub)
            + " AND v.is_latest)"
        )
    if cursor is not None:
        params["cur_ts"], params["cur_name"] = cursor
        where.append("(s.upstream_updated_at, s.name) < (:cur_ts, :cur_name)")

    order = (
        "ts_rank(s.search_doc, websearch_to_tsquery('english', :q)) DESC, "
        if query
        else ""
    )
    sql = text(f"""
        SELECT s.name, s.title, s.description, s.status, s.latest_version,
               s.publisher, s.repository_url, s.upstream_updated_at,
               COALESCE(
                   (SELECT v.transports FROM mcp_server_versions v
                     WHERE v.server_name = s.name AND v.is_latest LIMIT 1),
                   '{{}}'
               ) AS transports,
               COALESCE(
                   (SELECT v.auth_kind FROM mcp_server_versions v
                     WHERE v.server_name = s.name AND v.is_latest LIMIT 1),
                   'unknown'
               ) AS auth_kind
        FROM mcp_servers s
        WHERE {" AND ".join(where)}
        ORDER BY {order} s.upstream_updated_at DESC NULLS LAST, s.name DESC
        LIMIT :limit
    """)
    async with engine.begin() as conn:
        rows = (await conn.execute(sql, params)).mappings().all()
    return [dict(r) for r in rows]


def _prefix_query(query: str) -> str:
    """Turn free text into a safe prefix tsquery ("noti" -> "noti:*").

    Non-alphanumerics are dropped rather than escaped: this is a search box, and
    the alternative is hand-building tsquery syntax out of a stranger's input.
    """
    words = [w for w in "".join(c if c.isalnum() else " " for c in query).split() if w]
    return " & ".join(f"{w}:*" for w in words[:8]) or "zzzz:*"


def _substring_pattern(query: str) -> str:
    """An ILIKE pattern matching the query anywhere, taken literally.

    `%`, `_` and the escape character itself are escaped, so a stranger's `%`
    cannot turn the search into match-everything. A blank query yields "",
    which no registry name matches — never "%%", which matches every row.
    """
    trimmed = query.strip()[:200]
    if not trimmed:
        return ""
    escaped = trimmed.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


async def get_server(engine: AsyncEngine, name: str) -> dict | None:
    async with engine.begin() as conn:
        row = (
            (
                await conn.execute(
                    text("SELECT * FROM mcp_servers WHERE name = :name"), {"name": name}
                )
            )
            .mappings()
            .first()
        )
        return dict(row) if row else None


async def list_versions(engine: AsyncEngine, name: str) -> list[dict]:
    """Every catalogued version, newest first. Includes tombstoned versions —
    Phase 3 needs to resolve a pinned version even after upstream removal."""
    async with engine.begin() as conn:
        rows = (
            (
                await conn.execute(
                    text("""
                    SELECT server_name, version, is_latest, status, published_at,
                           upstream_updated_at, schema_version, remotes, packages,
                           transports, auth_kind
                    FROM mcp_server_versions
                    WHERE server_name = :name
                    ORDER BY is_latest DESC, published_at DESC NULLS LAST, version DESC
                """),
                    {"name": name},
                )
            )
            .mappings()
            .all()
        )
    return [dict(r) for r in rows]


async def catalogue_stats(engine: AsyncEngine) -> CatalogueStats:
    async with engine.begin() as conn:
        counts = (
            (
                await conn.execute(
                    text("""
                    SELECT
                      (SELECT count(*) FROM mcp_servers) AS servers,
                      (SELECT count(*) FROM mcp_server_versions) AS versions,
                      (SELECT count(*) FROM mcp_servers WHERE status = 'deleted')
                        AS deleted_servers
                """)
                )
            )
            .mappings()
            .first()
        )
        state = (
            (
                await conn.execute(
                    text(
                        """
                    SELECT watermark, last_success_at, last_attempt_at,
                           last_error
                    FROM mcp_sync_state WHERE source = 'official'
                    """
                    )
                )
            )
            .mappings()
            .first()
        )
    return CatalogueStats(
        servers=int(counts["servers"]) if counts else 0,
        versions=int(counts["versions"]) if counts else 0,
        deleted_servers=int(counts["deleted_servers"]) if counts else 0,
        last_success_at=state["last_success_at"] if state else None,
        last_attempt_at=state["last_attempt_at"] if state else None,
        last_error=state["last_error"] if state else None,
        watermark=state["watermark"] if state else None,
    )


class PostgresSyncPort:
    """`SyncPort` over the catalogue database.

    Deliberately thin: every method is one statement. The decision-making —
    when the watermark may advance, whether a filter was honoured — lives in
    `sync.py`, where it is testable without a server.
    """

    def __init__(self, engine: AsyncEngine, source: str = "official") -> None:
        self._engine = engine
        self._source = source

    async def load_state(self) -> tuple[datetime | None, str | None]:
        async with self._engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        text(
                            "SELECT watermark, cursor FROM mcp_sync_state "
                            "WHERE source = :s"
                        ),
                        {"s": self._source},
                    )
                )
                .mappings()
                .first()
            )
        return (row["watermark"], row["cursor"]) if row else (None, None)

    async def mark_attempt(self) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                text("""
                    INSERT INTO mcp_sync_state (source, last_attempt_at)
                    VALUES (:s, now())
                    ON CONFLICT (source) DO UPDATE SET last_attempt_at = now()
                """),
                {"s": self._source},
            )

    async def save_cursor(self, cursor: str | None) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                text("UPDATE mcp_sync_state SET cursor = :c WHERE source = :s"),
                {"c": cursor, "s": self._source},
            )

    async def apply_page(
        self, servers: list[ServerRecord], versions: list[VersionRecord]
    ) -> UpsertCounts:
        return await upsert_page(self._engine, servers, versions)

    async def finish(self, result: Any, watermark: datetime | None) -> None:
        async with self._engine.begin() as conn:
            if result.completed:
                await conn.execute(
                    text("""
                        UPDATE mcp_sync_state SET
                            watermark = :w, cursor = NULL, last_success_at = now(),
                            last_error = NULL, fetched = :f, inserted = :i,
                            updated = :u, deleted = :d, skipped = :k
                        WHERE source = :s
                    """),
                    {
                        "w": watermark,
                        "f": result.fetched,
                        "i": result.inserted,
                        "u": result.updated,
                        "d": result.deleted,
                        "k": result.skipped,
                        "s": self._source,
                    },
                )
            else:
                # Watermark deliberately untouched: the next run must re-read the
                # same window rather than skip what this run never reached.
                await conn.execute(
                    text("UPDATE mcp_sync_state SET last_error = :e WHERE source = :s"),
                    {"e": (result.error or "")[:2000], "s": self._source},
                )
