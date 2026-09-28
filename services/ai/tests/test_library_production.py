"""File Library production hardening (2026-09-29) — hermetic tests.

Physical blob reclamation, failure codes, the generation fence on the Python
side, retrieval across embedding models, purge refusal + cache eviction, the
generated-file storage refusals, sandboxed dataset/document plumbing and the
minimum sandbox isolation. DB-backed proofs of the store live in
test_knowledge_db.py (they run against real pgvector on the VM).
"""

from __future__ import annotations

import asyncio
import json
import os
from types import SimpleNamespace

import pandas as pd
import pytest
from fastapi import HTTPException

from app.data import loader
from app.db import store
from app.documents import isolated
from app.documents.pdf_ops import DocumentError
from app.ingest import embed as embedmod
from app.ingest import pipeline, retrieve
from app.ingest.types import IngestError, failure_code_for
from app.ops import blob_reclaim as br
from app.routers import files as files_router
from app.sandbox import harness
from app.sandbox import ops as sandbox_ops
from tests.conftest import make_settings

SETTINGS = make_settings("http://localhost:9999")
NOW = 2_000_000_000.0


# ================================================================ blob reclaim


class FakeDB:
    """The two answers the reclaimer asks Postgres for."""

    def __init__(self, tables=("aa",), protected=(), exports=()):
        self.tables = list(tables)
        self.protected = [set(protected)]
        self.exports = list(exports)
        self.calls: list[str] = []

    def __call__(self, sql: str) -> list[list[str]]:
        if "WITH RECURSIVE" in sql:
            self.calls.append("tables")
            return [[t] for t in self.tables]
        if "zip_object_key" in sql:
            self.calls.append("exports")
            return [list(e) for e in self.exports]
        self.calls.append("protected")
        cur = self.protected[0] if len(self.protected) == 1 else self.protected.pop(0)
        return [[k] for k in sorted(cur)]


def _blob(d, key: str, age_s: float, size: int = 10) -> str:
    path = os.path.join(d, f"{key}.blob")
    with open(path, "wb") as fh:
        fh.write(b"x" * size)
    os.utime(path, (NOW - age_s, NOW - age_s))
    return path


def test_reclaim_deletes_only_unreferenced_old_blobs(tmp_path):
    d = str(tmp_path)
    live = _blob(d, "live", 9999)
    orphan = _blob(d, "orphan", 9999, size=100)
    young = _blob(d, "young", 60)  # an upload whose record is not committed yet
    other = tmp_path / "notes.txt"
    other.write_text("not a blob")
    db = FakeDB(protected={"live"})

    dry = br.reclaim_files(db, storage_dir=d, apply=False, now=NOW)
    assert (dry.candidates, dry.candidate_bytes, dry.too_young) == (1, 100, 1)
    assert dry.deleted == 0 and os.path.exists(orphan)

    rep = br.reclaim_files(db, storage_dir=d, apply=True, now=NOW)
    assert rep.status == "ok"
    assert (rep.deleted, rep.deleted_bytes) == (1, 100)
    assert not os.path.exists(orphan)
    assert os.path.exists(live) and os.path.exists(young) and other.exists()


def test_reclaim_rechecks_the_protected_set_right_before_unlinking(tmp_path):
    d = str(tmp_path)
    kept = _blob(d, "k", 9999)
    # Unprotected when listed, protected by the time of the unlink.
    db = FakeDB()
    db.protected = [set(), {"k"}]
    rep = br.reclaim_files(db, storage_dir=d, apply=True, now=NOW)
    assert rep.rescued_by_recheck == 1 and rep.deleted == 0
    assert os.path.exists(kept)


def test_reclaim_stops_without_deleting_past_the_ceiling(tmp_path):
    d = str(tmp_path)
    for i in range(5):
        _blob(d, f"o{i}", 9999)
    rep = br.reclaim_files(FakeDB(), storage_dir=d, apply=True, max_delete=3, now=NOW)
    assert rep.status == "stopped" and rep.deleted == 0
    assert len(os.listdir(d)) == 5


