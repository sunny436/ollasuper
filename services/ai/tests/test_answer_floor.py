"""The never-empty floor (graph.answer_nudge), driven through graph.ainvoke.

A turn that did tool work and is about to end with no ANSWER gets exactly one
more model step, tools unbound. Both production failure shapes are covered — an
empty turn, and a turn that ended on narration alone after its searches failed —
while a short real final answer ("391") and a deliverable written alongside a
tool call are left alone.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage

from app.agent.graph import ANSWER_FLOOR_PROMPT
from app.humanizer.stage import MIN_WORDS
from tests.test_agent_graph import ScriptedLLM, _invoke, _read_tool, _setup, _tc

RECOVERED = "The search failed, so this is from what I already know."
# The exact narration production ended on (K1, 2026-09-29).
NARRATION = (
    "I'll research the Indian mid-size banking context first, then write the "
    "sequence grounded in it. Search backend hiccuped on the parallel burst. "
    "Retrying with a lighter load."
)
DELIVERABLE = " ".join(["word"] * MIN_WORDS)


class RecordingLLM(ScriptedLLM):
    def __init__(self, responses: list[AIMessage]) -> None:
        super().__init__(responses)
        self.seen: list[list] = []

    async def ainvoke(self, messages, *a, **k) -> AIMessage:
        self.seen.append(list(messages))
        return await super().ainvoke(messages, *a, **k)


def _floored(**over):
    ctx, adapter, convex, writer = _setup([_read_tool()])
    ctx.answer_floor = True
    for k, v in over.items():
        setattr(ctx, k, v)
    return ctx, writer


def _tools_then(final: AIMessage, *, preamble: str = "") -> ScriptedLLM:
    return ScriptedLLM([AIMessage(content=preamble, tool_calls=[_tc("c1")]), final])


async def test_an_empty_answer_after_tool_work_gets_one_more_step():
    ctx, _ = _floored()
    plain = RecordingLLM([AIMessage(content=RECOVERED)])
    out = await _invoke(plain, _tools_then(AIMessage(content="")), ctx, None)
    assert ctx.answer_floor_used is True
    assert plain.calls == 1
    assert plain.seen[0][-1].content == ANSWER_FLOOR_PROMPT
    assert out["messages"][-1].content == RECOVERED


async def test_a_short_real_answer_is_left_alone():
    ctx, _ = _floored()
    plain = RecordingLLM([AIMessage(content=RECOVERED)])
    out = await _invoke(plain, _tools_then(AIMessage(content="391")), ctx, None)
    assert plain.calls == 0
    assert ctx.answer_floor_used is False
    assert out["messages"][-1].content == "391"


async def test_no_tool_work_means_no_floor():
    ctx, _ = _floored()
    plain = RecordingLLM([AIMessage(content=RECOVERED)])
    await _invoke(plain, ScriptedLLM([AIMessage(content="")]), ctx, None)
    assert plain.calls == 0


async def test_the_floor_is_off_unless_the_context_enables_it():
    ctx, _, _, _ = _setup([_read_tool()])
    plain = RecordingLLM([AIMessage(content=RECOVERED)])
    await _invoke(plain, _tools_then(AIMessage(content="")), ctx, None)
    assert plain.calls == 0


async def test_the_floor_fires_at_most_once():
    ctx, _ = _floored()
    plain = RecordingLLM([AIMessage(content="")])
    await _invoke(plain, _tools_then(AIMessage(content="")), ctx, None)
    assert plain.calls == 1


async def test_narration_alone_is_not_an_answer():
    # Production: every search failed, the loop stalled, and the turn ended on
    # this narration with the three emails never written.
    ctx, writer = _floored()
    await writer.push(NARRATION)  # the user saw it stream
    plain = RecordingLLM([AIMessage(content=RECOVERED)])
    out = await _invoke(
        plain, _tools_then(AIMessage(content=""), preamble=NARRATION), ctx, None
    )
    assert plain.calls == 1
    assert out["messages"][-1].content == RECOVERED


async def test_a_deliverable_already_shown_to_the_user_blocks_the_floor():
    # The stream-break recovery clears a message's copy of text that already
    # streamed; the writer still has it, so the user did get the deliverable.
    ctx, writer = _floored()
    await writer.push(DELIVERABLE)
    plain = RecordingLLM([AIMessage(content=RECOVERED)])
    await _invoke(plain, _tools_then(AIMessage(content="")), ctx, None)
    assert plain.calls == 0


async def test_a_deliverable_written_alongside_a_tool_call_blocks_the_floor():
    # e.g. the full answer, then generate_file for a copy. Also what the
    # humanizer relies on: its held draft is in the messages, not the writer.
    ctx, _ = _floored()
    plain = RecordingLLM([AIMessage(content=RECOVERED)])
    await _invoke(
        plain, _tools_then(AIMessage(content=""), preamble=DELIVERABLE), ctx, None
    )
    assert plain.calls == 0


class _Sec:
    def checkpoint_due(self) -> bool:
        return False


async def test_a_security_turn_never_takes_the_floor():
    # Tool work is preset (step_counter) so no fake has to satisfy the executor's
    # security guards; the control shows the same setup does fire without it.
    for security, expected in ((None, 1), (_Sec(), 0)):
        ctx, _ = _floored(step_counter=1, security=security)
        plain = RecordingLLM([AIMessage(content=RECOVERED)])
        await _invoke(plain, ScriptedLLM([AIMessage(content="")]), ctx, None)
        assert plain.calls == expected
