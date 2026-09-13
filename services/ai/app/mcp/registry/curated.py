"""The curated set — which servers this deployment will actually connect to.

Mirrors `store.py`: SQLAlchemy `text()` with named parameters throughout, so an
operator-supplied note or a registry-supplied name can never reach the SQL
grammar.

THE JOIN THIS MODULE EXISTS FOR. Connecting needs three things that live in
three places:

    mcp_curated_servers   OllaSuper's decision  (which, which version, trusted?)
    mcp_servers           upstream identity + lifecycle status
    mcp_server_versions   the remotes/auth metadata for the chosen version

`resolve()` performs that join once and returns a `CuratedTarget` carrying
everything `McpConnectionSpec` needs — so the connect path never has to reach
back into the catalogue, and a registry outage makes the catalogue stale rather
than unavailable.

CATALOGUE STATUS AND CURATION STATUS ARE SEPARATE, deliberately. A server the
registry has deprecated or deleted stays curated and stays resolvable; what
changes is that `resolve()` reports the upstream status alongside, and the
lifecycle layer decides. Deleting a curation row because upstream moved would
destroy an operator decision on a third party's say-so.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

__all__ = [
    "CuratedTarget",
    "list_curated",
    "resolve",
    "upsert_curated",
]


@dataclass(frozen=True)
class CuratedTarget:
    """One curated server, resolved against the catalogue and ready to dial."""

    server_name: str
    slug: str
    display_name: str
    category: str
    transport: str
    endpoint_url: str
    auth_kind: str
    trusted: bool
    enabled: bool
    #: The version this connection should use: the pin if there is one, else the
    #: catalogue's current latest. Resolved ONCE, here, so the answer is stable
    #: for the life of the connection record rather than drifting under it.
    version: str | None
    version_mode: str
    #: Upstream lifecycle: active | deprecated | deleted. Reported, never acted
    #: on here — a deleted server does not delete a curation row.
    catalogue_status: str
    #: The chosen version's own upstream status, which can differ: a server can
    #: be active while the pinned version is tombstoned.
    version_status: str | None
    #: Upstream `remotes` for the chosen version, verbatim. The lifecycle layer
    #: runs `compat.assess` over this rather than trusting the curated endpoint
    #: blindly, so a server that dropped its remote is caught before dialling.
    remotes: Any = None
    packages: Any = None


_SELECT = """
    SELECT c.server_name, c.slug, c.display_name, c.category, c.transport,
           c.endpoint_url, c.auth_kind, c.trusted, c.enabled,
           c.pinned_version, c.notes,
           s.status        AS catalogue_status,
           s.latest_version,
           s.title, s.description
    FROM mcp_curated_servers c
    JOIN mcp_servers s ON s.name = c.server_name
