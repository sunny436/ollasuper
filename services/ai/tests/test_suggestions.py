"""Composer follow-up chips.

The relevance decision belongs to the model and is exercised against the live
one by e2e/qa-suggestions-quality.js. What is covered HERE is everything that
must hold no matter what the model returns: that a non-JSON reply is still
recovered, that a bad one yields nothing rather than garbage, that a finished
turn is never failed by this code, and — the subtle one — that an EMPTY result
is still written, because that is what clears the previous turn's chips.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.models.chat import HistoryMessage
from app.runtime import suggestions as sug
from tests.conftest import make_settings


class _FakeLLM:
    def __init__(self, *, content: str = "", exc: Exception | None = None) -> None:
        self._content = content
        self._exc = exc

    async def ainvoke(self, _messages: Any) -> Any:
        if self._exc:
            raise self._exc
        return type("Msg", (), {"content": self._content})()


class _RecordingConvex:
    def __init__(self) -> None:
        self.posted: list[dict] = []

    async def ingress(self, body: dict) -> dict:
        self.posted.append(body)
        return {"ok": True}


def _settings(**overrides):
    return make_settings("http://127.0.0.1:1", **overrides)


# --- parsing -------------------------------------------------------------
# Every string below is a reply shape actually observed from the live model.


def test_strict_json_is_parsed() -> None:
    assert sug._parse('["Add JSON-LD tags","Tag this release"]') == [
        "Add JSON-LD tags",
        "Tag this release",
    ]


def test_an_unquoted_array_is_recovered() -> None:
    """The exact failure that made strict json.loads insufficient."""
    assert sug._parse("[Analyze content gaps, Add schema markup]") == [
        "Analyze content gaps",
        "Add schema markup",
    ]


def test_a_dash_list_is_recovered() -> None:
    assert sug._parse("[- Add logging, - Write unit tests]") == [
        "Add logging",
        "Write unit tests",
    ]


def test_an_empty_array_parses_to_no_items_not_to_failure() -> None:
    """`[]` is a RESULT — it clears stale chips. It must not read as a failure."""
    assert sug._parse("[]") == []


@pytest.mark.parametrize(
    "raw",
    ["I could not determine any follow-ups.", "", "```", "null", "{}"],
)
def test_unrecoverable_output_yields_none(raw: str) -> None:
    assert sug._parse(raw) is None


def test_at_most_three_survive() -> None:
    assert len(sug._parse('["One a","Two b","Three c","Four d","Five e"]')) == 3


def test_long_and_empty_items_are_dropped() -> None:
    parsed = sug._parse(
        '["Ship it","This suggestion runs well past the six word ceiling","",'
        '"   "]'
    )
    assert parsed == ["Ship it"]


def test_curiosity_items_are_dropped() -> None:
    """A prompt the assistant cannot act on is worse than no prompt."""
    parsed = sug._parse(
        '["Learn about type hints","Explore alternatives","Roll back release"]'
    )
    assert parsed == ["Roll back release"]


def test_duplicates_are_dropped_case_insensitively() -> None:
    assert sug._parse('["Add tests","add tests","Ship it"]') == [
        "Add tests",
        "Ship it",
    ]


def test_items_are_capitalised() -> None:
    """The model mixes cases between runs; the chips must not."""
    assert sug._parse('["run benchmark tests"]') == ["Run benchmark tests"]


# --- the turn it looks at ------------------------------------------------


def test_latest_ask_is_the_newest_user_message() -> None:
    history = [
        HistoryMessage(role="user", content="first", seq=1),
        HistoryMessage(role="assistant", content="answer", seq=2),
        HistoryMessage(role="user", content="second", seq=3),
    ]
    assert sug._latest_ask(history) == "second"


def test_latest_ask_is_empty_when_there_is_no_user_turn() -> None:
    assert sug._latest_ask([]) == ""


# --- scheduling ----------------------------------------------------------


def test_disabled_flag_makes_no_call_at_all() -> None:
    assert (
        sug.schedule(
            settings=_settings(ai_suggestions_enabled=False),
            convex=_RecordingConvex(),
            stream_id="s1",
            history=[],
            final_text="A substantial answer.",
        )
        is None
    )


def test_an_empty_answer_is_not_worth_a_call() -> None:
    assert (
        sug.schedule(
            settings=_settings(ai_suggestions_enabled=True),
            convex=_RecordingConvex(),
            stream_id="s1",
            history=[],
            final_text="   ",
        )
        is None
    )


async def test_scheduled_task_is_strongly_referenced_until_it_finishes(
    monkeypatch,
) -> None:
    """The loop holds only a weak ref; a dropped handle can be GC'd mid-flight."""
    monkeypatch.setattr(sug, "build_llm", lambda *a, **k: _FakeLLM(content="[]"))
    convex = _RecordingConvex()
    task = sug.schedule(
        settings=_settings(ai_suggestions_enabled=True),
        convex=convex,
        stream_id="s1",
        history=[],
        final_text="An answer.",
    )
    assert task in sug._pending
    await task
    assert task not in sug._pending


