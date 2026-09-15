"""Phase 3 — durable execution recording + crash recovery / approval continuation.

Executor-level tests assert the durable `op:"execution"` write-ahead + terminal
records (RecordingConvex captures every ingress op). Runner-level tests drive
run_generation with `approvedPending` and prove the approved tool runs DIRECTLY
(no model re-emission), and that a model re-emit is DEDUPED (no double-fire).
"""

from __future__ import annotations

import json

import httpx
from langchain_core.messages import AIMessage

from app.agent.policy import WRITE_SCOPE
from app.models.chat import ApprovedPending
from app.models.tools import ToolPermissions
from app.runtime.runner import run_generation
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.test_agent_executor import _tc
from tests.test_durable import FakeLLM, _req
from tests.test_idempotency import _ctx, _settings, _side_tool
from tests.test_writer_events import RecordingConvex


def _exec_ops(convex, state=None):
    out = [c for c in convex.calls if c.get("op") == "execution"]
    return [c for c in out if state is None or c.get("state") == state]


# --- durable recording (executor) -----------------------------------------
async def test_records_running_then_terminal():
    def handler(req):
        return httpx.Response(200, json={"data": {"ok": True}})

    ctx, convex, client = _ctx(handler, [_side_tool()], scope=WRITE_SCOPE)
    try:
        from app.agent.executor import execute_tool_calls

        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert _exec_ops(convex, "running")  # write-ahead
    assert _exec_ops(convex, "succeeded")  # terminal
    # the RUNNING record carries the durable args (for approval continuation).
    assert _exec_ops(convex, "running")[0]["args"] == {"q": "x"}


async def test_running_recorded_before_provider_call():
    order = {"exec_before_call": False}

    def handler(req):
        # By the time the provider is hit, the RUNNING execution row is recorded.
        order["exec_before_call"] = bool(
            [c for c in convex.calls if c.get("op") == "execution"]
        )
        return httpx.Response(200, json={"data": {"ok": True}})

    ctx, convex, client = _ctx(handler, [_side_tool()], scope=WRITE_SCOPE)
    try:
        from app.agent.executor import execute_tool_calls

        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert order["exec_before_call"] is True  # write-ahead ordering


async def test_dual_gate_abort_when_neither_record_nor_event_lands():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(200, json={"data": {"ok": True}})

    # Both the execution record AND the event report persisted:false.
    ctx, convex, client = _ctx(
        handler,
        [_side_tool()],
        scope=WRITE_SCOPE,
        resp={"ok": True, "persisted": False},
    )
    try:
        from app.agent.executor import execute_tool_calls

        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert calls["n"] == 0  # never fired
    assert json.loads(msgs[0].content)["error"] == "aborted"


async def test_waiting_approval_recorded_with_args_and_ref():
    def handler(req):
        return httpx.Response(200, json={"data": {"ok": True}})

    high = _side_tool(permissions=ToolPermissions(approval_required=True))
    ctx, convex, client = _ctx(handler, [high], scope=WRITE_SCOPE)
    try:
        from app.agent.executor import execute_tool_calls

        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    parked = _exec_ops(convex, "waiting_approval")
    assert parked and parked[0]["args"] == {"q": "x"}
    assert parked[0]["approvalRef"]  # the stable approval id, for direct continuation


# --- approval direct continuation (runner) --------------------------------
def _patch_rag(monkeypatch):
    from app.ingest import retrieve

    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        return []

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)


def _approval_id(tool_id: str, args: dict) -> str:
    """The approval's identity is the BINDING (app/agent/binding.py): the tool
    definition the user reviewed plus the args. Convex stores what Python
    minted, so a resume carries the same binding back."""
    from app.agent.binding import approval_id_for

    assert tool_id == "search_web"
    return approval_id_for(_approvable_tool(), args)


def _approvable_tool():
    return _side_tool(
        tool_id="search_web",
        name="Search Web",
        permissions=ToolPermissions(
            required_permissions=["ollagraph:read"], approval_required=True
        ),
        input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
    )


