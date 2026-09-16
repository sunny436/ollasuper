"""The `humanize_check` built-in: shape, dispatch, budget, and never raising.

The budget test is the one with production teeth: `ai_agent_tool_result_max_chars`
is 8,000 and the executor truncates above it, so a findings list that does not
fit comes back to the model cut in half with no marker — it would then "fix"
a subset it cannot see the end of and call the job done.
"""

from __future__ import annotations

import json

import pytest

from app.humanizer.tool import (
    HUMANIZE_CHECK_TOOL_NAME,
    HUMANIZE_CHECK_TOOL_SPEC,
    compute_humanize_check,
)

SLOP = (
    "In today's digital landscape, this is not just a tool but a testament to "
    "innovation. Additionally, the robust platform seamlessly unlocks "
    "comprehensive value. Experts argue it marks a pivotal moment.\n\n"
    "Let that sink in.\n\n"
    "I hope this helps! Let me know if you would like more.\n"
)
HUMAN = (
    "We moved the index to a new host over a weekend. Queries got faster for "
    "most teams and slower for one, which took another week to explain. The "
    "notes below cover what changed and what we would skip next time.\n"
)


# ------------------------------------------------------------------ the spec
def test_the_spec_is_a_well_formed_function_tool():
    fn = HUMANIZE_CHECK_TOOL_SPEC["function"]
    assert HUMANIZE_CHECK_TOOL_SPEC["type"] == "function"
    assert fn["name"] == HUMANIZE_CHECK_TOOL_NAME == "humanize_check"
    params = fn["parameters"]
    assert params["type"] == "object"
    assert params["required"] == ["mode"]
    assert params["properties"]["mode"]["enum"] == ["detect", "verify"]
    for key in ("text", "before", "after", "keywords", "sample", "register"):
        assert key in params["properties"], key


def test_the_description_tells_the_model_to_stay_silent():
    """The user asked for a pass the reader never sees; the tool description is
    read on every turn it is bound, so the rule lives there too."""
    text = HUMANIZE_CHECK_TOOL_SPEC["function"]["description"].lower()
    assert "never mention it" in text
    assert "never show its score" in text
    assert "ship_as_is" in text and "unchanged" in text


# ---------------------------------------------------------------- detect
def test_detect_scores_slop_low_and_names_the_patterns():
    r = compute_humanize_check({"mode": "detect", "text": SLOP})
    assert r["mode"] == "detect"
    assert r["verdict"] == "revise"
    assert r["human_voice_score"] < 85
    assert r["findings_total"] >= 5
    assert {"A1", "A4", "C12", "E22"} <= set(r["counts_by_pattern"])
    first = r["findings"][0]
    assert set(first) == {"id", "name", "category", "severity", "at", "text"}


def test_detect_ships_clean_prose_unchanged():
    """The conditional rule, computed: a rewrite is the only way to lose a
    fact, so text that is already human must not be rewritten at all."""
    r = compute_humanize_check({"mode": "detect", "text": HUMAN})
    assert r["verdict"] == "ship_as_is"
    assert r["human_voice_score"] >= 85


def test_the_threshold_is_caller_settable_and_clamped():
    strict = compute_humanize_check({"mode": "detect", "text": HUMAN, "threshold": 200})
    assert strict["threshold"] == 100  # clamped into range
    loose = compute_humanize_check({"mode": "detect", "text": SLOP, "threshold": -5})
    assert loose["threshold"] == 0 and loose["verdict"] == "ship_as_is"
    assert (
        compute_humanize_check({"mode": "detect", "text": SLOP, "threshold": 99})[
            "verdict"
        ]
        == "revise"
    )


def test_detect_reports_whether_a_voice_sample_was_used():
    plain = compute_humanize_check({"mode": "detect", "text": SLOP})
    with_sample = compute_humanize_check(
        {"mode": "detect", "text": SLOP, "sample": HUMAN}
    )
    assert plain["voice_sample_used"] is False
    assert with_sample["voice_sample_used"] is True


def test_the_technical_register_is_passed_through():
    r = compute_humanize_check(
        {"mode": "detect", "text": SLOP, "register": "technical"}
    )
    assert r["register"] == "technical"
    assert (
        compute_humanize_check({"mode": "detect", "text": SLOP})["register"] == "prose"
    )


# ---------------------------------------------------------------- verify
def test_verify_reports_a_faithful_rewrite():
    r = compute_humanize_check({"mode": "verify", "before": SLOP, "after": HUMAN})
    assert r["mode"] == "verify"
    assert r["score_after"] > r["score_before"]


def test_verify_names_a_lost_keyword():
    r = compute_humanize_check(
        {
            "mode": "verify",
            "before": SLOP + "The platform indexes documents.\n",
            "after": HUMAN,
            "keywords": ["platform"],
        }
    )
    assert r["ok"] is False
    assert "platform" in r["lost"]["keywords"]


def test_keywords_accept_a_comma_string_too():
    """Models pass a comma string as often as a list; refusing it would make
    the keyword check silently vacuous."""
    r = compute_humanize_check(
        {
            "mode": "verify",
            "before": SLOP + "The platform indexes documents.\n",
            "after": HUMAN,
            "keywords": "platform, indexes",
        }
    )
    assert "platform" in r["lost"]["keywords"]


# ------------------------------------------------------------------ budget
def test_the_detect_payload_fits_the_executor_result_cap():
    """`ai_agent_tool_result_max_chars` = 8,000, applied by the executor."""
    pathological = SLOP * 400  # thousands of findings
    r = compute_humanize_check({"mode": "detect", "text": pathological})
    serialized = json.dumps(r)
    assert len(serialized) < 8000, len(serialized)
    assert r["truncated"] is True
    # The COUNTS survive truncation, so the model still learns the real scale.
    assert r["findings_total"] > len(r["findings"])
    assert sum(r["counts_by_pattern"].values()) == r["findings_total"]


def test_an_oversized_input_is_refused_rather_than_chewed():
    r = compute_humanize_check({"mode": "detect", "text": "x" * 200_001})
    assert "error" in r


# ------------------------------------------------------------- never raises
@pytest.mark.parametrize(
    "args",
    [
        None,
        "not a dict",
        42,
        {},
        {"mode": "nope"},
        {"mode": "detect"},
        {"mode": "detect", "text": ""},
        {"mode": "detect", "text": 12},
        {"mode": "verify"},
        {"mode": "verify", "before": "x"},
        {"mode": "verify", "before": "x", "after": None},
        {"mode": "detect", "text": "hello", "keywords": {"bad": "shape"}},
        {"mode": "detect", "text": "hello", "threshold": "high"},
    ],
)
def test_a_bad_shape_is_an_error_not_an_exception(args):
    out = compute_humanize_check(args)
    assert isinstance(out, dict)
    assert "error" in out or "human_voice_score" in out


def test_it_is_pure_and_stateless():
    a = compute_humanize_check({"mode": "detect", "text": SLOP})
    b = compute_humanize_check({"mode": "detect", "text": SLOP})
    assert a == b