# --- writing -------------------------------------------------------------


async def test_parsed_suggestions_are_posted(monkeypatch) -> None:
    monkeypatch.setattr(
        sug,
        "build_llm",
        lambda *a, **k: _FakeLLM(content='["Roll back release","Check logs"]'),
    )
    convex = _RecordingConvex()
    await sug.write_suggestions(
        settings=_settings(ai_suggestions_enabled=True),
        convex=convex,
        stream_id="s1",
        history=[HistoryMessage(role="user", content="ship it", seq=1)],
        final_text="Released. Version 2.1.0 is live.",
    )
    assert convex.posted == [
        {
            "op": "suggestions",
            "streamId": "s1",
            "suggestions": ["Roll back release", "Check logs"],
        }
    ]


async def test_an_empty_result_is_still_written(monkeypatch) -> None:
    """THE staleness fix: a trivial turn must actively clear the last turn's chips."""
    monkeypatch.setattr(sug, "build_llm", lambda *a, **k: _FakeLLM(content="[]"))
    convex = _RecordingConvex()
    await sug.write_suggestions(
        settings=_settings(ai_suggestions_enabled=True),
        convex=convex,
        stream_id="s1",
        history=[HistoryMessage(role="user", content="thanks", seq=1)],
        final_text="You're welcome!",
    )
    assert convex.posted[0]["suggestions"] == []


async def test_a_raising_model_never_propagates_and_writes_nothing(
    monkeypatch,
) -> None:
    """The turn already succeeded; nothing here may fail it."""
    monkeypatch.setattr(
        sug,
        "build_llm",
        lambda *a, **k: _FakeLLM(exc=RuntimeError("openrouter unavailable")),
    )
    convex = _RecordingConvex()
    await sug.write_suggestions(
        settings=_settings(ai_suggestions_enabled=True),
        convex=convex,
        stream_id="s1",
        history=[],
        final_text="An answer.",
    )
    assert convex.posted == []


async def test_unparseable_output_writes_nothing(monkeypatch) -> None:
    """Fails CLOSED: no chips beats garbage chips, and beats clobbering good ones."""
    monkeypatch.setattr(
        sug, "build_llm", lambda *a, **k: _FakeLLM(content="Sorry, I cannot.")
    )
    convex = _RecordingConvex()
    await sug.write_suggestions(
        settings=_settings(ai_suggestions_enabled=True),
        convex=convex,
        stream_id="s1",
        history=[],
        final_text="An answer.",
    )
    assert convex.posted == []


async def test_a_convex_write_failure_is_swallowed(monkeypatch) -> None:
    monkeypatch.setattr(
        sug, "build_llm", lambda *a, **k: _FakeLLM(content='["Ship it"]')
    )

    class _Broken:
        async def ingress(self, _body: dict) -> dict:
            raise RuntimeError("convex down")

    await sug.write_suggestions(
        settings=_settings(ai_suggestions_enabled=True),
        convex=_Broken(),
        stream_id="s1",
        history=[],
        final_text="An answer.",
    )


async def test_the_model_sees_the_ask_and_the_answer(monkeypatch) -> None:
    """Relevance depends on both halves of the turn reaching the classifier."""
    seen: list[str] = []

    class _Capturing(_FakeLLM):
        async def ainvoke(self, messages: Any) -> Any:
            seen.append(str(messages[-1].content))
            return await super().ainvoke(messages)

    monkeypatch.setattr(sug, "build_llm", lambda *a, **k: _Capturing(content="[]"))
    await sug.write_suggestions(
        settings=_settings(ai_suggestions_enabled=True),
        convex=_RecordingConvex(),
        stream_id="s1",
        history=[HistoryMessage(role="user", content="audit my post", seq=1)],
        final_text="Content 27/30, tags missing.",
    )
    assert "audit my post" in seen[0]
    assert "Content 27/30" in seen[0]
