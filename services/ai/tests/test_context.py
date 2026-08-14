"""Context assembly, trimming and redaction."""

from __future__ import annotations

import logging

from langchain_core.messages import AIMessage, HumanMessage

from app.agent.context import (
    budget_for,
    build_system_prompt,
    to_lc_messages,
    trim,
)
from app.logging import RedactFilter
from app.models.chat import HistoryMessage, ModelId


def _history(n: int, chars: int = 200) -> list[HistoryMessage]:
    out = []
    for i in range(n):
        out.append(
            HistoryMessage(
                role="user" if i % 2 == 0 else "assistant",
                content=("u" if i % 2 == 0 else "a") * chars,
                seq=i,
            )
        )
    return out


def test_trim_respects_the_budget_and_starts_on_a_human_turn():
    msgs = to_lc_messages(_history(200))
    out = trim(
        msgs,
        model=ModelId.OPUS,
        n_images=0,
        max_output=8192,
        base_budget=4_000,
        safety_factor=1.35,
    )
    assert out, "trimmed everything away"
    assert len(out) < len(msgs)
    # Never begin on an orphaned assistant turn.
    assert isinstance(out[0], HumanMessage)
    # Recency is what survives.
    assert out[-1].content == msgs[-1].content


def test_images_are_subtracted_from_the_budget():
    """Four images on Opus is ~19k tokens — over half a 32k window. If they are
    not charged against the budget the request can blow the context window."""
    without = budget_for(ModelId.OPUS, 0, 8192, 32_000)
    with_four = budget_for(ModelId.OPUS, 4, 8192, 32_000)
    assert with_four < without
    assert without - with_four == 4 * 4784


def test_haiku_has_a_smaller_window_so_a_smaller_budget():
    opus = budget_for(ModelId.OPUS, 0, 8192, 1_000_000)
    haiku = budget_for(ModelId.HAIKU, 0, 8192, 1_000_000)
    assert haiku < opus
    assert haiku <= 200_000


def test_a_single_oversized_message_does_not_loop_or_vanish():
    huge = [HumanMessage(content="x" * 500_000)]
    out = trim(
        huge,
        model=ModelId.OPUS,
        n_images=0,
        max_output=8192,
        base_budget=4_000,
        safety_factor=1.35,
    )
    # Either dropped or kept, but it must return, not hang or explode.
    assert isinstance(out, list)


def test_empty_history_is_fine():
    assert (
        trim(
            [],
            model=ModelId.OPUS,
            n_images=0,
            max_output=8192,
            base_budget=32_000,
            safety_factor=1.35,
        )
        == []
    )


def test_system_prompt_composes_all_the_parts():
    p = build_system_prompt(
        custom="You are a pirate.",
        about="Works in Rust.",
        style="Be terse.",
        summary="They asked about lifetimes.",
        summary_through_seq=12,
    )
    assert "pirate" in p
    assert "<about_the_user>" in p and "Rust" in p
    assert "<response_style>" in p and "terse" in p
    assert 'through_message="12"' in p and "lifetimes" in p


def test_system_prompt_falls_back_to_the_default():
    p = build_system_prompt(
        custom=None, about=None, style=None, summary=None, summary_through_seq=0
    )
    assert "myos" in p
    assert "<about_the_user>" not in p


def test_to_lc_messages_maps_roles():
    msgs = to_lc_messages(
        [
            HistoryMessage(role="user", content="q", seq=0),
            HistoryMessage(role="assistant", content="a", seq=1),
        ]
    )
    assert isinstance(msgs[0], HumanMessage)
    assert isinstance(msgs[1], AIMessage)


# --- redaction --------------------------------------------------------------


def _rec(msg: str, **extra) -> logging.LogRecord:
    r = logging.LogRecord("t", logging.INFO, "f", 1, msg, None, None)
    for k, v in extra.items():
        setattr(r, k, v)
    return r


def test_redaction_scrubs_configured_secrets_and_common_shapes():
    f = RedactFilter(("sk-or-v1-supersecretvalue", "ingress-secret-value"))

    r = _rec("calling with sk-or-v1-supersecretvalue now")
    f.filter(r)
    assert "supersecret" not in r.msg

    r = _rec("auth", header="Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig")
    f.filter(r)
    assert "eyJhbGci" not in r.header

    r = _rec("img", data="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEA")
    f.filter(r)
    assert "iVBORw0" not in r.data

    r = _rec("key sk-abcdefghijklmnop leaked")
    f.filter(r)
    assert "abcdefghijklmnop" not in r.msg
