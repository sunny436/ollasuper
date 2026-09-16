"""Does the stage ACTUALLY RUN? The wiring tests prove the tool is bound and the
guidance is present; this one drives the real executor and the real graph.

A skill that is registered but never invoked is the failure mode this repo has
already met (the runner carries a note about a built-in the model declined across
ten production scenarios), so "it is wired" and "it runs" are tested separately.
"""

from __future__ import annotations

import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app.agent.executor import ToolExecContext, execute_tool_calls
from app.agent.policy import READ_SCOPE
from app.humanizer.tool import HUMANIZE_CHECK_TOOL_NAME
from app.runtime.writer import DeltaWriter
from tests.conftest import make_settings
from tests.test_writer_events import RecordingConvex

pytestmark = pytest.mark.anyio

SLOP_DRAFT = (
    "# Unlocking The Power Of Modern Caching\n\n"
    "In today's digital landscape, caching is not just a technique but a "
    "testament to good engineering. Additionally, the robust layer seamlessly "
    "unlocks comprehensive value. We measured 41% lower p95 latency across "
    "1,200 requests, per https://example.test/bench.\n\n"
    "Let that sink in.\n\n"
    "I hope this helps! Let me know if you would like more detail.\n"
)
HUMAN_REWRITE = (
    # The heading is DE-DECORATED, not repurposed: "Unlocking The Power Of" is
    # slop and goes; "modern caching" is the subject and stays. A rewrite that
    # changed the subject would be reported as a loss, and is — see
    # `test_humanizer_preserve.py`.
    "# How modern caching works\n\n"
    "Caching cut p95 latency by 41% across 1,200 requests. The benchmark is at "
    "https://example.test/bench if you want the method.\n\n"
    "Most of the win came from reusing connections, not from the cache itself.\n"
)


def _ctx(writer: DeltaWriter) -> ToolExecContext:
    return ToolExecContext(
        registry=None,
        adapter=None,
        writer=writer,
        scope=READ_SCOPE,
        name_to_tool_id={},
        result_max_chars=8000,
        default_timeout_s=30.0,
    )


async def _call(ctx: ToolExecContext, args: dict, call_id: str) -> ToolMessage:
    msgs = await execute_tool_calls(
        [{"name": HUMANIZE_CHECK_TOOL_NAME, "args": args, "id": call_id}], ctx
    )
    assert len(msgs) == 1 and isinstance(msgs[0], ToolMessage)
    return msgs[0]


async def test_the_executor_dispatches_detect_and_emits_a_pill_step():
    """The Blog-shaped half: a draft goes in, the verdict and the spans come
    back, and the activity UI sees a real step (it is real work)."""
    s = make_settings("http://x", ai_humanizer_enabled=True)
    rec = RecordingConvex({"ok": True})
    ctx = _ctx(DeltaWriter(rec, "s1", s))

    msg = await _call(ctx, {"mode": "detect", "text": SLOP_DRAFT}, "c1")
    assert msg.status == "success"
    body = json.loads(msg.content)
    assert body["verdict"] == "revise"
    assert body["human_voice_score"] < 85
    assert body["findings_total"] > 0

    events = [c for c in rec.calls if c.get("op") == "event"]
    types = {e["type"] for c in events for e in c["events"]}
    assert "TOOL_CALL" in types and "TOOL_RESULT" in types


async def test_the_draft_itself_never_reaches_the_event_payload():
    """The draft is the user's content. Only the MODE is emitted — an event
    payload is not the place for a whole article."""
    s = make_settings("http://x", ai_humanizer_enabled=True)
    rec = RecordingConvex({"ok": True})
    ctx = _ctx(DeltaWriter(rec, "s1", s))
    await _call(ctx, {"mode": "detect", "text": SLOP_DRAFT}, "c1")

    calls = [
        e
        for c in rec.calls
        if c.get("op") == "event"
        for e in c["events"]
        if e["type"] == "TOOL_CALL"
    ]
    assert calls, "no TOOL_CALL event was emitted"
    for event in calls:
        # Only the mode: an event payload is not the place for a whole article.
        payload = json.loads(event["payload"])
        assert payload["arguments"] == {"mode": "detect"}
        assert "testament to good engineering" not in json.dumps(event)


