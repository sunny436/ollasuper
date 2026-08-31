"""No `log.*(extra={...})` call may use a reserved LogRecord field name.

WHY THIS EXISTS. `logging` refuses to let `extra` shadow a LogRecord attribute
and raises KeyError instead of overwriting it. That makes such a call FATAL to
whatever it was logging — and it hides almost perfectly, because
`Logger.info(...)` checks the level before it builds a record. Below INFO the
call short-circuits and the bug is invisible; at INFO — which is production's
level — every hit raises.

That is exactly how `sched.materialised` shipped with `extra={"created": ...}`:
green in a test run that never enabled INFO logging, and an exception on every
materialising tick in production, which would have stopped the scheduler
producing any occurrence at all.

A static scan is the right shape here: it covers every call site including the
ones no test exercises, and it costs nothing.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

APP = pathlib.Path(__file__).resolve().parents[1] / "app"

# LogRecord's own attributes, plus the two `Formatter` adds later.
RESERVED = {
    "args",
    "asctime",
    "created",
    "exc_info",
    "exc_text",
    "filename",
    "funcName",
    "levelname",
    "levelno",
    "lineno",
    "message",
    "module",
    "msecs",
    "msg",
    "name",
    "pathname",
    "process",
    "processName",
    "relativeCreated",
    "stack_info",
    "taskName",
    "thread",
    "threadName",
}

LOG_METHODS = {"debug", "info", "warning", "error", "exception", "critical", "log"}


def _offences(path: pathlib.Path) -> list[tuple[int, str]]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except SyntaxError:  # pragma: no cover - a broken file fails elsewhere
        return []
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute) or func.attr not in LOG_METHODS:
            continue
        for kw in node.keywords:
            if kw.arg != "extra" or not isinstance(kw.value, ast.Dict):
                continue
            for key in kw.value.keys:
                if (
                    isinstance(key, ast.Constant)
                    and isinstance(key.value, str)
                    and key.value in RESERVED
                ):
                    found.append((node.lineno, key.value))
    return found


ALL_FILES = sorted(APP.rglob("*.py"))


def test_the_scan_actually_finds_files():
    """Guards against the scan silently covering nothing."""
    assert len(ALL_FILES) > 50


@pytest.mark.parametrize("path", ALL_FILES, ids=lambda p: str(p.name))
def test_no_reserved_logrecord_key_in_extra(path: pathlib.Path):
    offences = _offences(path)
    assert not offences, (
        f"{path}: extra={{...}} uses reserved LogRecord field(s) "
        + ", ".join(f"{name!r} at line {line}" for line, name in offences)
        + ". logging raises KeyError rather than overwriting these, which makes "
        "the call fatal at that log level."
    )


def test_the_detector_catches_a_planted_offence(tmp_path: pathlib.Path):
    """The scan must not be vacuous."""
    bad = tmp_path / "bad.py"
    bad.write_text('log.info("x", extra={"created": 1})\n', encoding="utf-8")
    assert _offences(bad) == [(1, "created")]


def test_a_safe_key_is_not_flagged(tmp_path: pathlib.Path):
    good = tmp_path / "good.py"
    good.write_text('log.info("x", extra={"occurrences": 1})\n', encoding="utf-8")
    assert _offences(good) == []
