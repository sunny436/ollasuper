"""Phase 5 — durable SEO run WORKER + endpoint + report-determinism tests.

Exercises the durability protocol hermetically (no live crawl): the crawler/discoverer
are injected fakes, and Convex is the real FakeConvexServer over a loopback socket, so
the worker's real ConvexClient writebacks (progress/park/finalize/report/artifact) are
asserted end to end.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import time

import httpx
import pytest
from httpx import ASGITransport

from app.clients.convex import ConvexClient
from app.main import create_app
from app.runtime.registry import Registry
from app.runtime.seo_run import (
    BatchResult,
    SeoRunStep,
    _gzip_jsonl,
    _merge_findings,
    run_seo_step,
)
from app.runtime.writer import DeltaWriter
from app.seo.report import build_envelope, render_json
from tests.conftest import make_settings

SERVICE_KEY = "test-service-key-aaaaaaaaaaaaaaaaaaaa"
NOW_MS = 1_760_000_000_000  # a fixed epoch ms (Date.now is unavailable in workflows)


@pytest.fixture
async def run_client(fake_convex):
    """A factory for (ConvexClient, Settings) talking to the fake, with SEO on."""
    opened: list[httpx.AsyncClient] = []

    def _make(**over):
        settings = make_settings(
            fake_convex.url,
            ai_seo_runs_enabled=True,
            ai_seo_batch_urls=2,
            **over,
        )
        http = ConvexClient.build_http_client()
        opened.append(http)
        return ConvexClient(settings, http), settings

    yield _make, fake_convex
    for h in opened:
        await h.aclose()


def _step(**over) -> SeoRunStep:
    base = dict(
        runId="r1",
        leaseToken="L",
        userId="u1",
        target="https://x.com",
        scope="site",
        maxUrls=100,
        costBudget=100,
        costSpent=0,
        deadlineAt=int(time.time() * 1000) + 3_600_000,
        workflowVersion=1,
        createdAt=NOW_MS,
    )
    base.update(over)
    return SeoRunStep(**base)


def _discoverer(urls):
    async def d(target, scope, max_urls):
        return list(urls)

    return d


def _crawler(record=None):
    async def c(batch, step):
        if record is not None:
            record.append(list(batch))
        return BatchResult(
            rows=[{"url": u} for u in batch],
            findings=[
                {
                    "check_id": "onpage.title",
                    "url": u,
                    "observation": f"obs {u}",
                    "severity": "low",
                    "status": "WARN",
                }
                for u in batch
            ],
            counts={
                "totalFindings": len(batch),
                "passed": 0,
                "failed": 0,
                "warnings": len(batch),
                "notTested": 0,
            },
            cost=float(len(batch)),
        )

    return c


# ── Worker protocol ────────────────────────────────────────────────────────────


async def test_happy_path_discovers_crawls_and_finalizes(run_client):
    make, state = run_client
    convex, settings = make()
    await run_seo_step(
        _step(),
        convex=convex,
        settings=settings,
        discoverer=_discoverer(["https://x.com/a", "https://x.com/b"]),
        crawler=_crawler(),
    )
    # One discover progress + one batch progress, a batch artifact, a report row,
    # and a succeeded finalize carrying the reportId.
    assert any(p["stepKey"] == "discover" for p in state.seo_progress)
    assert any(p["stepKey"].startswith("batch:") for p in state.seo_progress)
    assert any(a["runId"] == "r1" for a in state.seo_artifacts)
    assert "r1" in state.seo_reports
    fin = state.seo_finalized["r1"]
    assert fin["status"] == "succeeded"
    assert fin.get("reportId")


async def test_cancel_rides_the_response_and_stops_within_one_batch(run_client):
    make, state = run_client
    state.seo_cancel.add("r1")  # every write returns {cancel: true}
    convex, settings = make()
    crawled: list[list[str]] = []
    await run_seo_step(
        _step(),
        convex=convex,
        settings=settings,
        discoverer=_discoverer(["a", "b", "c", "d"]),  # 2 batches of 2
        crawler=_crawler(crawled),
    )
    assert len(crawled) <= 1  # stopped promptly on the cancel (never all 2 batches)
    assert state.seo_parks  # parked (park finalizes cancelled in Convex)
    assert "r1" not in state.seo_finalized  # the worker did not finalize succeeded


async def test_stale_lease_aborts_without_finalizing(run_client):
    make, state = run_client
    state.seo_stale.add("r1")  # every write returns {stale: true}
    convex, settings = make()
    crawled: list[list[str]] = []
    await run_seo_step(
        _step(),
        convex=convex,
        settings=settings,
        discoverer=_discoverer(["a", "b"]),
        crawler=_crawler(crawled),
    )
    # The discover progress came back stale → the worker returned at once.
    assert crawled == []
    assert "r1" not in state.seo_finalized
    assert not state.seo_parks


async def test_window_hit_parks_instead_of_finalizing(run_client):
    make, state = run_client
    convex, settings = make(ai_seo_run_step_window_s=0.0)  # window already elapsed
    await run_seo_step(
        _step(),
        convex=convex,
        settings=settings,
        discoverer=_discoverer(["a", "b", "c", "d"]),
        crawler=_crawler(),
    )
    assert state.seo_parks  # more work remained → parked (retry_wait)
    assert "r1" not in state.seo_finalized


async def test_coarse_resume_skips_already_succeeded_batches(run_client):
    make, state = run_client
    convex, settings = make()
    crawled: list[list[str]] = []
    # A checkpoint whose cursor is PAST the first batch — resume must not re-crawl it.
    ckpt = json.dumps({"frontier": ["a", "b", "c", "d"], "cursor": 2})
    await run_seo_step(
        _step(checkpoint=ckpt),
        convex=convex,
        settings=settings,
        discoverer=_discoverer(["SHOULD", "NOT", "BE", "USED"]),  # frontier from ckpt
        crawler=_crawler(crawled),
    )
    assert crawled == [["c", "d"]]  # only the un-processed tail, never [a, b]
    assert state.seo_finalized["r1"]["status"] == "succeeded"


async def test_artifact_is_byte_bounded_into_parts(run_client):
    make, state = run_client
    # A tiny byte cap forces a 2-URL batch to split into two single-row parts.
    convex, settings = make(ai_seo_batch_max_bytes=10)
    await run_seo_step(
        _step(),
        convex=convex,
        settings=settings,
        discoverer=_discoverer(["a", "b"]),
        crawler=_crawler(),
    )
    batch_parts = [
        a for a in state.seo_artifacts if ":batch:0:part:" in a["artifactKey"]
    ]
    assert len(batch_parts) == 2  # split, each a distinct idempotent key
    assert {a["artifactKey"] for a in batch_parts} == {
        "r1:batch:0:part:0",
        "r1:batch:0:part:1",
    }


def test_gzip_jsonl_round_trips():
    rows = [{"url": "a", "n": 1}, {"url": "b", "n": 2}]
    blob = _gzip_jsonl(rows)
    lines = gzip.decompress(blob).decode().splitlines()
    assert [json.loads(x) for x in lines] == rows


# ── Endpoint: 202 + duplicate-worker 409 + 503 + release ────────────────────────


def _step_body(**over) -> dict:
    body = dict(
        runId="run_ep",
        leaseToken="L",
        userId="u1",
        target="https://x.com",
        scope="site",
        maxUrls=50,
        costBudget=50,
        costSpent=0,
        deadlineAt=int(time.time() * 1000) + 3_600_000,
        workflowVersion=1,
        createdAt=NOW_MS,
    )
    body.update(over)
    return body


@pytest.fixture
async def seo_app(fake_convex):
    settings = make_settings(fake_convex.url, ai_seo_runs_enabled=True)
    app = create_app()
    http = ConvexClient.build_http_client()
    app.state.settings = settings
    app.state.http = http
    app.state.convex = ConvexClient(settings, http)
    app.state.seo_registry = Registry(max_per_user=2, max_global=4)
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c, app, fake_convex
    # Cancel any in-flight background worker BEFORE closing http, so a heartbeat can't
    # fire against a closed client (mirrors the lifespan shutdown).
    if app.state.seo_registry is not None:
        await app.state.seo_registry.shutdown()
    await http.aclose()


async def test_seo_run_step_requires_the_service_key(seo_app):
    c, _, _ = seo_app
    r = await c.post("/v1/seo-run-step", json=_step_body())
    assert r.status_code == 401


async def test_seo_run_step_accepts_202(seo_app):
    c, app, _ = seo_app
    r = await c.post(
        "/v1/seo-run-step", json=_step_body(), headers={"x-service-key": SERVICE_KEY}
    )
    assert r.status_code == 202
    assert r.json()["runId"] == "run_ep"


async def test_duplicate_worker_is_a_409(seo_app):
    # The in-process dedupe (P0-2): a false reap's re-dispatch while the run is still
    # held gets a Conflict → 409 (Convex treats it as benign).
    c, app, _ = seo_app
    # Simulate a live worker already holding this runId (acquire + attach a task).
    app.state.seo_registry.acquire("run_ep", "u1")
    dummy = asyncio.create_task(asyncio.sleep(10))
    app.state.seo_registry.attach("run_ep", dummy)
    try:
        r = await c.post(
            "/v1/seo-run-step",
            json=_step_body(),
            headers={"x-service-key": SERVICE_KEY},
        )
        assert r.status_code == 409
    finally:
        dummy.cancel()


async def test_503_when_the_flag_is_off(seo_app):
    c, app, _ = seo_app
    app.state.seo_registry = None  # flag off → dormant pool
    r = await c.post(
        "/v1/seo-run-step", json=_step_body(), headers={"x-service-key": SERVICE_KEY}
    )
    assert r.status_code == 503


async def test_worker_releases_the_slot_after_finishing(seo_app):
    # The unwired backend discovers no URLs → the run finalizes empty, and the outer
    # `finally` releases the registry slot on every path.
    c, app, state = seo_app
    await c.post(
        "/v1/seo-run-step", json=_step_body(), headers={"x-service-key": SERVICE_KEY}
    )
    for _ in range(50):
        if not app.state.seo_registry.has("run_ep"):
            break
        await asyncio.sleep(0.02)
    assert not app.state.seo_registry.has("run_ep")  # released
    assert state.seo_finalized.get("run_ep", {}).get("status") == "succeeded"


# ── Report determinism (the resume-idempotency fixes) ───────────────────────────

FIXED_AT = "2026-01-01T00:00:00+00:00"


def _rd(findings: list[dict]) -> dict:
    return {
        "target": "https://x.com",
        "coverage": ["crawl.run"],
        "checks_performed": findings,
    }


def test_generated_at_is_deterministic_when_supplied():
    rd = _rd(
        [{"check_id": "a", "status": "WARN", "severity": "medium", "observation": "o"}]
    )
    a = render_json(
        build_envelope(rd, stream_id="r1", delegation_id="", generated_at=FIXED_AT)
    )
    b = render_json(
        build_envelope(rd, stream_id="r1", delegation_id="", generated_at=FIXED_AT)
    )
    assert a == b  # byte-identical re-emit (no fresh timestamp)
    assert FIXED_AT.encode() in a


def _f(check_id, obs, affected, status="PASS", sev="info"):
    return {"check_id": check_id, "observation": obs, "severity": sev,
            "status": status, "affected": affected}


def test_merge_unions_affected_for_a_site_wide_finding():
    # The SAME finding seen on many pages (identical check_id + observation, as a
    # generic PASS like "Indexable") must ROLL UP its affected pages — not report
    # only the last page, which under-counted a site-wide result to a single URL.
    acc = _merge_findings(
        [],
        [
            _f("crawl_index.noindex_mechanism", "Indexable (no noindex).", ["/a"]),
            _f("crawl_index.noindex_mechanism", "Indexable (no noindex).", ["/b"]),
            _f("crawl_index.noindex_mechanism", "Indexable (no noindex).", ["/c"]),
        ],
    )
    assert len(acc) == 1
    assert acc[0]["affected"] == ["/a", "/b", "/c"]  # every page, in crawl order


def test_merge_keeps_distinct_observations_separate():
    # Findings whose observation embeds a per-page value stay separate rows.
    acc = _merge_findings(
        [],
        [
            _f("crawl_index.canonical_consistency", "Canonical: /a.", ["/a"]),
            _f("crawl_index.canonical_consistency", "Canonical: /b.", ["/b"]),
        ],
    )
    assert len(acc) == 2


def test_merge_resume_re_crawl_is_idempotent_not_duplicated():
    # A resume that re-crawls an already-accumulated page must not duplicate its
    # affected URL (the merge key + affected union are both stable).
    first = _merge_findings(
        [],
        [_f("onpage.h1", "Single H1.", ["/a"]), _f("onpage.h1", "Single H1.", ["/b"])],
    )
    again = _merge_findings(first, [_f("onpage.h1", "Single H1.", ["/a"])])
    assert len(again) == 1
    assert again[0]["affected"] == ["/a", "/b"]  # /a not appended twice


def test_findings_render_in_a_total_order_regardless_of_input_order():
    f1 = {"check_id": "a.c", "status": "WARN", "severity": "medium", "observation": "a"}
    f2 = {"check_id": "b.c", "status": "WARN", "severity": "medium", "observation": "b"}
    j1 = render_json(
        build_envelope(
            _rd([f1, f2]), stream_id="r1", delegation_id="", generated_at=FIXED_AT
        )
    )
    j2 = render_json(
        build_envelope(
            _rd([f2, f1]), stream_id="r1", delegation_id="", generated_at=FIXED_AT
        )
    )
    assert j1 == j2  # total-order sort ⇒ same bytes despite reversed input


# ── Writer enqueue seam ─────────────────────────────────────────────────────────


async def test_writer_enqueue_seo_run_posts_the_op(run_client):
    make, state = run_client
    convex, settings = make()
    writer = DeltaWriter(convex, "stream_123", settings)
    res = await writer.enqueue_seo_run(
        target="https://x.com", scope="site", input_hash="ih1"
    )
    assert res.get("ok") is True
    assert res.get("runId")
    assert state.seo_enqueued and state.seo_enqueued[0]["streamId"] == "stream_123"
    assert state.seo_enqueued[0]["inputHash"] == "ih1"
