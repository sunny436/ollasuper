"""Phase 6 — the central budget / accounting contract.

Unit-tests the ContextBudget allocation + fit_messages compaction + the fan-out
cap, covering the required scenarios: large history / schemas / results /
attachments, many sequential / parallel tools, small-context model, resume with
many completed tools, context overflow, and the (bounded) cost.
"""

from __future__ import annotations

import httpx
import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.messages.utils import count_tokens_approximately

from app.agent.budget import (
    LIMITS,
    ContextBudget,
    content_tokens,
    fit_messages,
    spec_tokens,
    tokens,
)
from app.agent.executor import execute_tool_calls
from app.models.chat import ModelId
from tests.test_agent_executor import _read_tool, _tc
from tests.test_capability_security import _ctx


def _cb(window: int, *, max_output: int = 8192, base: int = 32_000) -> ContextBudget:
    return ContextBudget(
        model=ModelId.OPUS,
        context_window=window,
        max_output=max_output,
        safety_factor=1.35,
        base_history_budget=base,
    )


# --- input ceiling / effective output ------------------------------------
def test_small_window_clamps_output_and_stays_positive():
    cb = _cb(4_000)
    # Output is clamped to window//4 (mirrors llm._clamp_output) so it doesn't
    # eat the whole 4k window.
    assert cb.effective_output == 1_000
    assert cb.input_ceiling >= 1_000  # never negative / below floor


def test_large_window_reserves_the_full_output():
    assert _cb(1_000_000).effective_output == 8_192


# --- history budget subtracts the MEASURED fixed costs -------------------
def test_history_budget_shrinks_as_fixed_costs_grow():
    # A mid-size window where the fixed costs actually bind (a 1M window has so
    # much headroom that both just hit the 32k cost cap).
    cb = _cb(50_000)
    lean = cb.history_budget(
        system_tokens=100, schema_tokens=0, latest_tokens=100, n_images=0
    )
    heavy = cb.history_budget(
        system_tokens=100, schema_tokens=20_000, latest_tokens=100, n_images=0
    )
    assert heavy < lean  # bound tool schemas eat into the history budget
    assert lean <= cb.base_history_budget  # capped by the 32k cost budget


def test_context_overflow_is_prevented_history_floors():
    # A tiny window with fixed costs that already exceed it → history floors,
    # never negative, so the request can't overrun the window.
    cb = _cb(4_000)
    b = cb.history_budget(
        system_tokens=5_000, schema_tokens=5_000, latest_tokens=5_000, n_images=4
    )
    assert b >= 1_000  # the floor


def test_per_turn_cost_is_bounded_by_the_history_cap():
    # The 32k cap × max_steps IS the cost control: history never exceeds it.
    cb = _cb(1_000_000, base=32_000)
    b = cb.history_budget(
        system_tokens=0, schema_tokens=0, latest_tokens=0, n_images=0
    )
    assert b <= 32_000


# --- latest turn is window-aware (large attachments / small model) -------
def test_latest_char_budget_large_window_exceeds_flat_cap():
    # On a large window the derived budget is far above ai_max_turn_chars, so the
    # flat 48k cap wins and big-window behavior is unchanged.
    assert _cb(1_000_000).latest_char_budget() > 48_000


def test_latest_char_budget_small_window_shrinks_documents():
    assert _cb(4_000).latest_char_budget() < 48_000


# --- fit_messages: compaction preserves pairing (results / resume) -------
def _tool_pair(cid: str, chars: int) -> list:
    return [
        AIMessage(content="", tool_calls=[{"name": "t", "args": {}, "id": cid}]),
        ToolMessage(content="Z" * chars, tool_call_id=cid),
    ]


def test_fit_messages_compacts_oldest_first_and_preserves_pairing():
    msgs = [
        HumanMessage(content="question"),
        *_tool_pair("c1", 40_000),
        *_tool_pair("c2", 40_000),
    ]
    before = count_tokens_approximately(msgs)
    # Budget that fits ~one raw result → the OLDEST compacts, the newest stays.
    one_result = count_tokens_approximately(_tool_pair("x", 40_000))
    out = fit_messages(msgs, budget_tokens=one_result + 500)
    assert count_tokens_approximately(out) < before
    # Never drops a message; tool_call_ids intact (pairing preserved).
    assert len(out) == len(msgs)
    assert [m.tool_call_id for m in out if isinstance(m, ToolMessage)] == ["c1", "c2"]
    assert '"compacted": true' in out[2].content  # oldest result compacted
    assert "Z" * 100 in out[4].content  # newest result kept raw


def test_fit_messages_noop_when_under_budget():
    msgs = [HumanMessage(content="short")]
    assert fit_messages(msgs, 100_000) == msgs


def test_fit_messages_handles_a_huge_resume_within_budget():
    # Resume overflow: 64 completed tools × 16k chars must fit after compaction.
    msgs: list = [HumanMessage(content="q")]
    for i in range(64):
        msgs.extend(_tool_pair(f"resume_{i}", 16_000))
    out = fit_messages(msgs, budget_tokens=8_000)
    assert count_tokens_approximately(out) <= 8_000 * 1.2  # ~within budget
    assert len(out) == len(msgs)  # nothing dropped


def test_fit_messages_is_idempotent():
    msgs = [HumanMessage(content="q"), *_tool_pair("c1", 40_000)]
    once = fit_messages(msgs, 500)
    twice = fit_messages(once, 500)
    # An already-compacted result is not re-wrapped.
    assert once[2].content == twice[2].content


# --- measurement helpers -------------------------------------------------
def test_content_tokens_counts_string_and_multimodal_text_only():
    assert content_tokens("hello world") > 0
    multimodal = [
        {"type": "image_url", "image_url": {"url": "data:..."}},
        {"type": "text", "text": "describe this"},
    ]
    # Only the text parts count (images are charged via IMAGE_TOKENS separately).
    assert content_tokens(multimodal) == content_tokens("describe this")


def test_spec_tokens_counts_bound_schemas():
    assert spec_tokens(None) == 0
    assert spec_tokens([]) == 0
    spec = [{"type": "function", "function": {"name": "x", "parameters": {"a": 1}}}]
    assert spec_tokens(spec) > 0


def test_tokens_of_empty_is_zero():
    assert tokens("") == 0


def test_limits_table_documents_the_full_budget_set():
    for key in (
        "context_window",
        "output_tokens",
        "history_budget_tokens",
        "latest_turn_chars",
        "tool_result_chars",
        "workflow_steps",
        "tool_calls_per_step",
        "tool_retries",
        "turn_deadline_s",
        "per_turn_cost",
        "convex_event_batch",
    ):
        assert key in LIMITS


# --- fan-out cap (many parallel tools) -----------------------------------
pytestmark = pytest.mark.anyio


async def test_tool_call_fan_out_is_capped():
    called = {"n": 0}

    def handler(req):
        called["n"] += 1
        return httpx.Response(200, json={"data": {"ok": True}})

    ctx, _, client = _ctx(handler, [_read_tool(tool_id="scrape_x")])
    ctx.max_tool_calls_per_step = 3
    # The model emits 10 distinct calls in one step (distinct args → not deduped).
    calls = [_tc("scrape_x", {"q": f"q{i}"}, f"c{i}") for i in range(10)]
    try:
        msgs = await execute_tool_calls(calls, ctx)
    finally:
        await client.aclose()
    assert called["n"] == 3  # only the first 3 executed
    assert len(msgs) == 10  # every call still paired (pairing lock)
    refused = [m for m in msgs if "too many tool calls" in m.content]
    assert len(refused) == 7
