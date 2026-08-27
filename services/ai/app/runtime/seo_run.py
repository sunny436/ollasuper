"""Phase 5 — the durable SEO-run WORKER (one bounded dispatch window).

Convex owns the state machine, the lease and the reaper; this is a STATELESS worker
that a single `/v1/seo-run-step` dispatch runs. It:

  1. restores the frontier + cursor from the run's bounded checkpoint (or discovers the
     frontier on the first dispatch),
  2. crawls one bounded WINDOW of URL batches, each batch → a gzipped-JSONL artifact
     (run-owned) + a lease-gated `seo-run-progress` snapshot (the aggregate recomputes
     from succeeded steps, so a re-crawled batch never double-counts),
  3. heartbeats DURING batches (lease-gated) so a legitimately-working window is never
     false-reaped,
  4. at the frontier's end builds the report via the turn-agnostic emitter (a
     deterministic `generated_at` ⇒ resume-idempotent) and FINALIZES; otherwise PARKS
     (retry_wait) and lets Convex re-dispatch — a `park` on a cancel-requested run
     finalizes cancelled.

The CRAWL itself (`crawler`/`discoverer`) is an injected seam: production wires the live
Ollagraph crawl (verified post-phase-7 on the deployed stack, where Ollagraph is
reachable), and the tests inject fakes to exercise the durability protocol hermetically.
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.clients.convex import ConvexClient, ConvexRejected, ConvexUnavailable
from app.config import Settings
from app.logging import get_logger
from app.runtime.writer import RunWriter
from app.seo.report import build_seo_report_emitter, report_id_for

log = get_logger(__name__)


@dataclass
class SeoRunStep:
    """The dispatch payload Convex sends to /v1/seo-run-step (claimForDispatch)."""

    runId: str
    leaseToken: str
    userId: str
    target: str
    scope: str
    maxUrls: int
    costBudget: float
    costSpent: float
    deadlineAt: int  # epoch ms (wall clock)
    workflowVersion: int
    createdAt: int  # epoch ms
    checkpoint: str | None = None
    summary: str | None = None


@dataclass
class BatchResult:
    """What a crawler returns for one batch of URLs."""

    rows: list[dict] = field(default_factory=list)  # per-URL evidence → JSONL artifact
    findings: list[dict] = field(default_factory=list)  # SEOFinding-shaped → the report
    counts: dict = field(default_factory=dict)  # findingsCounts for this batch
    cost: float = 0.0


# (target, scope, maxUrls) -> the bounded frontier of URLs to crawl.
Discoverer = Callable[[str, str, int], Awaitable[list[str]]]
# (urls, run) -> BatchResult.
Crawler = Callable[[list[str], SeoRunStep], Awaitable[BatchResult]]

MAX_SUMMARY_FINDINGS = 400  # bounds the accumulated findings the report is built from
_SEV_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}


def _hash(obj: object) -> str:
    return hashlib.sha1(  # noqa: S324 — non-crypto stable id
        json.dumps(obj, sort_keys=True, default=str).encode("utf-8", "replace")
    ).hexdigest()[:16]


def _finding_key(f: dict) -> str:
    key = f"{f.get('check_id', '')}|{f.get('url', '')}|{f.get('observation', '')}"
    return key[:400]


def _merge_affected(dst: dict, src: dict) -> dict:
    """`dst` (latest finding body) with `src`'s affected URLs folded in — so an
    identical finding seen on many pages ROLLS UP its affected set instead of the
    later page silently overwriting every earlier one (which under-reported a
    site-wide PASS/WARN as touching a single page). Order-stable + deduped, so a
    resume that re-crawls the same page is idempotent."""
    merged = dict(dst)
    seen = list(dst.get("affected") or [])
    for u in src.get("affected") or []:
        if u not in seen:
            seen.append(u)
    merged["affected"] = seen
    return merged


def _merge_findings(acc: list[dict], new: list[dict]) -> list[dict]:
    """Merge a batch's findings into the accumulated set, keyed by a stable id (so a
    re-crawled batch replaces rather than duplicates), bounded by count + severity.
    On a key collision the affected sets are UNIONED (see `_merge_affected`) so a
    check that holds across many pages keeps every affected URL, not just the last."""
    by_key: dict[str, dict] = {}
    for f in [*acc, *new]:
        k = _finding_key(f)
        prev = by_key.get(k)
        by_key[k] = _merge_affected(prev, f) if prev is not None else f
    merged = list(by_key.values())
    if len(merged) > MAX_SUMMARY_FINDINGS:
        merged.sort(key=lambda f: _SEV_ORDER.get(str(f.get("severity", "info")), 9))
        merged = merged[:MAX_SUMMARY_FINDINGS]
    return merged


def _summary_json(findings: list[dict]) -> str:
    return json.dumps({"findings": findings}, default=str)


def _checkpoint_json(frontier: list[str], cursor: int) -> str:
    return json.dumps(
        {"frontier": frontier, "cursor": cursor, "discovered": len(frontier)}
    )


def _gzip_jsonl(rows: list[dict]) -> bytes:
    text = "\n".join(json.dumps(r, default=str) for r in rows)
    return gzip.compress(text.encode("utf-8", "replace"))


def _deadline_mono(step: SeoRunStep, settings: Settings) -> float:
    """A monotonic window end = min(run deadline, now + per-dispatch window)."""
    remaining_wall = step.deadlineAt / 1000.0 - time.time()
    window = min(remaining_wall, settings.ai_seo_run_step_window_s)
    return time.monotonic() + max(0.0, window)


async def _store_batch(
    convex: ConvexClient,
    step: SeoRunStep,
    step_key: str,
    rows: list[dict],
    settings: Settings,
) -> list[str]:
    """Store a batch's rows as one or more gzipped-JSONL parts, each < the byte cap
    (byte-bounded, NOT URL-count-bounded), each an idempotent artifactKey. Returns the
    keys recorded on the step so a resume knows which parts already landed."""
    parts: list[list[dict]] = [rows] if rows else []
    keys: list[str] = []
    idx = 0
    queue = list(parts)
    while queue:
        chunk = queue.pop(0)
        blob = _gzip_jsonl(chunk)
        if len(blob) > settings.ai_seo_batch_max_bytes and len(chunk) > 1:
            mid = len(chunk) // 2
            queue.insert(0, chunk[mid:])
            queue.insert(0, chunk[:mid])
            continue
        key = f"{step.runId}:{step_key}:part:{idx}"
        sha = hashlib.sha256(blob).hexdigest()
        await convex.store_seo_artifact(
            blob,
            run_id=step.runId,
            lease_token=step.leaseToken,
            step_key=step_key,
            artifact_key=key,
            filename=f"{step_key.replace(':', '_')}_{idx}.jsonl.gz",
            fmt="jsonl.gz",
            mime="application/gzip",
            row_count=len(chunk),
            sha256=sha,
        )
        keys.append(key)
        idx += 1
    return keys


async def _heartbeat(
    convex: ConvexClient, step: SeoRunStep, settings: Settings, stop: dict
) -> None:
    """Beat the lease-gated heartbeat during batches. A stale/cancel response flips the
    shared stop flags so the batch loop unwinds promptly."""
    interval = max(1.0, settings.ai_seo_run_heartbeat_ms / 1000.0)
    while not stop.get("done"):
        await asyncio.sleep(interval)
        if stop.get("done"):
            return
        try:
            r = await convex.seo_run_heartbeat(
                run_id=step.runId, lease_token=step.leaseToken
            )
        except (ConvexUnavailable, ConvexRejected):
            continue
        if r.get("stale"):
            stop["stale"] = True
            return
        if r.get("cancel"):
            stop["cancel"] = True


def _report_dict(step: SeoRunStep, findings: list[dict]) -> dict:
    """Assemble the SEOReport-shaped dict the emitter wraps (site-scope crawl)."""
    return {
        "target": step.target,
        "coverage": ["crawl.run"],  # marks the envelope scope as `site`
        "checks_performed": findings,
        "missing_data": [],
        "evidence_freshness": "",
    }


async def _emit_report(
    convex: ConvexClient, settings: Settings, step: SeoRunStep, findings: list[dict]
) -> str:
    """Build + persist the run's report via the turn-agnostic emitter, RUN-owned.

    Returns the deterministic reportId. Best-effort — a report failure never corrupts
    the run."""
    report_id = report_id_for(step.runId, "", step.target)
    writer = RunWriter(
        convex, settings, run_id=step.runId, lease_token=step.leaseToken
    )
    emit = build_seo_report_emitter(writer, settings)
    generated_at = datetime.fromtimestamp(step.createdAt / 1000.0, UTC).isoformat()
    with suppress(Exception):
        await emit(
            "seo_audit",
            _report_dict(step, findings),
            {
                "stream_id": step.runId,
                "delegation_id": "",
                "generated_at": generated_at,
            },
        )
    return report_id


async def run_seo_step(
    step: SeoRunStep,
    *,
    convex: ConvexClient,
    settings: Settings,
    discoverer: Discoverer,
    crawler: Crawler,
) -> None:
    """Run ONE bounded dispatch window. Terminal decisions:
      - stale lease         → return (another worker owns the run)
      - frontier exhausted  → build report + finalize (succeeded/partial)
      - cancel OR window hit → park (park finalizes cancelled if cancel-requested, else
                               reschedules the next dispatch)
    """
    stop: dict = {"cancel": False, "stale": False, "done": False}
    window_end = _deadline_mono(step, settings)

    ckpt = {}
    if step.checkpoint:
        with suppress(json.JSONDecodeError, TypeError):
            ckpt = json.loads(step.checkpoint)
    frontier: list[str] | None = ckpt.get("frontier")
    cursor = int(ckpt.get("cursor") or 0)
    findings: list[dict] = []
    if step.summary:
        with suppress(json.JSONDecodeError, TypeError):
            findings = list(json.loads(step.summary).get("findings") or [])

    hb = asyncio.create_task(_heartbeat(convex, step, settings, stop))
    try:
        # First dispatch: discover the bounded frontier and checkpoint it.
        if frontier is None:
            discovered = await discoverer(step.target, step.scope, step.maxUrls)
            frontier = [str(u) for u in discovered][: step.maxUrls]
            cursor = 0
            r = await convex.seo_run_progress(
                run_id=step.runId,
                lease_token=step.leaseToken,
                step_key="discover",
                input_hash=_hash(frontier),
                processed_count=0,
                cost=0,
                checkpoint=_checkpoint_json(frontier, cursor),
                summary=_summary_json(findings),
            )
            if r.get("stale"):
                return
            if r.get("cancel"):
                stop["cancel"] = True

        # Crawl batches until the window ends, a stale/cancel arrives, or we finish.
        # `cursor` advances only AFTER a batch's progress lands, so a resume never
        # re-crawls a succeeded batch (coarse resume via the checkpoint cursor).
        while (
            frontier
            and cursor < len(frontier)
            and not stop["cancel"]
            and not stop["stale"]
        ):
            if time.monotonic() >= window_end:
                break  # window hit → park below
            batch = frontier[cursor : cursor + settings.ai_seo_batch_urls]
            step_key = f"batch:{cursor}"
            result = await crawler(batch, step)
            artifact_keys = await _store_batch(
                convex, step, step_key, result.rows, settings
            )
            findings = _merge_findings(findings, result.findings)
            r = await convex.seo_run_progress(
                run_id=step.runId,
                lease_token=step.leaseToken,
                step_key=step_key,
                input_hash=_hash(batch),
                processed_count=len(batch),
                cost=result.cost or float(len(batch)),
                findings_counts=result.counts or None,
                artifact_keys=artifact_keys or None,
                checkpoint=_checkpoint_json(frontier, cursor + len(batch)),
                summary=_summary_json(findings),
            )
            if r.get("stale"):
                stop["stale"] = True
                break
            cursor += len(batch)
            if r.get("cancel"):
                stop["cancel"] = True
                break

        if stop["stale"]:
            return

        # Frontier exhausted (and not cancelled) → build the report + finalize.
        if not stop["cancel"] and frontier is not None and cursor >= len(frontier):
            report_id = await _emit_report(convex, settings, step, findings)
            await convex.seo_run_finalize(
                run_id=step.runId,
                lease_token=step.leaseToken,
                status="succeeded",
                report_id=report_id,
                summary=_summary_json(findings),
            )
            return

        # Cancel OR window-hit-with-more-work → park. park finalizes `cancelled` when
        # the run is cancel-requested, otherwise reschedules the next dispatch.
        await convex.seo_run_park(
            run_id=step.runId,
            lease_token=step.leaseToken,
            checkpoint=_checkpoint_json(frontier or [], cursor),
            summary=_summary_json(findings),
        )
    except (ConvexUnavailable, ConvexRejected) as e:
        # A transient Convex/writeback failure: do NOT finalize (the reaper
        # re-dispatches from the last landed checkpoint). Just unwind.
        log.warning("seo_run.writeback_failed", extra={"error": type(e).__name__})
    finally:
        stop["done"] = True
        hb.cancel()
        with suppress(asyncio.CancelledError):
            await hb
