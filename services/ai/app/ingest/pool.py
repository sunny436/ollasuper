"""Shared spawn process pool for native, crash-prone ingest work.

Two native libraries do the heavy lifting of ingest — libpdfium (page render,
via pypdfium2) and ONNX Runtime (local OCR, via RapidOCR). Both can SEGFAULT or
abort on an edge-case input: a native crash Python cannot catch. On the
`--workers 1` inference service that would take down the whole process and every
in-flight chat with it (measured in prod: `status=11/SEGV` in libpdfium tearing
down a page).

So all such work runs in this bounded PROCESS pool. A native crash kills only a
worker (surfaced as `BrokenProcessPool`), never the service; `run_in_pool`
recreates the pool and retries the call ONCE in a fresh worker before giving up.
`spawn` (not fork): forking a threaded async service risks deadlocks.

This lives in its OWN module — not `pdf.py` — so `ocr.py` can submit OCR to the
same pool without the import cycle `pdf -> ocr -> pdf`.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import multiprocessing
import threading
from collections.abc import Callable
from concurrent.futures.process import BrokenProcessPool
from typing import Any

from app.logging import get_logger

log = get_logger(__name__)

_pool: concurrent.futures.ProcessPoolExecutor | None = None
_lock = threading.Lock()


def get_pool(workers: int) -> concurrent.futures.ProcessPoolExecutor:
    """The singleton render+OCR pool, created on first use (double-checked)."""
    global _pool
    if _pool is None:
        with _lock:
            if _pool is None:
                _pool = concurrent.futures.ProcessPoolExecutor(
                    max_workers=max(1, workers),
                    mp_context=multiprocessing.get_context("spawn"),
                )
    return _pool


def shutdown_pool() -> None:
    """Tear the pool down (lifespan cleanup, or after a worker crash)."""
    global _pool
    pool, _pool = _pool, None
    if pool is not None:
        pool.shutdown(wait=False, cancel_futures=True)


async def run_in_pool[T](
    fn: Callable[..., T], *args: Any, workers: int, label: str = "task"
) -> T | None:
    """Run `fn(*args)` in the pool and await the result off the event loop.

    A worker segfault fails every in-flight future with `BrokenProcessPool`;
    the crash is often non-deterministic (memory corruption), so recreate the
    pool and retry ONCE in a fresh worker. Returns the result, or None if the
    retry also crashed or `fn` raised (ingest work is best-effort — one bad
    page/image is skipped, never fatal).
    """
    loop = asyncio.get_running_loop()
    for attempt in (1, 2):
        try:
            return await loop.run_in_executor(get_pool(workers), fn, *args)
        except BrokenProcessPool:
            log.warning(
                "pool_worker_crashed", extra={"label": label, "attempt": attempt}
            )
            shutdown_pool()
            if attempt == 2:
                return None
        except Exception:  # noqa: BLE001 - a task failure must never fail the file
            log.warning("pool_task_failed", extra={"label": label})
            return None
    return None
