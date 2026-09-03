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
from app.routers.schedule import (
    parse_candidates as _candidates,
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
    needs = _missing(ParsedSchedule(prompt="do a thing"))
    assert "kind" in needs
    # Short-circuit: with no kind there is nothing meaningful to say about the
    # kind-specific fields, so they must NOT be reported as missing too.
    assert not {"hour", "weekdays", "dayOfMonth", "runAt"} & set(needs)


def test_a_complete_daily_schedule_needs_nothing():
    assert (
        _missing(
            ParsedSchedule(
                kind="daily",
                title="Inbox Digest",
                prompt="summarise my inbox",
                hour=8,
                minute=0,
            )
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


# ── candidate selection: a list that can actually answer ────────────────────
#
# Measured on production 2026-09-03: the two configured candidates
# (deepseek-v4-pro, then glm-5.2) were BOTH refusing for weekly quota while
# deepseek-v4-flash answered — and it was in neither list. Every parse degraded
# to the raw-sentence form, which blocks Create and reads to the user as a
# broken button. Retrying could never have helped; the only model with capacity
# was not a candidate.




def test_the_quota_fallback_model_is_a_parser_candidate():
    """The chat plane's healthy alternate must be reachable here too, or the
    parser can be stranded while chat is fine."""
    from app.agent import health
    from app.config import Settings

    health.reset()
    s = Settings(
        ai_schedule_model="a",
        ai_schedule_model_fallback="b",
        ai_quota_fallback_model="c",
    )
    assert _candidates(s) == ["a", "b", "c"]


def test_a_model_known_to_be_refusing_is_skipped():
    from app.agent import health
    from app.config import Settings

    health.reset()
    health.mark_exhausted("a", ttl_s=600)
    s = Settings(
        ai_schedule_model="a",
        ai_schedule_model_fallback="b",
        ai_quota_fallback_model="c",
    )
    assert _candidates(s) == ["b", "c"]


def test_candidates_are_deduped_so_a_repeat_is_not_a_second_attempt():
    """The defaults resolve to the same id more often than they look like they
    do: `schedule_model` falls back to `ai_default_model`, which was the same
    value as the fallback — a box with no explicit parser model had no second
    attempt at all."""
    from app.agent import health
    from app.config import Settings

    health.reset()
    s = Settings(
        ai_schedule_model="same",
        ai_schedule_model_fallback="same",
        ai_quota_fallback_model="other",
    )
    assert _candidates(s) == ["same", "other"]


def test_the_default_fallback_differs_from_the_default_primary():
    """Guards the config itself: with no AI_SCHEDULE_MODEL set, `schedule_model`
    is `ai_default_model`, and if the fallback equals it there is no second try."""
    from app.config import Settings

    s = Settings()
    assert s.ai_schedule_model_fallback != s.ai_default_model


def test_everything_believed_dead_still_tries_them_all():
    """A stale belief must not turn a recovered provider into a permanent outage.

    Returning only the FIRST here was a real bug, reproduced on production: the
    primary is the model most likely to still be refusing, so trying it alone
    guaranteed the failure this whole function exists to prevent. When every
    belief says "dead" the beliefs are the least trustworthy thing available."""
    from app.agent import health
    from app.config import Settings

    health.reset()
    for m in ("a", "b", "c"):
        health.mark_exhausted(m, ttl_s=600)
    s = Settings(
        ai_schedule_model="a",
        ai_schedule_model_fallback="b",
        ai_quota_fallback_model="c",
    )
    assert _candidates(s) == ["a", "b", "c"]


# ── no application deadline ─────────────────────────────────────────────────


def test_the_parse_imposes_no_ollasuper_deadline():
    """20.0s sat INSIDE the latency distribution of a real parse: measured
    2026-09-03, a simple request parses in 5.3s but "Deep SEO audit of this
    website <url>" takes 15.8-37.7s, because the parser must WRITE the task's
    full instruction. Simple requests always fit, complex ones straddled the
    bound, and the scheduler appeared to work only for trivial tasks.

    What remains must be the PROVIDER CLIENT'S own default, not a number this
    product picked."""
    import openai

    from app.routers import schedule as mod

    assert not hasattr(mod, "PARSE_TIMEOUT_S"), "the app-chosen deadline is gone"
    assert mod.PARSE_TIMEOUT is openai.DEFAULT_TIMEOUT


def test_none_is_not_used_as_the_timeout():
    """`None` would be worse, not purer: langchain-openai overrides openai's
    constant, so None AND omitting it both yield client.timeout=None — no read
    timeout at any layer, letting a half-open socket hold a Convex action and the
    user's spinner until OS TCP keepalive."""
    from app.routers.schedule import PARSE_TIMEOUT

    assert PARSE_TIMEOUT is not None


def test_a_provider_timeout_is_not_treated_as_exhausted_capacity():
    """Deliberate asymmetry: a QUOTA refusal marks a model exhausted, a TIMEOUT
    does not — being slow is not evidence of having no capacity, and latching on
    it would strand a model that is merely busy."""
    from app.agent.llm import is_quota_error

    assert not is_quota_error(TimeoutError("timed out"))
    assert not is_quota_error(Exception("APITimeoutError: Request timed out."))