def test_reclaim_refuses_when_no_file_storage_table_is_found(tmp_path):
    d = str(tmp_path)
    _blob(d, "o", 9999)
    rep = br.reclaim_files(FakeDB(tables=()), storage_dir=d, apply=True, now=NOW)
    assert rep.status == "stopped" and rep.deleted == 0
    assert os.listdir(d) == ["o.blob"]


def test_reclaim_can_quarantine_instead_of_deleting(tmp_path):
    d = tmp_path / "files"
    d.mkdir()
    q = tmp_path / "quarantine"
    _blob(str(d), "o", 9999, size=7)
    rep = br.reclaim_files(
        FakeDB(), storage_dir=str(d), apply=True, quarantine=str(q), now=NOW
    )
    assert (rep.quarantined, rep.deleted_bytes) == (1, 7)
    moved = [p for p in q.rglob("*.blob")]
    assert [p.name for p in moved] == ["o.blob"]


def test_the_grace_cutoff_is_passed_in_nanoseconds():
    seen: list[str] = []

    def q(sql: str) -> list[list[str]]:
        seen.append(sql)
        return []

    br.protected_keys(q, ["ab12"], grace_s=600, now=NOW)
    assert str(int((NOW - 600) * 1_000_000_000)) in seen[0]
    assert "decode('ab12', 'hex')" in seen[0]


def test_a_table_id_that_is_not_hex_is_refused():
    with pytest.raises(RuntimeError):
        br.file_tables(lambda sql: [["ab'); drop table documents;--"]])


def test_exports_keep_the_newest_and_never_touch_one_in_flight(tmp_path):
    d = str(tmp_path)
    _blob(d, "newest", 3600 * 50)
    _blob(d, "second", 3600 * 60)
    _blob(d, "running", 3600 * 90)
    _blob(d, "old", 3600 * 100, size=1000)
    _blob(d, "orphan", 3600 * 120, size=10)
    db = FakeDB(
        exports=[
            ("newest", "completed"),
            ("second", "completed"),
            ("running", "in_progress"),
            ("old", "completed"),
        ]
    )
    rep = br.reclaim_exports(
        db, exports_dir=d, apply=True, keep=2, keep_hours=48, now=NOW
    )
    assert sorted(os.listdir(d)) == ["newest.blob", "running.blob", "second.blob"]
    assert (rep.deleted, rep.deleted_bytes) == (2, 1010)


@pytest.mark.skipif(os.name != "posix", reason="flock is POSIX-only (the VM)")
def test_a_held_storage_lock_skips_the_run(tmp_path):
    lock = str(tmp_path / "storage.lock")
    with br.storage_lock(lock) as first:
        assert first is True
        with br.storage_lock(lock) as second:
            assert second is False


# ================================================================ failure codes


def test_failures_carry_stable_codes():
    assert IngestError("Embedding provider failed").code == "EMBED_PROVIDER"
    assert IngestError("File too large: 30.0 MB (max 20 MB)").code == "TOO_LARGE"
    assert IngestError("anything", code="FETCH_FAILED").code == "FETCH_FAILED"
    assert (
        failure_code_for("the attachment sandbox is unavailable")
        == "SANDBOX_UNAVAILABLE"
    )
    assert failure_code_for("some parser blew up") == "PARSE_FAILED"


# ================================================================ pipeline


class _Convex:
    def __init__(self, fetch_error: Exception | None = None) -> None:
        self.statuses: list[tuple] = []
        self.progress: list[dict] = []
        self.fetch_error = fetch_error

    async def fetch_ingest_file(self, ingest_id):
        if self.fetch_error:
            raise self.fetch_error
        return b"hello world, a plain text document", "text/plain"

    async def set_file_progress(self, ingest_id, **kw):
        self.progress.append(kw)

    async def set_file_status(self, ingest_id, status, **kw):
        self.statuses.append((ingest_id, status, kw))