async def test_approved_pending_runs_directly_no_model_reemission(monkeypatch):
    _patch_rag(monkeypatch)
    # The model NEVER emits the tool — it only synthesizes text.
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="synth"), [AIMessage(content="synth")]
        ),
    )
    settings = _settings(ai_agent_enabled=True, ai_agent_side_effect_enabled=True)
    reg = ToolRegistry()
    reg.register(_approvable_tool())
    adapter_calls = {"n": 0}

    def handler(req):
        adapter_calls["n"] += 1
        return httpx.Response(200, json={"data": {"ok": True}})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    convex = RecordingConvex()
    args = {"q": "x"}
    req = _req(
        "search the web for x",  # matches search_web → tools_ctx is built
        attempt=1,
        eventSeqBaseline=3,
        approvedPending=[
            ApprovedPending(
                toolId="search_web",
                args=args,
                token="tok_1",
                approvalId=_approval_id("search_web", args),
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
    assert adapter_calls["n"] == 1  # executed DIRECTLY from the durable args
    finals = [c for c in convex.calls if c.get("op") == "finalize"]
    assert finals and finals[0]["status"] == "done"


async def test_approved_pending_then_model_reemit_is_deduped(monkeypatch):
    _patch_rag(monkeypatch)
    args = {"q": "x"}
    tc = {"name": "search_web", "args": args, "id": "c1"}
    # The model ALSO re-emits the approved tool — it must be DEDUPED (no re-fire).
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain"),
            [AIMessage(content="", tool_calls=[tc]), AIMessage(content="done")],
        ),
    )
    settings = _settings(ai_agent_enabled=True, ai_agent_side_effect_enabled=True)
    reg = ToolRegistry()
    reg.register(_approvable_tool())
    adapter_calls = {"n": 0}

    def handler(req):
        adapter_calls["n"] += 1
        return httpx.Response(200, json={"data": {"ok": True}})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    convex = RecordingConvex()
    req = _req(
        "search the web for x",
        attempt=1,
        eventSeqBaseline=3,
        approvedPending=[
            ApprovedPending(
                toolId="search_web",
                args=args,
                token="tok_1",
                approvalId=_approval_id("search_web", args),
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
    assert adapter_calls["n"] == 1  # direct run only; the model re-emit was DEDUPED


def test_an_approved_mcp_call_is_reissued_by_its_bound_name():
    """Measured on production: the approved resume of a Gmail `create_draft`
    ran as `approved_0 -> {"error": "unknown tool"}` because the call was
    re-issued by tool_id (`mcp:gmail:create_draft`) while the model — and
    `_run_one` — know it as the sanitised `mcp_gmail_create_draft`. The model
    then re-called the tool itself, which is why the write still landed."""
    from app.agent.executor import bound_name_for_tool_id, build_tool_specs

    class _Tool:
        tool_id = "mcp:gmail:create_draft"
        name = "create_draft"
        description = "d"
        input_schema = {"type": "object", "properties": {}}
        provider = "mcp:gmail"

    class _Cand:
        tool = _Tool()

    class _Registry:
        components = {}

        def components_for(self, _provider):
            return {}

    _specs, name_to_id = build_tool_specs([_Cand()], _Registry())
    assert name_to_id == {"mcp_gmail_create_draft": "mcp:gmail:create_draft"}
    assert (
        bound_name_for_tool_id(name_to_id, "mcp:gmail:create_draft")
        == "mcp_gmail_create_draft"
    )
    # Ollagraph ids bind under their own spelling: unchanged behaviour.
    same = {"search_web": "search_web"}
    assert bound_name_for_tool_id(same, "search_web") == "search_web"
    # Not bound this turn: falls back to the id, which fails as before.
    unbound = "mcp:gmail:create_draft"
    assert bound_name_for_tool_id({}, unbound) == unbound