"""

#: What a BROWSER may see. Everything absent from this tuple is absent on
#: purpose, and the two that matter most are:
#:
#:   endpoint_url  -- the internal network location this deployment dials. It is
#:                    not a secret, but it is infrastructure, and a UI has no use
#:                    for it. Dropping it HERE rather than in Convex means it
#:                    never crosses the process boundary at all.
#:   notes         -- operator prose. "flaky above 50 rps", "renew cert in March"
#:                    is a note to a colleague, not product copy.
#:
#: `trusted` is dropped too: it is the operator's decision about whether to
#: believe a server's own annotations, and surfacing it would invite a user to
#: read it as a safety rating.
_SAFE_FIELDS = (
    "server_name",
    "slug",
    "display_name",
    "category",
    "transport",
    "auth_kind",
    "enabled",
    "catalogue_status",
    "title",
    "description",
)


def _safe(row: dict) -> dict:
    """An allowlist, never a denylist.

    A column added to `_SELECT` later must be named here before a browser can
    see it — the failure direction that cannot leak. A denylist would ship the
    new column by default and only stop it once somebody noticed.
    """
    return {k: row.get(k) for k in _SAFE_FIELDS}


async def list_curated(
    engine: AsyncEngine, *, enabled_only: bool = True, safe: bool = False
) -> list[dict]:
    """The picker's source. ~30 rows, so no pagination and no search.

    `safe=True` returns the browser projection (see `_SAFE_FIELDS`). It defaults
    to False so that existing internal callers — which legitimately need the
    endpoint — are unchanged by this addition.
    """
    clause = " WHERE c.enabled" if enabled_only else ""
    query = text(_SELECT + clause + " ORDER BY c.category, c.slug")
    async with engine.begin() as conn:
        rows = (await conn.execute(query)).mappings().all()
    ordered = sorted(
        (dict(r) for r in rows),
        key=lambda r: (
            _everyday_rank(r["slug"]),
            str(r.get("display_name") or r["slug"]),
        ),
    )
    return [_safe(r) if safe else r for r in ordered]


#: What a browser sees FIRST. The catalogue holds ~60 servers and the page
#: renders them in the order this list returns them, so "sorted by category,
#: then slug" put Apify and Bitly above Gmail. Ranked by everyday use — mail,
#: calendar, files, chat, code, tasks, docs — then everything else alphabetical.
#: Presentation only: nothing else reads the order.
_EVERYDAY_FIRST: tuple[str, ...] = (
    "gmail",
    "google-calendar",
    "google-drive",
    "google-docs",
    "google-sheets",
    "slack",
    "github",
    "notion",
    "linear",
    "atlassian",
    "asana",
    "clickup",
    "monday",
    "todoist",
    "google-maps",
    "zoom-meetings",
    "zoom-chat",
    "zoom-workspace",
    "zoom-tasks",
    "hubspot",
    "canva",
    "figma",
    "miro",
    "airtable",
    "dropbox",
    "box",
    "stripe",
    "paypal",
    "zapier",
    "make",
    "gitlab",
    "vercel",
    "supabase",
    "sentry",
    "context7",
    "exa",
)
_EVERYDAY_RANK = {slug: i for i, slug in enumerate(_EVERYDAY_FIRST)}


def _everyday_rank(slug: str) -> int:
    return _EVERYDAY_RANK.get(slug, len(_EVERYDAY_FIRST))


async def resolve(engine: AsyncEngine, server_name: str) -> CuratedTarget | None:
    """Join curation + catalogue + the chosen version. None if not curated.

    Returns a target even when the server is DISABLED or upstream-deleted: the
    caller needs to distinguish "not curated here" from "curated but turned off"
    from "curated but withdrawn upstream", and collapsing those into None would
    make all three read as "unknown server".
    """
    async with engine.begin() as conn:
        row = (
            (
                await conn.execute(
                    text(_SELECT + " WHERE c.server_name = :name"),
                    {"name": server_name},
                )
            )
            .mappings()
            .first()
        )
        if row is None:
            return None

        pinned = row["pinned_version"]
        version = pinned or row["latest_version"]
        version_status = None
        remotes: Any = None
        packages: Any = None
        if version:
            vrow = (
                (
                    await conn.execute(
                        text("""
                        SELECT status, remotes, packages
                        FROM mcp_server_versions
                        WHERE server_name = :name AND version = :version
                    """),
                        {"name": server_name, "version": version},
                    )
                )
                .mappings()
                .first()
            )
            if vrow is not None:
                version_status = vrow["status"]
                remotes = vrow["remotes"]
                packages = vrow["packages"]

    return CuratedTarget(
        server_name=row["server_name"],
        slug=row["slug"],
        display_name=row["display_name"],
        category=row["category"],
        transport=row["transport"],
        endpoint_url=row["endpoint_url"],
        auth_kind=row["auth_kind"],
        trusted=bool(row["trusted"]),
        enabled=bool(row["enabled"]),
        version=version,
        version_mode="pinned" if pinned else "latest_at_connect",
        catalogue_status=row["catalogue_status"],
        version_status=version_status,
        remotes=remotes,
        packages=packages,
    )


_UPSERT = text("""
    INSERT INTO mcp_curated_servers (
        server_name, slug, display_name, category, pinned_version,
        transport, endpoint_url, auth_kind, trusted, enabled, notes, curated_by
    ) VALUES (
        :server_name, :slug, :display_name, :category, :pinned_version,
        :transport, :endpoint_url, :auth_kind, :trusted, :enabled, :notes,
        :curated_by
    )
    ON CONFLICT (server_name) DO UPDATE SET
        slug           = EXCLUDED.slug,
        display_name   = EXCLUDED.display_name,
        category       = EXCLUDED.category,
        pinned_version = EXCLUDED.pinned_version,
        transport      = EXCLUDED.transport,
        endpoint_url   = EXCLUDED.endpoint_url,
        auth_kind      = EXCLUDED.auth_kind,
        trusted        = EXCLUDED.trusted,
        enabled        = EXCLUDED.enabled,
        notes          = EXCLUDED.notes,
        curated_by     = EXCLUDED.curated_by
""")


async def upsert_curated(
    engine: AsyncEngine,
    *,
    server_name: str,
    slug: str,
    display_name: str,
    category: str,
    transport: str,
    endpoint_url: str,
    auth_kind: str = "unknown",
    pinned_version: str | None = None,
    trusted: bool = False,
    enabled: bool = False,
    notes: str | None = None,
    curated_by: str | None = None,
) -> None:
    """Add or update one curation decision.

    `trusted` and `enabled` both default FALSE. Curating a server makes it
    connectable; believing its self-reported `readOnlyHint` is a second,
    explicit decision — see the migration's docstring.

    The slug is validated by constructing the identity rather than by a regex
    here, so there is exactly one definition of a legal slug.
    """
    from app.mcp.models import McpServerIdentity  # noqa: PLC0415 — avoids a cycle

    McpServerIdentity(slug=slug)  # raises McpConfigError on an illegal slug

    async with engine.begin() as conn:
        await conn.execute(
            _UPSERT,
            {
                "server_name": server_name,
                "slug": slug,
                "display_name": display_name,
                "category": category,
                "pinned_version": pinned_version,
                "transport": transport,
                "endpoint_url": endpoint_url,
                "auth_kind": auth_kind,
                "trusted": trusted,
                "enabled": enabled,
                "notes": notes,
                "curated_by": curated_by,
            },
        )
