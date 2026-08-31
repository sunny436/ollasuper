"""The scheduling parser: contract, hardening, and the structural guarantee.

The single most important assertion in this file is the AST one — that the
module imports no Convex client. "The parser cannot create a task" is then a
property of the code's shape rather than a rule someone has to remember.
"""

from __future__ import annotations

import ast
import pathlib

import pytest
from pydantic import ValidationError

from app.routers.schedule import (
    MAX_TEXT,
    MAX_TURNS,
    ParsedSchedule,
    ParseRequest,
    _extract_json,
    _missing,
    _sanitize,
)

pytestmark = pytest.mark.anyio

MODULE = pathlib.Path(__file__).resolve().parents[1] / "app" / "routers" / "schedule.py"


# ── the structural guarantee ────────────────────────────────────────────────


def test_the_parser_module_cannot_reach_convex():
    """It has no client, no ingress secret and no write path — by construction.

    Asserted over the import graph rather than by reading the code, so the
    guarantee survives someone adding a convenience import later.
    """
    tree = ast.parse(MODULE.read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
    assert not [m for m in imported if "convex" in m.lower()]
    # And nothing that could smuggle a write out another way.
    assert not [m for m in imported if m.split(".")[0] in {"httpx", "requests"}]


def test_the_parser_never_returns_a_created_task():
    """The response schema has no id field of any kind to return one in."""
    assert "id" not in ParsedSchedule.model_fields
    assert "taskId" not in ParsedSchedule.model_fields


# ── input bounds ────────────────────────────────────────────────────────────


def test_oversized_text_is_rejected_at_the_schema():
    with pytest.raises(ValidationError):
        ParseRequest(text="x" * (MAX_TEXT + 1))


def test_too_many_turns_are_rejected_at_the_schema():
    turns = [{"role": "user", "content": "hi"} for _ in range(MAX_TURNS + 1)]
    with pytest.raises(ValidationError):
        ParseRequest(text="hello", turns=turns)


def test_an_unknown_role_is_rejected():
    with pytest.raises(ValidationError):
        ParseRequest(text="hi", turns=[{"role": "system", "content": "x"}])


def test_extra_fields_are_forbidden():
    with pytest.raises(ValidationError):
        ParseRequest(text="hi", surprise="payload")


# ── reply handling: a model can say anything; only data survives ────────────


@pytest.mark.parametrize(
    "raw",
    [
        '{"kind":"daily","hour":9}',
        'Sure! ```json\n{"kind":"daily","hour":9}\n```',
        'Here you go:\n{"kind":"daily","hour":9}\nHope that helps',
    ],
)
def test_json_is_extracted_from_a_chatty_or_fenced_reply(raw: str):
    assert _extract_json(raw) == {"kind": "daily", "hour": 9}


@pytest.mark.parametrize(
    "raw",
    ["no json here", "", "[1,2,3]", "{oops", "```json\nnot json\n```"],
)
def test_a_reply_that_is_not_an_object_is_discarded(raw: str):
    assert _extract_json(raw) is None


def test_a_reply_that_fails_the_schema_is_discarded():
    # hour 99 is outside the validated range — the whole reply is dropped and
    # the UI falls back to the manual form rather than storing nonsense.
    with pytest.raises(ValidationError):
        ParsedSchedule.model_validate({"kind": "daily", "hour": 99})


# ── normalisation: nothing Phase 1 would reject can escape ──────────────────


def test_fields_belonging_to_another_kind_are_dropped():
    s = _sanitize(
        ParsedSchedule(
            kind="daily",
            hour=8,
            minute=0,
            weekdays=[0, 1],
            dayOfMonth=15,
            runAt=123,
            endsAt=456,
        ),
        "UTC",
    )
    # A daily schedule carries neither weekdays nor a day-of-month nor a runAt.
    assert s.weekdays == []
    assert s.dayOfMonth is None
    assert s.runAt is None
    assert s.endsAt == 456


def test_a_one_time_schedule_never_carries_recurrence_fields():
    s = _sanitize(
        ParsedSchedule(kind="once", runAt=999, hour=8, minute=30, endsAt=1),
        "UTC",
    )
    assert s.runAt == 999
    # `once` has exactly one instant, so an end date would be meaningless — and
    # Phase 1's validator does not accept one.
    assert s.endsAt is None
    assert s.hour is None
    assert s.minute is None


def test_weekdays_are_deduped_sorted_and_range_checked():
    s = _sanitize(
        ParsedSchedule(kind="weekly", weekdays=[4, 0, 4, 9, -1], hour=9, minute=0),
        "UTC",
    )
    assert s.weekdays == [0, 4]


def test_the_browser_zone_is_only_a_fallback():
    withTz = _sanitize(
        ParsedSchedule(kind="daily", hour=9, timezone="Asia/Kolkata"), "UTC"
    )
    assert withTz.timezone == "Asia/Kolkata"
    withoutTz = _sanitize(ParsedSchedule(kind="daily", hour=9), "Europe/London")
    assert withoutTz.timezone == "Europe/London"


# ── ambiguity: what the composer asks a follow-up question about ────────────


def test_a_missing_time_is_reported_rather_than_invented():
    needs = _missing(ParsedSchedule(kind="daily", prompt="summarise my inbox"))
    assert "hour" in needs


def test_a_missing_kind_short_circuits():
    assert _missing(ParsedSchedule(prompt="do a thing")) == ["kind"]


def test_a_complete_daily_schedule_needs_nothing():
    assert (
        _missing(
            ParsedSchedule(kind="daily", prompt="summarise my inbox", hour=8, minute=0)
        )
        == []
    )


def test_weekly_without_days_and_monthly_without_a_date_are_incomplete():
    assert "weekdays" in _missing(
        ParsedSchedule(kind="weekly", prompt="p", hour=8, minute=0)
    )
    assert "dayOfMonth" in _missing(
        ParsedSchedule(kind="monthly", prompt="p", hour=8, minute=0)
    )


def test_a_missing_instruction_is_reported():
    assert "prompt" in _missing(
        ParsedSchedule(kind="daily", prompt="   ", hour=8, minute=0)
    )