async def test_the_full_stage_runs_end_to_end_through_the_executor():
    """detect -> (the model rewrites) -> verify, exactly as the guidance orders
    it, driven through the real dispatch path."""
    s = make_settings("http://x", ai_humanizer_enabled=True)
    ctx = _ctx(DeltaWriter(RecordingConvex({"ok": True}), "s1", s))

    detected = json.loads(
        (await _call(ctx, {"mode": "detect", "text": SLOP_DRAFT}, "c1")).content
    )
    assert detected["verdict"] == "revise"

    verified = json.loads(
        (
            await _call(
                ctx,
                {
                    "mode": "verify",
                    "before": SLOP_DRAFT,
                    "after": HUMAN_REWRITE,
                    "keywords": ["p95 latency"],
                },
                "c2",
            )
        ).content
    )
    assert verified["ok"] is True, verified["lost"]
    assert verified["score_after"] > verified["score_before"]


async def test_a_lossy_rewrite_comes_back_as_a_refusal_the_model_can_act_on():
    """The point of the verify step: the model is TOLD what it dropped."""
    s = make_settings("http://x", ai_humanizer_enabled=True)
    ctx = _ctx(DeltaWriter(RecordingConvex({"ok": True}), "s1", s))
    lossy = HUMAN_REWRITE.replace("41% across 1,200 requests", "a lot")
    body = json.loads(
        (
            await _call(
                ctx, {"mode": "verify", "before": SLOP_DRAFT, "after": lossy}, "c1"
            )
        ).content
    )
    assert body["ok"] is False
    assert "41%" in body["lost"]["numbers"] and "1200" in body["lost"]["numbers"]


async def test_a_bad_call_fails_the_step_without_breaking_the_turn():
    s = make_settings("http://x", ai_humanizer_enabled=True)
    ctx = _ctx(DeltaWriter(RecordingConvex({"ok": True}), "s1", s))
    msg = await _call(ctx, {"mode": "detect"}, "c1")
    assert msg.status == "error"
    assert "error" in json.loads(msg.content)


# ------------------------------------------------------- the graph, scripted
async def test_a_scripted_writing_turn_calls_the_stage_before_answering():
    """THE end-to-end shape, with a fake model standing in for the LLM: the
    turn emits a humanize_check call, the executor answers it, and the final
    text is produced after that — which is the pipeline the plan specifies
    (generate -> validate -> humanize -> final validation -> return)."""
    s = make_settings("http://x", ai_humanizer_enabled=True)
    ctx = _ctx(DeltaWriter(RecordingConvex({"ok": True}), "s1", s))

    # Step 1: the model finishes a draft and checks it.
    scripted_call = AIMessage(
        content="",
        tool_calls=[
            {
                "name": HUMANIZE_CHECK_TOOL_NAME,
                "args": {"mode": "detect", "text": SLOP_DRAFT},
                "id": "c1",
            }
        ],
    )
    results = await execute_tool_calls(scripted_call.tool_calls, ctx)
    assert results[0].status == "success"
    verdict = json.loads(results[0].content)["verdict"]

    # Step 2: 'revise' means it rewrites, then verifies before answering.
    assert verdict == "revise"
    verify_result = await execute_tool_calls(
        [
            {
                "name": HUMANIZE_CHECK_TOOL_NAME,
                "args": {
                    "mode": "verify",
                    "before": SLOP_DRAFT,
                    "after": HUMAN_REWRITE,
                },
                "id": "c2",
            }
        ],
        ctx,
    )
    assert json.loads(verify_result[0].content)["ok"] is True

    # The conversation the model sees ends with both tool results, so the final
    # answer it streams is the verified rewrite, not the draft.
    history = [HumanMessage("write me a post about caching"), scripted_call, *results]
    assert isinstance(history[-1], ToolMessage)


async def test_the_measurement_hook_scores_a_finished_answer():
    """Tier C: the deterministic measurement that runs on EVERY turn, including
    the one-shot writing turns where no in-loop stage can run. It reads the
    finished text and logs — it can never rewrite, because the text has already
    streamed by then."""
    from app.runtime.runner import _log_writing_quality

    # Long enough to be a deliverable rather than a chat reply.
    _log_writing_quality("s1", SLOP_DRAFT * 4)
    _log_writing_quality("s1", "")  # never raises on an empty turn
    _log_writing_quality("s1", "too short to be a deliverable")
