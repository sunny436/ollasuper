"""Top-level helpers for the process-pool crash-isolation test.

They MUST be module-level (not closures) so a spawn ProcessPoolExecutor can
pickle them by reference and re-import them in a fresh worker process.
"""

from __future__ import annotations

import os


def suicide(_ignored: object) -> None:
    """Hard-kill the worker mid-task with no cleanup — stands in for a native
    SEGV in libpdfium/ONNX. The parent sees BrokenProcessPool, never dies."""
    os._exit(1)


def echo(value: int) -> int:
    return value
