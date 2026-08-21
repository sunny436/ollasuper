"""Process-pool crash isolation — the unit-level proof of the crash-safety design.

In prod both libpdfium (render) and ONNX Runtime (RapidOCR) run in this pool. A
native SEGV/abort in either would, if run in the main process, core-dump the
whole --workers 1 service and every in-flight chat (measured in prod before the
fix). This test forces a worker to die mid-task and asserts the parent survives,
`run_in_pool` returns None (best-effort skip), and the pool recovers for the next
task in a fresh worker.
"""

from __future__ import annotations

import os

from app.ingest import pool as poolmod
from tests.fakes.pool_helpers import echo, suicide


async def test_pool_survives_worker_crash_and_recovers():
    poolmod.shutdown_pool()  # clean slate — ignore any pool from a prior test
    parent_pid = os.getpid()
    try:
        # Worker hard-exits mid-task -> BrokenProcessPool -> retried once in a
        # fresh worker (which also dies) -> None. The parent is untouched.
        res = await poolmod.run_in_pool(suicide, b"x", workers=1, label="crash")
        assert res is None
        assert os.getpid() == parent_pid  # same process — service did NOT die

        # The pool recovered transparently: a normal task now succeeds.
        ok = await poolmod.run_in_pool(echo, 42, workers=1, label="ok")
        assert ok == 42
    finally:
        poolmod.shutdown_pool()