@pytest.fixture
def fake_embed(monkeypatch):
    async def fake(settings, texts, progress_cb=None):
        return [[0.0] for _ in texts]

    monkeypatch.setattr(embedmod, "embed_documents", fake)


async def _ingest(convex, **kw):
    await pipeline.run_ingest(
        ingest_id="ing-9",
        user_id="u1",
        workspace_id="w1",
        name="a.txt",
        content_type="text/plain",
        engine=object(),
        convex=convex,
        settings=SETTINGS,
        **kw,
    )


async def test_the_generation_travels_on_every_callback_and_write(
    monkeypatch, fake_embed
):
    written: dict = {}

    async def persist(engine, **kw):
        written.update(kw)
        return 1

    monkeypatch.setattr(pipeline.store, "persist_ingest", persist)
    convex = _Convex()
    await _ingest(convex, generation=4)
    assert written["generation"] == 4
    assert convex.statuses[-1][1] == "ready"
    assert convex.statuses[-1][2]["generation"] == 4
    assert all(p.get("generation") == 4 for p in convex.progress)


async def test_a_stale_generation_writes_nothing_and_reports_nothing(
    monkeypatch, fake_embed
):
    async def persist(engine, **kw):
        raise store.IngestStale("ing-9")

    monkeypatch.setattr(pipeline.store, "persist_ingest", persist)
    convex = _Convex()
    await _ingest(convex, generation=1)
    assert convex.statuses == []


async def test_a_reindex_shows_no_progress(monkeypatch, fake_embed):
    async def persist(engine, **kw):
        return 1

    monkeypatch.setattr(pipeline.store, "persist_ingest", persist)
    convex = _Convex()
    await _ingest(convex, generation=2, reindex=True)
    assert convex.progress == []
    assert convex.statuses[-1][1] == "ready"


async def test_a_failed_fetch_is_a_retryable_code(fake_embed):
    from app.clients.convex import ConvexUnavailable

    convex = _Convex(fetch_error=ConvexUnavailable("down"))
    await _ingest(convex, generation=3)
    (_, status, kw) = convex.statuses[-1]
    assert status == "failed"
    assert kw["failure_code"] == "FETCH_FAILED" and kw["generation"] == 3


# ================================================================ retrieval


async def test_one_model_is_exactly_the_old_single_query(monkeypatch):
    calls: list[dict] = []

    async def models(engine, **kw):
        return {SETTINGS.openrouter_embedding_model: ["f1"]}

    async def fake_retrieve(engine, **kw):
        calls.append(kw)
        return [{"file_id": "f1", "content": "c", "distance": 0.1}]

    async def fake_query(settings, text, *, model=None):
        return [0.0]

    monkeypatch.setattr(retrieve.store, "models_for_files", models)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)
    monkeypatch.setattr(retrieve.embed, "embed_query", fake_query)
    rows = await retrieve._retrieve_all_models(
        SETTINGS, object(), user_id="u1", query="what is it", file_ids=["f1"]
    )
    assert len(calls) == 1
    assert calls[0]["file_ids"] == ["f1"]
    assert calls[0]["embedding_model"] == SETTINGS.openrouter_embedding_model
    assert rows[0]["file_id"] == "f1"


async def test_mid_migration_every_model_is_searched_and_nothing_disappears(
    monkeypatch,
):
    cur = SETTINGS.openrouter_embedding_model
    queried: list[str | None] = []

    async def models(engine, **kw):
        return {cur: ["new1"], "old-model": ["old1", "old2"]}

    async def fake_retrieve(engine, **kw):
        model = kw["embedding_model"]
        return (
            [
                {"file_id": fid, "content": f"{fid}-chunk", "distance": 0.2}
                for fid in kw["file_ids"]
            ]
            if model
            else []
        )

    async def fake_query(settings, text, *, model=None):
        queried.append(model)
        return [0.0]

    monkeypatch.setattr(retrieve.store, "models_for_files", models)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)
    monkeypatch.setattr(retrieve.embed, "embed_query", fake_query)
    rows = await retrieve._retrieve_all_models(
        SETTINGS, object(), user_id="u1", query="q", file_ids=["new1", "old1", "old2"]
    )
    assert queried == [cur, "old-model"]
    assert {r["file_id"] for r in rows} == {"new1", "old1", "old2"}


