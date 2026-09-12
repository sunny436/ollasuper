"""The sync algorithm: watermark discipline, resume, tombstones, idempotency.

Hermetic — no database, no network. Persistence is injected (`SyncPort`) and the
registry is an httpx MockTransport, so the rules that are easiest to get subtly
wrong are provable on any machine, not only one with Postgres running.

The load-bearing test is `test_a_failed_run_does_not_advance_the_watermark`:
advancing it over a partial read is how an incremental sync silently loses
records forever, and nothing else in the system would notice.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.mcp.registry.client import RegistryClient
from app.mcp.registry.parse import ServerRecord, VersionRecord
from app.mcp.registry.store import UpsertCounts
from app.mcp.registry.sync import SyncResult, sync_registry

NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=UTC)


class FakePort:
    """In-memory `SyncPort`. Records exactly what the algorithm asked of it."""

    def __init__(self, watermark=None, cursor=None, fail_on_page: int | None = None):
        self.watermark = watermark
        self.cursor = cursor
        self.attempts = 0
        self.pages_applied = 0
        self.rows: dict[tuple[str, str], VersionRecord] = {}
        self.servers: dict[str, ServerRecord] = {}
        self.finished: SyncResult | None = None
        self.finished_watermark = None
        self.cursors_seen: list[str | None] = []
        self._fail_on_page = fail_on_page

    async def load_state(self):
        return self.watermark, self.cursor

    async def mark_attempt(self) -> None:
        self.attempts += 1

    async def save_cursor(self, cursor):
        self.cursor = cursor
        self.cursors_seen.append(cursor)

    async def apply_page(self, servers, versions):
        self.pages_applied += 1
        if self._fail_on_page is not None and self.pages_applied == self._fail_on_page:
            raise RuntimeError("simulated storage failure")
        counts = UpsertCounts()
        for s in servers:
            if s.name not in self.servers:
                counts.inserted += 1
            else:
                counts.updated += 1
            self.servers[s.name] = s
            if s.status == "deleted":
                counts.deleted += 1
        for v in versions:
            self.rows[(v.server_name, v.version)] = v
        return counts

    async def finish(self, result, watermark):
        self.finished = result
        self.finished_watermark = watermark
        if result.completed:
            self.watermark = watermark
            self.cursor = None


def _entry(name: str, version: str, *, updated: datetime, status="active", latest=True):
    return {
        "server": {"name": name, "version": version, "description": "d"},
        "_meta": {
            "io.modelcontextprotocol.registry/official": {
                "status": status,
                "isLatest": latest,
                "updatedAt": updated.isoformat(),
                "publishedAt": updated.isoformat(),
            }
        },
    }


def _client(pages: list[dict], *, capture: list | None = None) -> RegistryClient:
    """A registry serving `pages` in order, recording the requests it received."""
    state = {"i": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if capture is not None:
            capture.append(dict(request.url.params))
        i = min(state["i"], len(pages) - 1)
        state["i"] += 1
        return httpx.Response(200, json=pages[i])

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return RegistryClient(http, base_url="https://registry.test", page_size=100)


def _page(entries: list[dict], cursor: str | None = None) -> dict:
    meta = {"count": len(entries)}
    if cursor:
        meta["nextCursor"] = cursor
    return {"servers": entries, "metadata": meta}


# ------------------------------------------------------------- initial sync
async def test_initial_sync_pages_to_the_end_and_sets_the_watermark():
    pages = [
        _page([_entry("a/x", "1", updated=NOW)], cursor="c1"),
        _page([_entry("b/x", "1", updated=NOW)]),
    ]
    port = FakePort()
    res = await sync_registry(port, _client(pages), now=NOW)

    assert res.completed and res.full and res.pages == 2
    assert res.fetched == 2 and res.inserted == 2
    # Watermark := run START, so anything published mid-run is re-read next time.
    assert port.watermark == NOW
    assert port.cursor is None


async def test_the_first_run_sends_no_updated_since():
    seen: list[dict] = []
    port = FakePort()
    await sync_registry(port, _client([_page([])], capture=seen), now=NOW)
    assert "updated_since" not in seen[0]


# --------------------------------------------------------- incremental sync
async def test_an_incremental_run_sends_the_watermark_minus_an_overlap():
    """Records sharing a boundary timestamp must not fall between two runs."""
    seen: list[dict] = []
    prev = NOW - timedelta(hours=1)
    port = FakePort(watermark=prev)
    await sync_registry(
        port, _client([_page([_entry("a/x", "1", updated=NOW)])], capture=seen), now=NOW
    )
    sent = datetime.fromisoformat(seen[0]["updated_since"])
    assert sent == prev - timedelta(seconds=60)


async def test_a_new_version_of_a_known_server_is_added_not_replaced():
    port = FakePort()
    await sync_registry(
        port, _client([_page([_entry("a/x", "1", updated=NOW, latest=True)])]), now=NOW
    )
    await sync_registry(
        port,
        _client([_page([_entry("a/x", "2", updated=NOW, latest=True)])]),
        now=NOW + timedelta(hours=1),
    )
    assert ("a/x", "1") in port.rows and ("a/x", "2") in port.rows


# ------------------------------------------------- THE no-data-loss property
async def test_a_failed_run_does_not_advance_the_watermark():
    """The load-bearing rule. Advancing over a partial read silently drops every
    record the failed run never reached, and nothing downstream would notice."""
    prev = NOW - timedelta(hours=1)
    port = FakePort(watermark=prev, fail_on_page=2)
    pages = [
        _page([_entry("a/x", "1", updated=NOW)], cursor="c1"),
        _page([_entry("b/x", "1", updated=NOW)], cursor="c2"),
    ]
    res = await sync_registry(port, _client(pages), now=NOW)

    assert not res.completed and res.error
    assert port.watermark == prev, "watermark moved on a partial read"
    assert port.finished_watermark == prev


async def test_a_failed_run_keeps_its_cursor_so_the_next_run_resumes():
    port = FakePort(fail_on_page=2)
    pages = [
        _page([_entry("a/x", "1", updated=NOW)], cursor="c1"),
        _page([_entry("b/x", "1", updated=NOW)], cursor="c2"),
    ]
    await sync_registry(port, _client(pages), now=NOW)
    assert port.cursor == "c1", "cursor should point at the un-applied page"


async def test_a_resumed_run_starts_from_the_saved_cursor():
    seen: list[dict] = []
    port = FakePort(cursor="c-saved", watermark=NOW - timedelta(hours=1))
    await sync_registry(port, _client([_page([])], capture=seen), now=NOW)
    assert seen[0]["cursor"] == "c-saved"


async def test_page_one_survives_a_failure_on_page_two():
    """§7: a sync must not lose the catalogue because one page failed."""
    port = FakePort(fail_on_page=2)
    pages = [
        _page([_entry("a/x", "1", updated=NOW)], cursor="c1"),
        _page([_entry("b/x", "1", updated=NOW)], cursor="c2"),
    ]
    await sync_registry(port, _client(pages), now=NOW)
    assert ("a/x", "1") in port.rows


# ------------------------------------------------------------- idempotency
async def test_replaying_the_same_pages_converges():
    """Idempotency — not the cursor — is what makes a failed run safe to rerun."""
    pages = [_page([_entry("a/x", "1", updated=NOW)])]
    port = FakePort()
    await sync_registry(port, _client(pages), now=NOW)
    first = dict(port.rows)
    await sync_registry(port, _client(pages), now=NOW + timedelta(minutes=1))
    assert port.rows.keys() == first.keys()
    assert port.finished.inserted == 0, "a replay should update, not insert"


# -------------------------------------------------------------- tombstones
async def test_a_deleted_server_is_counted_and_kept_not_dropped():
    """`include_deleted` is always true with `updated_since`, so an incremental
    page CARRIES deletions. Dropping them leaves a removed server connectable."""
    port = FakePort(watermark=NOW - timedelta(hours=1))
    pages = [_page([_entry("gone/x", "1", updated=NOW, status="deleted")])]
    res = await sync_registry(port, _client(pages), now=NOW)
    assert res.deleted == 1
    assert port.servers["gone/x"].status == "deleted"
    assert ("gone/x", "1") in port.rows, "tombstone row must be retained"


# ------------------------------------------ the silently-ignored-param trap
async def test_an_ignored_updated_since_is_detected_and_downgrades_to_full():
    """The registry ignores unknown params and still returns 200. If the filter
    silently stops applying, advancing the watermark would record a lie."""
    prev = NOW - timedelta(days=1)
    ancient = NOW - timedelta(days=900)
    port = FakePort(watermark=prev)
    pages = [_page([_entry("old/x", "1", updated=ancient)])]
    res = await sync_registry(port, _client(pages), now=NOW)

    assert res.filter_ignored is True
    assert res.full is True, "must be recorded as a full sync, not an incremental one"


async def test_a_correctly_filtered_page_does_not_trip_the_detector():
    prev = NOW - timedelta(days=1)
    port = FakePort(watermark=prev)
    pages = [_page([_entry("new/x", "1", updated=NOW)])]
    res = await sync_registry(port, _client(pages), now=NOW)
    assert res.filter_ignored is False


async def test_clock_skew_alone_does_not_trip_the_detector():
    """A few seconds of skew between the registry's clock and ours is not an
    ignored filter, and treating it as one would cry wolf on every run."""
    prev = NOW - timedelta(days=1)
    port = FakePort(watermark=prev)
    # Two seconds before the requested window — within tolerance.
    edge = prev - timedelta(seconds=62)
    res = await sync_registry(
        port, _client([_page([_entry("e/x", "1", updated=edge)])]), now=NOW
    )
    assert res.filter_ignored is False


# ------------------------------------------------------------------ failure
async def test_an_upstream_error_is_recorded_not_raised():
    def handler(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    client = RegistryClient(
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        base_url="https://registry.test",
        max_retries=0,
    )
    port = FakePort(watermark=NOW - timedelta(hours=1))
    res = await sync_registry(port, client, now=NOW)
    assert not res.completed and "500" in (res.error or "")
    assert port.watermark == NOW - timedelta(hours=1)


async def test_a_4xx_is_not_retried():
    calls = {"n": 0}

    def handler(_r: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, json={"error": "bad"})

    client = RegistryClient(
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        base_url="https://registry.test",
        max_retries=3,
    )
    await sync_registry(FakePort(), client, now=NOW)
    assert calls["n"] == 1, "a permanently invalid request must not be retried"


async def test_a_malformed_record_is_skipped_without_losing_the_page():
    port = FakePort()
    bad = {"server": {"name": "", "version": ""}, "_meta": {}}
    pages = [_page([bad, _entry("ok/x", "1", updated=NOW)])]
    res = await sync_registry(port, _client(pages), now=NOW)
    assert res.skipped == 1 and ("ok/x", "1") in port.rows and res.completed


async def test_malformed_json_is_reported_as_a_failed_run():
    def handler(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not json{{")

    client = RegistryClient(
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        base_url="https://registry.test",
        max_retries=0,
    )
    res = await sync_registry(FakePort(), client, now=NOW)
    assert not res.completed and res.error


@pytest.mark.parametrize("force", [True, False])
async def test_force_full_ignores_the_watermark(force: bool):
    seen: list[dict] = []
    port = FakePort(watermark=NOW - timedelta(days=2))
    await sync_registry(
        port, _client([_page([])], capture=seen), now=NOW, force_full=force
    )
    assert ("updated_since" in seen[0]) is (not force)


async def test_sync_never_raises_even_on_an_unexpected_error():
    class Exploding(FakePort):
        async def apply_page(self, servers, versions):
            raise ValueError("unexpected")

    res = await sync_registry(
        Exploding(), _client([_page([_entry("a/x", "1", updated=NOW)])]), now=NOW
    )
    assert not res.completed and "ValueError" in (res.error or "")


def test_the_json_fixtures_are_valid():
    from pathlib import Path

    for f in (Path(__file__).parent / "fakes" / "registry").glob("*.json"):
        json.loads(f.read_text(encoding="utf-8"))
