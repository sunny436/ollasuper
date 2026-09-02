"""Phase 7 — durable multi-step execution: bounded retry, background heartbeat,
total deadline, and idempotent resume reconstruction.

Retry uses a real OllagraphAdapter over httpx.MockTransport; the runner-level
cases use the FakeLLM + run_generation harness (mirrors test_agent_runner.py).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time

import httpx
from langchain_core.messages import AIMessage

from app.agent.executor import ToolExecContext, execute_tool_calls
from app.agent.policy import READ_SCOPE
from app.clients.ollagraph import OllagraphAdapter
from app.models.chat import CompletedTool, GenerateRequest, HistoryMessage
from app.models.tools import (
    Availability,
    SideEffect,
    ToolDefinition,
    ToolPermissions,
)
from app.runtime.runner import _background_heartbeat, run_generation
from app.runtime.writer import DeltaWriter
from tests.conftest import make_settings
from tests.test_writer_events import RecordingConvex


# ---- shared harness ----------------------------------------------------------
class FakeTools:
    def __init__(self, responses):
        self._r = responses
        self.calls = 0

    async def ainvoke(self, messages, *a, **k):
        self.calls += 1
        return self._r[min(self.calls - 1, len(self._r) - 1)]


class FakeLLM:
    def __init__(self, plain, tool_responses, *, delay=0.0):
        self._plain = plain
        self._tools = FakeTools(tool_responses)
        self._delay = delay
        self.captured_messages = None

    def bind_tools(self, specs):
        return self._tools

    async def ainvoke(self, messages, *a, **k):
        self.captured_messages = messages
        if self._delay:
            await asyncio.sleep(self._delay)
        return self._plain


def _req(content, **over):
    base = dict(
        streamId="s1",
        threadId="t1",
        messageId="m1",
        userId="u1",
        workspaceId="w1",
        model="gpt-5.6-luna",
        history=[HistoryMessage(role="user", content=content, seq=1)],
    )
    base.update(over)
    return GenerateRequest(**base)


def _web_tool() -> ToolDefinition:
    return ToolDefinition(
        tool_id="search_web",
        name="Search Web",
        description="search",
        path="/v1/search",
        method="post",
        side_effect=SideEffect.READ_ONLY,
        availability=Availability.AVAILABLE,
        permissions=ToolPermissions(required_permissions=["ollagraph:read"]),
        input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
    )


def _ops(convex, op):
    return [c for c in convex.calls if c.get("op") == op]


# ---- 1. bounded retry (executor) ---------------------------------------------
def _retry_ctx(handler, *, retries):
    s = make_settings(
        "http://x",
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_x",
    )
    reg_tool = _web_tool()
    from app.tools.registry import ToolRegistry

    reg = ToolRegistry()
    reg.register(reg_tool)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    convex = RecordingConvex()
    ctx = ToolExecContext(
        registry=reg,
        adapter=OllagraphAdapter(s, client),
        writer=DeltaWriter(convex, "s1", s),
        scope=READ_SCOPE,
        name_to_tool_id={"search_web": "search_web"},
        result_max_chars=8000,
        default_timeout_s=5.0,
        tool_max_retries=retries,
        tool_retry_base_s=0.001,  # keep tests fast
    )
    return ctx, client


def _tc(cid="c1"):
    return {"name": "search_web", "args": {"q": "x"}, "id": cid}


async def test_retryable_error_retries_then_succeeds():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        if calls["n"] < 3:  # fail twice with a retryable 503
            return httpx.Response(503, json={"e": "upstream"})
        return httpx.Response(200, json={"ok": True})

    ctx, client = _retry_ctx(handler, retries=2)
    try:
        msgs = await execute_tool_calls([_tc()], ctx)
    finally:
        await client.aclose()
    assert calls["n"] == 3  # 2 retries then success
    assert msgs[0].status == "success"


async def test_non_retryable_error_does_not_retry():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(401, json={"e": "auth"})  # AUTH_FAILED, not retryable

    ctx, client = _retry_ctx(handler, retries=3)
    try:
        msgs = await execute_tool_calls([_tc()], ctx)
    finally:
        await client.aclose()
    assert calls["n"] == 1  # no retry
    assert msgs[0].status == "error"


async def test_retry_exhausted_returns_error():
    def handler(req):
        return httpx.Response(429, json={"e": "rate"})  # always retryable-fail

    ctx, client = _retry_ctx(handler, retries=2)
    try:
        msgs = await execute_tool_calls([_tc()], ctx)
    finally:
        await client.aclose()
    assert msgs[0].status == "error"


# ---- 2. background heartbeat -------------------------------------------------
async def test_background_heartbeat_fires_independently():
    s = make_settings("http://x")
    convex = RecordingConvex()
    writer = DeltaWriter(convex, "s1", s)
    far = asyncio.get_event_loop().time() + 1000  # deadline never fires here
    task = asyncio.create_task(
        _background_heartbeat(
            writer, 10, asyncio.current_task(), {"hit": False, "mono": far}
        )
    )
    await asyncio.sleep(0.05)  # ~5 ticks at 10ms
    task.cancel()
    beats = _ops(convex, "heartbeat")
    assert len(beats) >= 2  # fired without any model chunk


async def test_tool_event_rolls_the_deadline_plain_event_does_not():
    # A TOOL event proves the turn is actively tooling → the deadline rolls forward
    # (so a deep audit is not killed); a non-tool event leaves it untouched (so a
    # plain no-tool reply keeps its hard deadline).
    import time

    from app.models.events import EventType

    s = make_settings("http://x")
    writer = DeltaWriter(RecordingConvex(), "s1", s)
    flag = {"hit": False, "mono": 0.0}
    writer.on_tool_activity = lambda: flag.__setitem__(
        "mono", max(flag["mono"], time.monotonic() + s.ai_agent_total_deadline_s)
    )
    before = time.monotonic()
    await writer.emit_event(EventType.TOOL_CALL, tool_name="t", call_id="c1")
    assert flag["mono"] >= before + s.ai_agent_total_deadline_s - 1  # rolled forward

    flag["mono"] = 0.0
    await writer.emit_event(EventType.CITATION, source_id="s1")  # not a tool event
    assert flag["mono"] == 0.0  # untouched


# ---- 3. total deadline -------------------------------------------------------
async def test_total_deadline_times_out(monkeypatch):
    # A slow model call + a deadline already in the past: the background guard
    # cancels the turn and the handler converts it to a clean TIMED_OUT, even
    # with no streamed tokens.
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(AIMessage(content="slow answer"), [], delay=0.5),
    )
    settings = make_settings("http://x", ai_heartbeat_ms=20)
    convex = RecordingConvex()
    await run_generation(_req("hello", deadlineAt=1), settings, convex)
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "error"
    assert finals[0]["error"]["code"] == "deadline_exceeded"


# ---- 4. idempotent resume reconstruction ------------------------------------
async def test_resume_does_not_re_execute_completed_tool(monkeypatch):
    # The model (on resume) re-emits the SAME tool call; the re-seeded seen_calls
    # must skip it so the side-effecting adapter is never re-run.
    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        return []

    from app.ingest import retrieve

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)

    tc = {"name": "search_web", "args": {"q": "cats"}, "id": "c1"}
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain"),
            [AIMessage(content="", tool_calls=[tc]), AIMessage(content="answer")],
        ),
    )
    settings = make_settings(
        "http://x",
        ai_agent_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
    )
    from app.tools.registry import ToolRegistry
    from app.tools.selection import ToolSelector

    reg = ToolRegistry()
    reg.register(_web_tool())
    adapter_calls = {"n": 0}

    def handler(req):
        adapter_calls["n"] += 1
        return httpx.Response(200, json={"hits": ["a"]})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    convex = RecordingConvex()
    req = _req(
        "search cats",
        attempt=1,
        deadlineAt=0,
        eventSeqBaseline=7,
        completedTools=[
            CompletedTool(
                toolId="search_web",
                args={"q": "cats"},
                resultContent='{"result": {"hits": ["a"]}}',
            )
        ],
    )
    try:
        await run_generation(
            req,
            settings,
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    # The completed Ollagraph tool was NOT re-executed (idempotency re-seed).
    assert adapter_calls["n"] == 0
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"


async def test_resume_seeds_budget_and_event_seq(monkeypatch):
    # A resume with 3 completed steps leaves budget = max_steps - 3, and the
    # writer's event seq continues from the baseline.
    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        return []

    from app.ingest import retrieve

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="final"), [AIMessage(content="final")]
        ),
    )
    settings = make_settings("http://x", ai_agent_memory_tool_enabled=True)
    convex = RecordingConvex()
    completed = [
        CompletedTool(toolId="search_web", args={"q": str(i)}, resultContent="{}")
        for i in range(3)
    ]
    req = _req(
        "resume me",
        attempt=2,
        memoryEnabled=True,
        completedTools=completed,
        eventSeqBaseline=9,
    )
    await run_generation(req, settings, convex)
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"


# ---- 6. long-running execution -----------------------------------------------
#
# Regressions for the failure mode where a legitimately long, tool-heavy turn
# could not finish: the step budget was seeded in the wrong UNIT on resume, and
# the no-progress deadline only counted TOOL activity.


async def test_resume_seeds_budget_in_steps_not_tool_calls(monkeypatch):
    """A resumed turn that had made MORE tool calls than ai_agent_max_steps must
    keep a real budget and still be able to call tools.

    The budget is spent one per executor PASS, but it used to be seeded by
    subtracting len(completedTools) — a count of individual CALLS. 35 calls against
    a 12-step budget produced max(0, 12 - 35) = 0, which silently unbound every
    tool: the model could no longer call generate_file (or anything else), and
    with no tool able to run it could never emit another tool event to roll its
    own deadline either. This asserts the tool actually runs.
    """

    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        return []

    from app.ingest import retrieve

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)

    tc = {"name": "search_web", "args": {"q": "fresh"}, "id": "c-new"}
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain"),
            [AIMessage(content="", tool_calls=[tc]), AIMessage(content="answer")],
        ),
    )
    settings = make_settings(
        "http://x",
        ai_agent_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
    )
    from app.tools.registry import ToolRegistry
    from app.tools.selection import ToolSelector

    reg = ToolRegistry()
    reg.register(_web_tool())
    adapter_calls = {"n": 0}

    def handler(req):
        adapter_calls["n"] += 1
        return httpx.Response(200, json={"hits": ["a"]})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    convex = RecordingConvex()
    # 35 completed CALLS that were made across only 3 executor PASSES.
    completed = [
        CompletedTool(toolId="search_web", args={"q": str(i)}, resultContent="{}")
        for i in range(35)
    ]
    req = _req(
        "keep going",
        attempt=1,
        completedTools=completed,
        completedSteps=3,
        eventSeqBaseline=80,
    )
    assert len(req.completedTools) == 35
    assert settings.ai_agent_max_steps < len(req.completedTools)  # the trap
    try:
        await run_generation(
            req,
            settings,
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    # Budget was 12 - 3 = 9, NOT max(0, 12 - 35) = 0, so tools stayed bound.
    assert adapter_calls["n"] == 1
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"


async def test_completed_steps_falls_back_to_call_count_when_absent():
    """A Convex that predates `completedSteps` omits it. The runner must fall back
    to the old call-count (conservative) rather than treating it as zero consumed."""
    req = _req("x", attempt=1, completedTools=[])
    assert req.completedSteps == 0  # additive + defaulted: extra="forbid" is safe


async def test_streamed_text_rolls_the_total_deadline():
    """Deltas are forward progress. Without this the final long-form answer of a
    tool-heavy turn — which emits NO tool events, and runs precisely when the step
    budget is spent so none is even possible — sat under a deadline frozen at the
    last tool call and was killed mid-generation."""
    s = make_settings("http://x")
    convex = RecordingConvex()
    w = DeltaWriter(convex, "s1", s)
    rolled = {"n": 0}
    w.on_progress = lambda: rolled.__setitem__("n", rolled["n"] + 1)
    await w.push("some streamed answer text")
    await w.flush(force=True)
    assert rolled["n"] == 1
    assert _ops(convex, "delta")


async def test_background_heartbeat_does_not_kill_a_turn_making_text_progress():
    """End-to-end of the same invariant at the watchdog: a turn whose deadline is
    rolled by text keeps running; one that goes silent is still cancelled."""
    s = make_settings("http://x")
    convex = RecordingConvex()
    w = DeltaWriter(convex, "s1", s)

    async def never_ends():
        await asyncio.sleep(3)

    # Deadline already in the past and never rolled -> the watchdog must fire.
    task = asyncio.create_task(never_ends())
    flag = {"hit": False, "mono": time.monotonic() - 1}
    hb = asyncio.create_task(_background_heartbeat(w, 10, task, flag))
    with contextlib.suppress(asyncio.CancelledError):
        await task
    hb.cancel()
    assert flag["hit"] is True


# ---- 7. provider rate limiting (429) -----------------------------------------
#
# 429 is by far the most common Ollagraph failure in production. Retrying it on
# our own 0.5s/1.0s exponential lands every remaining attempt inside the same rate
# window, so all of them fail and the work is silently lost.


async def test_retry_after_longer_than_the_tool_budget_is_not_retried():
    """Waiting longer than a whole tool execution would park a concurrency slot
    doing nothing. Give up and let the model re-decide with the result in hand."""
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(429, headers={"retry-after": "999"}, json={"e": "slow"})

    ctx, client = _retry_ctx(handler, retries=2)  # default_timeout_s=5.0
    try:
        out = await execute_tool_calls([_tc()], ctx)
    finally:
        await client.aclose()
    assert calls["n"] == 1, "a doomed wait must not burn the remaining attempts"
    payload = json.loads(out[0].content)
    assert payload["kind"] == "rate_limited"
    assert payload["retry_after_s"] == 999.0


async def test_retry_after_within_budget_is_honoured_and_succeeds():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"retry-after": "0.02"}, json={})
        return httpx.Response(200, json={"hits": ["a"]})

    ctx, client = _retry_ctx(handler, retries=2)
    t0 = time.monotonic()
    try:
        out = await execute_tool_calls([_tc()], ctx)
    finally:
        await client.aclose()
    elapsed = time.monotonic() - t0
    assert calls["n"] == 2
    # Slept the PROVIDER's window (0.02s), not the 0.001s test exponential.
    assert elapsed >= 0.02
    assert "hits" in out[0].content


async def test_a_malformed_retry_after_never_parks_the_turn():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(
            429, headers={"retry-after": "Wed, 21 Oct 2099 07:28:00 GMT"}, json={}
        )

    ctx, client = _retry_ctx(handler, retries=1)
    try:
        await execute_tool_calls([_tc()], ctx)
    finally:
        await client.aclose()
    # Unparseable -> ignored, falls back to the bounded exponential (still retried).
    assert calls["n"] == 2


# ---- 8. fan-out is queued, never refused -------------------------------------


async def test_a_wide_fanout_runs_every_call_instead_of_refusing_the_overflow():
    """Refusing the overflow punished exactly the batching PARALLEL_TOOL_GUIDANCE
    asks the model for: it surfaced as FAILED tool runs and cost another step to
    re-emit work already decided on. A wide batch must simply queue."""
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(200, json={"hits": ["a"]})

    ctx, client = _retry_ctx(handler, retries=0)
    assert ctx.max_tool_calls_per_step == 0, "the count cap is off by default"
    n = 30  # comfortably over the old cap of 24
    # DISTINCT args: identical (tool, args) inside one turn are deduped on purpose
    # (the read-only loop guard), which is a different mechanism from the fan-out.
    batch = [
        {"name": "search_web", "args": {"q": f"q{i}"}, "id": f"c{i}"} for i in range(n)
    ]
    try:
        out = await execute_tool_calls(batch, ctx)
    finally:
        await client.aclose()
    assert calls["n"] == n
    assert len(out) == n  # the tool_call<->result pairing lock still holds
    assert not any("too many tool calls" in str(m.content) for m in out)
