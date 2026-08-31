"""Intent extraction: the parser must never let a GUESS look like an ANSWER.

A live defect produced a task called "create a scheduler for ai news summary on
every sunday at 8" whose instruction was that same sentence, scheduled on
Monday. Nothing here was a weekday-mapping bug — `0=Monday` is consistent at
every layer. The parser reported the gaps correctly and the composer filled
them in with fabrications.

These tests cover the parser half of the fix: gaps stay gaps, near-misses in the
model's output are recovered rather than discarded, and a guess is detectable
without asking a second model.
"""

from __future__ import annotations

from app.routers.schedule import (
    _QUESTIONS,
    MAX_OUTPUT_TOKENS,
    ParsedSchedule,
    ParseResponse,
    _ambiguous,
    _bare_hour,
    _coerce_weekdays,
    _missing,
    _same_text,
    _sanitize,
)

# ── weekday names: a near-miss must not discard the whole parse ─────────────

DAYS = [
    ("monday", 0),
    ("tuesday", 1),
    ("wednesday", 2),
    ("thursday", 3),
    ("friday", 4),
    ("saturday", 5),
    ("sunday", 6),
]


def test_every_weekday_name_maps_to_the_phase_1_index():
    for name, index in DAYS:
        assert _coerce_weekdays({"weekdays": [name]})["weekdays"] == [index]
        assert _coerce_weekdays({"weekdays": [name[:3]]})["weekdays"] == [index]
        assert _coerce_weekdays({"weekdays": [name.title()]})["weekdays"] == [index]


def test_sunday_survives_end_to_end_as_sunday():
    """The reported bug, at the layer that used to lose it.

    `weekdays: list[int]` made `["sunday"]` a ValidationError, which discarded
    the kind, hour and title the model got right along with it.
    """
    data = _coerce_weekdays(
        {"kind": "weekly", "weekdays": ["sunday"], "hour": 8, "minute": 0}
    )
    s = _sanitize(ParsedSchedule.model_validate(data), "Asia/Kolkata")
    assert s.weekdays == [6]  # 6 = Sunday, never 0 = Monday
    assert s.hour == 8


def test_mixed_names_and_indices_are_both_accepted():
    out = _coerce_weekdays({"weekdays": ["mon", 4, "Sun"]})["weekdays"]
    assert sorted(out) == [0, 4, 6]


def test_a_boolean_is_not_a_weekday():
    # bool is an int subclass in Python: True would silently become Tuesday.
    assert _coerce_weekdays({"weekdays": [True, False, "sat"]})["weekdays"] == [5]


def test_unrecognised_entries_are_dropped_not_guessed():
    assert _coerce_weekdays({"weekdays": ["someday", None, {}]})["weekdays"] == []


def test_a_non_list_weekdays_field_is_left_alone():
    assert _coerce_weekdays({"weekdays": "sunday"})["weekdays"] == "sunday"


# ── ambiguity: FILLED is not the same as DETERMINED ────────────────────────


def test_a_bare_hour_is_ambiguous():
    """"Sunday at 8" — the model picks 8 and nothing used to flag it."""
    assert _bare_hour("create a summary every sunday at 8")


def test_a_meridiem_settles_it():
    for text in ("every sunday at 8 am", "every sunday at 8pm", "at 8 P.M."):
        assert not _bare_hour(text)


def test_a_clock_time_is_not_a_bare_hour():
    for text in ("at 8:30 every day", "at 08:00", "at 8.30"):
        assert not _bare_hour(text)


def test_a_24_hour_value_is_already_unambiguous():
    for text in ("at 20:00", "at 20", "at 13 every friday"):
        assert not _bare_hour(text)


def test_words_around_the_hour_settle_it():
    assert not _bare_hour("every sunday morning at 8")
    assert not _bare_hour("at 8 in the evening")


