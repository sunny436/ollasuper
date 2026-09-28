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
import os
import shlex
import sys
import tempfile
import threading
from collections.abc import Callable
from concurrent.futures.process import BrokenProcessPool
from typing import Any

from app.logging import get_logger

log = get_logger(__name__)

_pool: concurrent.futures.ProcessPoolExecutor | None = None
_lock = threading.Lock()
_wrapper: str | None = None

# The workers run UNTRUSTED renders (pypdfium2 on user PDFs, ONNX OCR). They
# used to be plain children of this service: its environment (every secret),
# its network, its filesystem. They now start inside the same sandbox as every
# other decoder (harness.isolation_prefix): namespaces, read-only root, masked
# secrets, a process cap and a stripped environment. They are long-lived (the
# ONNX model loads once per worker), so each is recycled after a bounded
# number of tasks and killed past a CPU budget.
POOL_TASKS_PER_CHILD = 50
POOL_CPU_S = 900


def _sandboxed_executable() -> str | None:
    """A tiny executable that starts the real interpreter inside the sandbox,
    for multiprocessing's `spawn` (set_executable). None where the host has no
    sandbox (the dev box), which keeps the old in-process-children behaviour
    there only; a deployment that requires isolation refuses instead."""
    global _wrapper
    from app.sandbox import harness

    status = harness.sandbox_status()
    if not status["meets_minimum"]:
        raise RuntimeError("the sandbox is below the required isolation")
    if not status["secret_free"]:
        return None
    if _wrapper is not None and os.path.exists(_wrapper):
        return _wrapper
    limits = []
    if harness.shutil.which("prlimit"):
        limits = [
            "prlimit",
            f"--cpu={POOL_CPU_S}",
            "--nofile=512",
            "--fsize=67108864",
            f"--nproc={harness.MAX_PROCS}",
            "--",
        ]
    env = harness.safe_child_env()
    # Workers use threads (ONNX intra-op), so no thread caps here.
    for k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        env.pop(k, None)
    env["TMPDIR"] = env["HOME"] = "/tmp"  # noqa: S108 — the private tmpfs
    argv = [
        *harness.isolation_prefix(limits),
        "env",
        "-i",
        *[f"{k}={v}" for k, v in sorted(env.items())],
        sys.executable,
    ]
    d = tempfile.mkdtemp(prefix="myos-pool-")
    os.chmod(d, 0o700)
    path = os.path.join(d, "python-sandboxed")
    with open(path, "w", encoding="utf-8") as fh:
        cmd = " ".join(shlex.quote(a) for a in argv)
        fh.write("#!/bin/sh\nexec " + cmd + ' "$@"\n')
    os.chmod(path, 0o700)
    _wrapper = path
    return path


def get_pool(workers: int) -> concurrent.futures.ProcessPoolExecutor:
    """The singleton render+OCR pool, created on first use (double-checked)."""
    global _pool
    if _pool is None:
        with _lock:
            if _pool is None:
                ctx = multiprocessing.get_context("spawn")
                exe = _sandboxed_executable()
                if exe is not None:
                    ctx.set_executable(exe)
                _pool = concurrent.futures.ProcessPoolExecutor(
                    max_workers=max(1, workers),
                    mp_context=ctx,
                    max_tasks_per_child=POOL_TASKS_PER_CHILD,
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
