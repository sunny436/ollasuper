"""Reading the `mcp_local_servers` allowlist.

Mirrors `curated.py` — same shape, same reasons: a frozen row the rest of the
stack can hold, resolved ONCE per connection so a table edit cannot re-point a
live session, and a `list_local` for the status route.

SEPARATE FROM `curated.py` BECAUSE THE TABLES ARE SEPARATE, and they are separate
because "may this run remotely" and "may this run locally" are independent
operator decisions (§49). A server can legitimately be remote-allowed and
local-blocked.

NOTHING HERE DECIDES POLICY. It reads rows; `local/policy.py` decides whether one
may start. Keeping them apart is what lets the validator be tested exhaustively
with no database at all.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.logging import get_logger

log = get_logger(__name__)

__all__ = ["LocalServerRow", "list_local", "resolve"]

#: Concatenated, never f-string interpolated — the same shape `curated.py` uses,
#: so the only values that ever reach a query are named parameters.
_SELECT = """
    SELECT slug, display_name, gateway_name, gateway_port, image, image_digest,
           trust, network, network_allow, secret_refs, env_allow,
           cpus, memory_mb, enabled, notes
      FROM mcp_local_servers
"""


@dataclass(frozen=True)
class LocalServerRow:
    """One local server, exactly as curated. Frozen: a live connection must not
    change underneath a running turn."""

    slug: str
    display_name: str
    gateway_name: str
    gateway_port: int
    image: str
    image_digest: str
    trust: str
    network: str
    network_allow: tuple[str, ...]
    secret_refs: tuple[str, ...]
    env_allow: tuple[str, ...]
    cpus: float
    memory_mb: int
    enabled: bool
    notes: str | None = None
    #: Set by the caller from `mcp_curated_servers`, so the validator can refuse
    #: a slug collision without this module needing to know about that table.
    server_name: str = ""


def _row(record: Any) -> LocalServerRow:
    return LocalServerRow(
        slug=record["slug"],
        display_name=record["display_name"],
        gateway_name=record["gateway_name"],
        gateway_port=int(record["gateway_port"]),
        image=record["image"],
        image_digest=record["image_digest"],
        trust=record["trust"],
        network=record["network"],
        network_allow=tuple(record["network_allow"] or ()),
        secret_refs=tuple(record["secret_refs"] or ()),
        env_allow=tuple(record["env_allow"] or ()),
        cpus=float(record["cpus"]),
        memory_mb=int(record["memory_mb"]),
        enabled=bool(record["enabled"]),
        notes=record["notes"],
        server_name=f"local/{record['slug']}",
    )


async def resolve(engine: Any, slug: str) -> LocalServerRow | None:
    """The local row for one slug, or None.

    None for BOTH "no such row" and "no database", because the caller's correct
    response is identical — treat the ref as remote. A local deployment with the
    flag on but no table is a misconfiguration the status route reports, not
    something that should break a chat turn.
    """
    if engine is None or not slug:
        return None
    from sqlalchemy import text

    try:
        async with engine.begin() as conn:
            result = await conn.execute(
                text(_SELECT + " WHERE slug = :slug"), {"slug": slug}
            )
            record = result.mappings().first()
    except Exception as exc:  # noqa: BLE001 — a missing table is not a crash
        log.warning(
            "mcp.local_store_unavailable",
            extra={"slug": slug, "reason": type(exc).__name__},
        )
        return None
    return _row(record) if record is not None else None


async def list_local(
    engine: Any, *, enabled_only: bool = True
) -> list[LocalServerRow]:
    """Every curated local server, for the status route."""
    if engine is None:
        return []
    from sqlalchemy import text

    clause = " WHERE enabled" if enabled_only else ""
    try:
        async with engine.begin() as conn:
            result = await conn.execute(text(_SELECT + clause + " ORDER BY slug"))
            return [_row(r) for r in result.mappings().all()]
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "mcp.local_store_unavailable", extra={"reason": type(exc).__name__}
        )
        return []