async def test_a_retired_model_is_skipped_loudly_not_silently(monkeypatch, caplog):
    cur = SETTINGS.openrouter_embedding_model

    async def models(engine, **kw):
        return {cur: ["a"], "gone-model": ["b"]}

    async def fake_retrieve(engine, **kw):
        return [{"file_id": f, "content": f, "distance": 0.1} for f in kw["file_ids"]]

    async def fake_query(settings, text, *, model=None):
        if model == "gone-model":
            raise RuntimeError("404 model not found")
        return [0.0]

    monkeypatch.setattr(retrieve.store, "models_for_files", models)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)
    monkeypatch.setattr(retrieve.embed, "embed_query", fake_query)
    rows = await retrieve._retrieve_all_models(
        SETTINGS, object(), user_id="u1", query="q", file_ids=["a", "b"]
    )
    assert [r["file_id"] for r in rows] == ["a"]
    assert "LIB_INDEX_MODEL_UNAVAILABLE" in caplog.text


# ================================================================ purge + caches


async def test_purge_without_a_database_is_a_failure_not_a_success():
    state = SimpleNamespace(db=None)
    request = SimpleNamespace(app=SimpleNamespace(state=state))
    with pytest.raises(HTTPException) as e:
        await files_router.purge("ing-1", request)
    assert e.value.status_code == 503


async def test_purge_drops_the_deleted_files_cached_frames():
    loader._CACHE.put(("sid-1", ""), pd.DataFrame({"a": [1]}))
    loader._CACHE.put(("sid-1", "Sheet2"), pd.DataFrame({"a": [2]}))
    loader._CACHE.put(("sid-2", ""), pd.DataFrame({"a": [3]}))
    state = SimpleNamespace(db=None)
    request = SimpleNamespace(app=SimpleNamespace(state=state))
    with pytest.raises(HTTPException):
        await files_router.purge("ing-1", request, storage="sid-1")
    assert loader._CACHE.get(("sid-1", "")) is None
    assert loader._CACHE.get(("sid-1", "Sheet2")) is None
    assert loader._CACHE.get(("sid-2", "")) is not None


def test_cached_frames_expire(monkeypatch):
    # A fake clock, not a sleep: Windows' monotonic clock ticks every ~15.6 ms,
    # so a 10 ms sleep could read the same instant twice and never "expire".
    now = [1_000.0]
    monkeypatch.setattr(loader.time, "monotonic", lambda: now[0])
    c = loader._DataframeCache(4, ttl_s=600.0)
    c.put(("s", ""), pd.DataFrame({"a": [1]}))
    now[0] += 599
    assert c.get(("s", "")) is not None
    now[0] += 2
    assert c.get(("s", "")) is None


# ================================================================ generated storage


async def test_a_low_disk_refuses_the_file_before_sending_it(monkeypatch):
    from app.clients import convex as cv

    s = make_settings("http://localhost:9999")
    object.__setattr__(s, "ai_min_free_disk_bytes", 10**18)
    if not hasattr(os, "statvfs"):
        pytest.skip("no statvfs on this platform (the dev box)")
    with pytest.raises(cv.StorageRefused):
        cv._assert_disk_room(s, 10)


