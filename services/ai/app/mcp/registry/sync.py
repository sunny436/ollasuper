"""The registry sync: page → parse → upsert → checkpoint, with a safe watermark.

    read watermark → page (updated_since = watermark − overlap)
        → parse → upsert → advance CURSOR
    → on full success: advance WATERMARK
    → on failure: keep watermark, keep cursor, exit

THE RULE THAT PREVENTS SILENT DATA LOSS: the cursor moves per page, the
**watermark moves only after a whole run succeeds**. A mid-run failure resumes
from the cursor and still re-reads from the OLD watermark, so no record can fall
into a window that was advanced over a partial read.

To be precise about which property does the work: **idempotency is what makes a
failed run safe**, not the cursor. Every write is an upsert keyed on the
registry's own identity, so a replay converges. The cursor only avoids redundant
work — at today's measured 2,600 records over 27 pages a full re-read is cheap,
and the cursor earns its place by future-proofing rather than by rescuing.

PERSISTENCE IS INJECTED (`SyncPort`), and not for purity's sake: it means the
watermark/resume/tombstone rules above are provable on a machine with no
database at all, which is the machine this was written on. The Postgres
implementation lives in `store.py`; the SQL it runs is covered by the DB-gated
tests. An algorithm this easy to get subtly wrong should not be testable only
where a server happens to be running.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

from app.logging import get_logger
from app.mcp.registry.client import RegistryClient, RegistryError
from app.mcp.registry.parse import ServerRecord, VersionRecord, parse_page
from app.mcp.registry.store import UpsertCounts

log = get_logger(__name__)

__all__ = ["SyncPort", "SyncResult", "sync_registry"]

SOURCE = "official"
# Re-read window. Records sharing a boundary timestamp with the watermark could
# otherwise fall between two runs; an overlap costs a few duplicate upserts,
# which are free, and closes that gap.
_OVERLAP = timedelta(seconds=60)
# A cursor chain that never terminates must not run forever. 27 pages is the
# whole registry today; 5,000 is ~185x headroom and still bounded.
_MAX_PAGES = 5_000
# Tolerance when checking that `updated_since` was honoured — clock skew between
# the registry's clock and ours should not be read as an ignored filter.
_FILTER_SLACK = timedelta(seconds=5)


@dataclass
class SyncResult:
    pages: int = 0
    fetched: int = 0
    inserted: int = 0
    updated: int = 0
    deleted: int = 0
    skipped: int = 0
    full: bool = False
    completed: bool = False
    error: str | None = None
    #: Set when the registry ignored `updated_since` — see `_filter_applied`.
    filter_ignored: bool = False


class SyncPort(Protocol):
    """Everything the algorithm needs from storage, and nothing more."""

    async def load_state(self) -> tuple[datetime | None, str | None]:
        """(watermark, cursor) for this source."""
        ...

    async def mark_attempt(self) -> None: ...

    async def save_cursor(self, cursor: str | None) -> None: ...

    async def apply_page(
        self, servers: list[ServerRecord], versions: list[VersionRecord]
    ) -> UpsertCounts: ...

    async def finish(self, result: SyncResult, watermark: datetime | None) -> None:
        """Persist the outcome. MUST write `watermark` only when
        `result.completed` — the whole no-data-loss argument rests on it."""
        ...


def _filter_applied(oldest: datetime | None, since: datetime | None) -> bool:
    """Did `updated_since` actually take effect?

    The registry **ignores unknown query parameters and still returns 200**
    (probed against the live service), so a renamed or misspelled parameter turns
    an incremental sync into a silent full one. The catalogue would stay correct,
    but the watermark would advance believing a filter ran, and every subsequent
    run would silently re-read the whole registry forever.

    A record older than the requested window proves the filter did not apply.
    """
    if since is None or oldest is None:
        return True
    return oldest >= since - _FILTER_SLACK


async def sync_registry(
    port: SyncPort,
    client: RegistryClient,
    *,
    force_full: bool = False,
    now: datetime | None = None,
) -> SyncResult:
    """Run one sync. Returns counts; never raises for an upstream failure.

    `now` is injected rather than read from the clock so a DBOS replay and a test
    both see a stable value — the discipline `scheduler/tick.py` already uses.
    """
    started = now or datetime.now(UTC)
    watermark, cursor = await port.load_state()
    await port.mark_attempt()

    since = None if (force_full or watermark is None) else watermark - _OVERLAP
    result = SyncResult(full=since is None)
    counts = UpsertCounts()

    try:
        while result.pages < _MAX_PAGES:
            page = await client.fetch_page(
                cursor=cursor,
                updated_since=since.isoformat() if since else None,
            )
            parsed = parse_page(page.payload)
            result.pages += 1
            result.fetched += len(parsed.versions)
            result.skipped += parsed.skipped

            if since is not None and not _filter_applied(
                parsed.oldest_updated_at, since
            ):
                # Loud AND behaviour-changing: downgrade to a full sync so the
                # watermark is not advanced on the belief that a filter ran.
                log.warning(
                    "mcp.registry.updated_since_ignored",
                    extra={
                        "requested": since.isoformat(),
                        "oldest": str(parsed.oldest_updated_at),
                    },
                )
                result.filter_ignored = True
                result.full = True
                since = None

            counts.add(await port.apply_page(parsed.servers, parsed.versions))
            cursor = page.next_cursor
            await port.save_cursor(cursor)
            if not cursor:
                result.completed = True
                break
        else:
            result.error = f"page cap {_MAX_PAGES} reached; cursor chain did not end"
    except RegistryError as e:
        result.error = str(e)
    except Exception as e:  # noqa: BLE001 — a sync failure must not kill the worker
        result.error = f"{type(e).__name__}: {e}"

    result.inserted = counts.inserted
    result.updated = counts.updated
    result.deleted = counts.deleted

    # Watermark := when this run STARTED, not when it ended. Anything published
    # while the run was in flight is re-read next time rather than skipped.
    await port.finish(result, started if result.completed else watermark)
    log.info("mcp.registry.sync", extra=dict(asdict(result).items()))
    return result