def test_an_invented_hour_is_flagged_when_no_time_was_given():
    # "Schedule an AI news task." names no time at all, so an hour coming back
    # was invented. The user must be asked, not silently given 9am.
    s = ParsedSchedule(kind="daily", title="T", prompt="p", hour=9, minute=0)
    assert "hour" in _ambiguous(s, "schedule an ai news task", has_draft=False)


def test_a_carried_hour_is_not_treated_as_invented():
    """A follow-up turn edits a draft; its hour was answered earlier, not guessed."""
    s = ParsedSchedule(kind="daily", title="T", prompt="p", hour=9, minute=0)
    assert _ambiguous(s, "also add wednesday", has_draft=True) == []


def test_a_stated_time_is_never_flagged():
    s = ParsedSchedule(kind="weekly", title="T", prompt="p", hour=8, weekdays=[6])
    assert _ambiguous(s, "every sunday at 8 am", has_draft=False) == []


def test_a_one_time_task_has_no_hour_to_be_ambiguous_about():
    s = ParsedSchedule(kind="once", title="T", prompt="p", runAt=123)
    assert _ambiguous(s, "at 8", has_draft=False) == []


# ── the meta-sentence guard: bug #2 and bug #4 ─────────────────────────────


def test_a_prompt_echoing_the_request_is_not_an_instruction():
    """This is what made a run answer "I can't create scheduled automations".

    The scheduling sentence was stored as the task's prompt, so the executor
    asked the assistant to create a scheduler — and it truthfully said it could
    not.
    """
    msg = "create a scheduler for ai news summary on every sunday at 8 am"
    assert _same_text(msg, msg)
    assert _same_text(
        "  Create A Scheduler For AI News Summary On Every Sunday At 8 AM. ", msg
    )


def test_a_real_instruction_extracted_from_the_request_is_kept():
    """Equality, never substring — over-normalisation is its own bug."""
    msg = (
        "Every Sunday at 8 AM, summarize the AI news from the previous seven days."
    )
    prompt = "Summarize the AI news from the previous seven days."
    assert not _same_text(prompt, msg)


def test_a_detailed_instruction_is_never_mistaken_for_the_request():
    msg = "create a scheduler for ai news summary on every sunday at 8 am"
    prompt = (
        "Summarise the most important artificial-intelligence news from the past "
        "week. Group related stories under short headings and include a source "
        "link for every item."
    )
    assert not _same_text(prompt, msg)


# ── a gap always has something to ask ──────────────────────────────────────


def test_a_missing_title_is_reported():
    needs = _missing(ParsedSchedule(kind="daily", prompt="p", hour=8, minute=0))
    assert "title" in needs


def test_every_field_the_parser_can_report_has_a_question():
    """Otherwise Create blocks with no reason the user can act on."""
    reportable = set()
    for s in (
        ParsedSchedule(),
        ParsedSchedule(kind="daily"),
        ParsedSchedule(kind="weekly"),
        ParsedSchedule(kind="monthly"),
        ParsedSchedule(kind="once"),
    ):
        reportable.update(_missing(s))
    reportable.update(
        _ambiguous(
            ParsedSchedule(kind="daily", title="T", prompt="p", hour=9),
            "no time here",
            has_draft=False,
        )
    )
    assert reportable <= set(_QUESTIONS), reportable - set(_QUESTIONS)


def test_the_response_can_distinguish_ambiguous_from_absent():
    r = ParseResponse(ok=True, needs=["hour"], ambiguous=["hour"])
    assert r.ambiguous == ["hour"]
    # Absent-only is the default, so an old-shaped response still validates.
    assert ParseResponse(ok=True, needs=["weekdays"]).ambiguous == []


# ── the output ceiling that used to truncate rich instructions ─────────────


def test_the_output_ceiling_can_hold_a_real_instruction():
    """400 tokens truncated the detailed prompts this parser exists to write.

    A truncated reply is unterminated JSON, which failed all the way back to
    "use the raw sentence" — the exact reported bug.
    """
    assert MAX_OUTPUT_TOKENS >= 1_000