async def test_the_generated_allowance_refusal_reaches_the_tool_in_words():
    import httpx

    from app.clients.convex import ConvexClient, StorageRefused

    def handler(request):
        return httpx.Response(
            507,
            json={"error": "GENERATED_FULL", "message": "Delete some generated files."},
        )

    s = make_settings("http://localhost:9999")
    object.__setattr__(s, "ai_min_free_disk_bytes", 0)
    client = ConvexClient(s, httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(StorageRefused, match="Delete some generated files"):
        await client.store_artifact(
            b"PDF", stream_id="s", filename="a.pdf", fmt="pdf", mime="application/pdf"
        )


# ================================================================ datasets + documents


def test_a_dataset_crosses_the_sandbox_as_plain_json_with_its_dtypes():
    csv = b"when,amount,count,ok,name\n2026-01-01,1.5,3,true,a\n2026-01-02,,4,false,\n"
    frame = sandbox_ops.dataset_frame(
        csv, name="s.csv", mime="text/csv", max_rows=100, sheet=None
    )
    json.dumps(frame)  # plain JSON, nothing else
    df = loader.frame_from_columns(frame)
    assert list(df.columns) == ["when", "amount", "count", "ok", "name"]
    assert str(df["count"].dtype) == "int64"
    assert str(df["amount"].dtype) == "float64" and pd.isna(df["amount"][1])
    assert str(df["ok"].dtype) == "bool"
    assert df["name"][1] is None


async def test_dataset_errors_stay_data_errors():
    from app.data.analysis import DataError

    with pytest.raises(DataError):
        await loader.parse_isolated(
            b"", "e.csv", "text/csv", max_rows=10, sheet=None, settings=SETTINGS
        )


def test_document_results_round_trip_the_sandbox_framing():
    cases = [
        b"%PDF-1.7 bytes",
        (b"PPTX", ["one warning"]),
        [(b"img1", "image/png"), (b"image-two", "image/jpeg")],
        {"pages": 3, "text": "hello"},
        [],
    ]
    for value in cases:
        meta, body = sandbox_ops.doc_encode(value)
        assert sandbox_ops.doc_decode(json.loads(json.dumps(meta)), body) == value


def test_only_allowlisted_document_operations_exist_in_the_child():
    with pytest.raises(sandbox_ops.DecodeError):
        sandbox_ops.doc_function("os.system")
    assert callable(sandbox_ops.doc_function("pdf.read"))


async def test_a_document_error_in_the_op_stays_a_document_error():
    with pytest.raises(DocumentError):
        await isolated.run_doc_call(
            "pdf.read", [b"not a pdf"], [None, None], timeout_s=20
        )


# ================================================================ minimum isolation


async def test_below_the_required_isolation_nothing_is_decoded(monkeypatch):
    monkeypatch.setattr(harness, "_TIER", 4)
    monkeypatch.setattr(harness, "_MIN_TIER", 1)
    ran = []

    async def fallback():
        ran.append(True)
        return {"ok": True}, b""

    with pytest.raises(RuntimeError, match="below the required isolation"):
        await harness.run_sandboxed("image", b"x", {}, timeout_s=1, fallback=fallback)
    assert ran == []
    assert harness.sandbox_status()["meets_minimum"] is False


def test_the_render_pool_refuses_to_start_below_the_minimum(monkeypatch):
    from app.ingest import pool

    monkeypatch.setattr(harness, "_TIER", 2)
    monkeypatch.setattr(harness, "_MIN_TIER", 1)
    with pytest.raises(RuntimeError):
        pool._sandboxed_executable()


def test_the_dev_box_pool_keeps_plain_children(monkeypatch):
    from app.ingest import pool

    monkeypatch.setattr(harness, "_TIER", 4)
    monkeypatch.setattr(harness, "_MIN_TIER", 4)
    assert pool._sandboxed_executable() is None


def test_sandbox_children_get_one_thread_each():
    env = harness.safe_child_env()
    assert env["OMP_NUM_THREADS"] == env["OPENBLAS_NUM_THREADS"] == "1"


if __name__ == "__main__":  # pragma: no cover
    asyncio.run(asyncio.sleep(0))
