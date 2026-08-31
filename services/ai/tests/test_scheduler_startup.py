"""Startup gates for the scheduler process.

The DBOS version gate exists because DBOS runs `run_migrations()` against its
system database on every launch: the INSTALLED version decides the schema of a
live production database. `uv sync --frozen` already guarantees the lock, so
these tests cover what the lock cannot — a drifted venv, and the pin drifting
away from the constant that documents it.
"""

from __future__ import annotations

import tomllib
from importlib.metadata import version as metadata_version
from pathlib import Path

import pytest

from app.scheduler.main import PINNED_DBOS, _assert_dbos_version

PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def _pyproject_dbos_specifier() -> str:
    data = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    deps = data["project"]["dependencies"]
    match = [d for d in deps if d.replace(" ", "").startswith("dbos")]
    assert len(match) == 1, f"expected exactly one dbos dependency, got {match}"
    return match[0].replace(" ", "")


# ── the two halves of the pin must move together ────────────────────────────


def test_pyproject_pins_dbos_exactly_not_by_range():
    """A range lets a routine `uv lock` refresh migrate a production database."""
    spec = _pyproject_dbos_specifier()
    assert spec.startswith("dbos=="), (
        f"dbos must be pinned exactly, found {spec!r}. DBOS migrates its system "
        "database at launch, so a range is a live-schema hazard."
    )


def test_the_pin_and_the_constant_agree():
    """PINNED_DBOS documents the rehearsed version; if it drifts from
    pyproject.toml the gate would either never fire or always fire."""
    assert _pyproject_dbos_specifier() == f"dbos=={PINNED_DBOS}"


def test_the_installed_version_matches_the_pin():
    """Catches a venv that was synced without --frozen."""
    assert metadata_version("dbos") == PINNED_DBOS


# ── the gate itself ─────────────────────────────────────────────────────────


def test_a_matching_version_starts_cleanly():
    _assert_dbos_version()  # must not raise


def test_a_drifted_version_refuses_to_start(monkeypatch):
    monkeypatch.setattr("app.scheduler.main.PINNED_DBOS", "9.9.9")
    monkeypatch.delenv("SCHEDULER_ALLOW_DBOS_VERSION_DRIFT", raising=False)
    with pytest.raises(RuntimeError) as e:
        _assert_dbos_version()
    msg = str(e.value)
    # The message has to tell an operator what to do, not just that it failed.
    assert "9.9.9" in msg
    assert "rehearse" in msg.lower()
    assert "SCHEDULER_ALLOW_DBOS_VERSION_DRIFT" in msg


def test_the_override_is_explicit_and_logs(monkeypatch, caplog):
    monkeypatch.setattr("app.scheduler.main.PINNED_DBOS", "9.9.9")
    monkeypatch.setenv("SCHEDULER_ALLOW_DBOS_VERSION_DRIFT", "1")
    _assert_dbos_version()  # must not raise
    assert any("dbos_version_drift" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("value", ["0", "true", "yes", ""])
def test_only_the_exact_override_value_is_honoured(monkeypatch, value):
    """A truthy-looking value must not silently disable the gate."""
    monkeypatch.setattr("app.scheduler.main.PINNED_DBOS", "9.9.9")
    monkeypatch.setenv("SCHEDULER_ALLOW_DBOS_VERSION_DRIFT", value)
    with pytest.raises(RuntimeError):
        _assert_dbos_version()
