"""The rolling summary: when it runs, and what it is fed.

The producer never existed — `op:"summary"` was routed end to end and nothing
ever sent it, so `thread.summary` was null for every conversation that has run.
These cover the decision to summarise and the transcript it summarises, which
are the parts that can be tested without spending a model call.
"""

from __future__ import annotations

from app.models.chat import HistoryMessage
from app.runtime.compaction import (
    MIN_MESSAGES_TO_SUMMARISE,
    RESUMMARISE_STRIDE,
    _transcript,
    should_summarise,
)


def _history(n: int, *, start: int = 0, chars: int = 40) -> list[HistoryMessage]:
    return [
        HistoryMessage(
            role="user" if i % 2 == 0 else "assistant",
            content=f"m{start + i} " + "x" * chars,
            seq=start + i,
        )
        for i in range(n)
    ]


def test_a_short_thread_is_not_summarised() -> None:
    """Below the threshold the raw history is strictly better than a summary."""
    assert should_summarise(_history(MIN_MESSAGES_TO_SUMMARISE - 1), 0) is False


def test_a_long_thread_is_summarised_once_then_not_every_turn() -> None:
    hist = _history(MIN_MESSAGES_TO_SUMMARISE + 4)
    newest = max(h.seq for h in hist)
    assert should_summarise(hist, 0) is True
    # Just summarised through the newest message: nothing new to add yet.
    assert should_summarise(hist, newest) is False
    # ...and it waits for a stride rather than firing on every single turn.
    assert should_summarise(hist, newest - RESUMMARISE_STRIDE + 1) is False
    assert should_summarise(hist, newest - RESUMMARISE_STRIDE) is True


def test_the_transcript_keeps_the_RECENT_turns_when_it_must_trim() -> None:
    """Front-trimmed on purpose.

    The recent turns decide what "it" and "above" refer to; the opening of a long
    conversation matters least to a state record and is also the part a previous
    summary already covered.
    """
    hist = _history(60, chars=4_000)
    out = _transcript(hist, final_text="THE-FINAL-ANSWER")
    assert "THE-FINAL-ANSWER" in out
    assert out.startswith("[... earlier turns omitted ...]")
    # The oldest message is the one sacrificed, not the newest.
    assert "m0 " not in out


def test_the_final_answer_is_included_even_though_it_is_not_in_history() -> None:
    """It has not been persisted yet when the summary runs."""
    out = _transcript(_history(4), final_text="FRESHLY-WRITTEN")
    assert "FRESHLY-WRITTEN" in out
