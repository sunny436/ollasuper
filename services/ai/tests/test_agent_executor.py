"""Phase 4 — the policy-gated tool executor.

Real OllagraphAdapter over httpx.MockTransport (no network) + a real DeltaWriter
over RecordingConvex (no Convex), so the executor is exercised end-to-end: policy
-> validate -> adapter.call_tool -> bound result -> Phase-3 events -> ToolMessage.
"""

from __future__ import annotations

import json

import httpx
from langchain_core.messages import ToolMessage

from app.agent.executor import (
    ToolExecContext,
    _deref_schema,
    _sanitize_name,
    build_tool_specs,
    execute_tool_calls,
)
from app.agent.policy import READ_SCOPE
from app.clients.ollagraph import OllagraphAdapter
from app.config import Settings
from app.models.tools import (
    Availability,
    SideEffect,
    ToolCandidate,
    ToolDefinition,
    ToolPermissions,
)
from app.runtime.writer import DeltaWriter
from app.tools.registry import ToolRegistry
from tests.test_writer_events import RecordingConvex

KEY = "osk_testkey_abcdefgh1234"


def _settings(**over) -> Settings:
    base = dict(ollagraph_base_url="https://api.ollagraph.test", ollagraph_api_key=KEY)
    base.update(over)
    return Settings(**base)


def _read_tool(**over) -> ToolDefinition:
    base = dict(
        tool_id="search_web",
        name="Search Web",
        path="/v1/search",
        method="post",
        side_effect=SideEffect.READ_ONLY,
        enabled=True,
        availability=Availability.AVAILABLE,
        required_auth="BearerAuth",
        permissions=ToolPermissions(required_permissions=["ollagraph:read"]),
        input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
    )
    base.update(over)
    return ToolDefinition(**base)


def _ctx(handler, tools, *, result_max_chars=8000, settings=None):
    s = settings or _settings()
    reg = ToolRegistry()
    for t in tools:
        reg.register(t)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = OllagraphAdapter(s, client)
    convex = RecordingConvex()
    writer = DeltaWriter(convex, "s1", s)
    ctx = ToolExecContext(
        registry=reg,
        adapter=adapter,
        writer=writer,
        scope=READ_SCOPE,
        name_to_tool_id={t.tool_id: t.tool_id for t in tools},
        result_max_chars=result_max_chars,
        default_timeout_s=30.0,
    )
    return ctx, convex, client


def _events(convex: RecordingConvex, etype: str) -> list[dict]:
    out = []
    for c in convex.calls:
        if c.get("op") == "event":
            for e in c["events"]:
                if e["type"] == etype:
                    out.append(json.loads(e["payload"]))
    return out


def _tc(name: str, args: dict, cid: str) -> dict:
    return {"name": name, "args": args, "id": cid}


# --- happy path -----------------------------------------------------------
async def test_read_only_tool_executes_and_emits_events():
    def handler(req):
        return httpx.Response(200, json={"hits": ["a", "b"]})

    ctx, convex, client = _ctx(handler, [_read_tool()])
    try:
        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()

    assert len(msgs) == 1 and isinstance(msgs[0], ToolMessage)
    assert msgs[0].tool_call_id == "c1" and msgs[0].status == "success"
    assert _events(convex, "TOOL_CALL") and _events(convex, "TOOL_RESULT")
    assert "hits" in msgs[0].content


async def test_oversized_result_is_bounded():
    big = {"blob": "z" * 50_000}

    def handler(req):
        return httpx.Response(200, json=big)

    ctx, convex, client = _ctx(handler, [_read_tool()], result_max_chars=2000)
    try:
        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    body = json.loads(msgs[0].content)
    assert body["truncated"] is True and len(msgs[0].content) < 3000


# --- safety / failure branches (each still pairs the tool_call) -----------
async def test_policy_deny_does_not_call_adapter():
    called = {"n": 0}

    def handler(req):
        called["n"] += 1
        return httpx.Response(200, json={})

    disabled = _read_tool(enabled=False)
    ctx, convex, client = _ctx(handler, [disabled])
    try:
        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert called["n"] == 0
    assert msgs[0].status == "error" and msgs[0].tool_call_id == "c1"
    assert not _events(convex, "TOOL_CALL")


async def test_approval_required_parks_and_suspends_without_executing():
    # Phase 8: an approval-gated tool with NO decision parks a durable approval
    # (op:"approval") and SUSPENDS the turn, rather than terminating the call.
    called = {"n": 0}

    def handler(req):
        called["n"] += 1
        return httpx.Response(200, json={})

    high = _read_tool(
        side_effect=SideEffect.HIGH_IMPACT, permissions=ToolPermissions()
    )
    ctx, convex, client = _ctx(handler, [high])
    try:
        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert called["n"] == 0  # never executed without approval
    assert [c for c in convex.calls if c.get("op") == "approval"]
    assert ctx.writer.suspended is True
    body = json.loads(msgs[0].content)
    assert body["status"] == "awaiting_approval"


async def test_tool_error_maps_to_error_result():
    def handler(req):
        return httpx.Response(429, json={"detail": "slow down"})

    ctx, convex, client = _ctx(handler, [_read_tool()])
    try:
        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    results = _events(convex, "TOOL_RESULT")
    assert results and results[0]["status"] == "error"
    assert msgs[0].status == "error" and msgs[0].tool_call_id == "c1"


async def test_timeout_maps_to_error():
    def handler(req):
        raise httpx.ReadTimeout("slow", request=req)

    ctx, convex, client = _ctx(handler, [_read_tool()])
    try:
        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert msgs[0].status == "error"


async def test_unknown_tool_id_is_safe_error():
    def handler(req):
        return httpx.Response(200, json={})

    ctx, convex, client = _ctx(handler, [_read_tool()])
    try:
        msgs = await execute_tool_calls([_tc("does_not_exist", {}, "c9")], ctx)
    finally:
        await client.aclose()
    assert msgs[0].status == "error" and msgs[0].tool_call_id == "c9"
    assert "unknown tool" in msgs[0].content


async def test_duplicate_call_is_not_re_executed():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(200, json={"ok": True})

    ctx, convex, client = _ctx(handler, [_read_tool()])
    try:
        # Same tool + same args twice in ONE assistant message.
        msgs = await execute_tool_calls(
            [_tc("search_web", {"q": "x"}, "c1"), _tc("search_web", {"q": "x"}, "c2")],
            ctx,
        )
    finally:
        await client.aclose()
    assert calls["n"] == 1  # executed once
    assert len(msgs) == 2  # but BOTH tool_calls are paired
    assert {m.tool_call_id for m in msgs} == {"c1", "c2"}


# --- pairing lock: two parallel calls -> two matched ToolMessages ---------
async def test_parallel_tool_calls_each_get_a_paired_message():
    def handler(req):
        return httpx.Response(200, json={"ok": True})

    two = _read_tool(tool_id="t2", name="Two", path="/v1/two")
    ctx, convex, client = _ctx(handler, [_read_tool(), two])
    ctx.name_to_tool_id = {"search_web": "search_web", "t2": "t2"}
    try:
        msgs = await execute_tool_calls(
            [_tc("search_web", {"q": "a"}, "c1"), _tc("t2", {"q": "b"}, "c2")], ctx
        )
    finally:
        await client.aclose()
    assert [m.tool_call_id for m in msgs] == ["c1", "c2"]


async def test_cancel_skips_execution_but_still_pairs():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(200, json={})

    ctx, convex, client = _ctx(handler, [_read_tool()])
    ctx.writer._cancel_requested = True  # simulate a stop already arrived
    try:
        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert calls["n"] == 0
    assert msgs[0].tool_call_id == "c1"
    assert json.loads(msgs[0].content)["status"] == "cancelled"


# --- spec building: sanitize name + full nested-$ref deref ----------------
def test_sanitize_name_conforms_to_openai():
    used: set[str] = set()
    assert _sanitize_name("v1/seo.audit", used) == "v1_seo_audit"
    # collision -> unique suffix
    assert _sanitize_name("v1/seo.audit", used) != "v1_seo_audit"


def test_deref_resolves_nested_refs():
    components = {
        "Req": {
            "type": "object",
            "properties": {"target": {"$ref": "#/components/schemas/Target"}},
        },
        "Target": {"type": "object", "properties": {"url": {"type": "string"}}},
    }
    out = _deref_schema({"$ref": "#/components/schemas/Req"}, components)
    assert out["properties"]["target"]["properties"]["url"]["type"] == "string"
    assert "$ref" not in json.dumps(out)


def test_deref_cycle_collapses_to_object():
    components = {
        "A": {
            "type": "object",
            "properties": {"self": {"$ref": "#/components/schemas/A"}},
        }
    }
    out = _deref_schema({"$ref": "#/components/schemas/A"}, components)
    assert out["properties"]["self"] == {"type": "object"}


def test_build_tool_specs_shapes_openai_functions():
    reg = ToolRegistry()
    t = _read_tool(input_schema={"$ref": "#/components/schemas/Req"})
    reg.replace_all(
        [t],
        components={
            "Req": {"type": "object", "properties": {"q": {"type": "string"}}}
        },
    )
    specs, name_map = build_tool_specs([ToolCandidate(tool=t, score=1.0)], reg)
    assert specs[0]["type"] == "function"
    fn = specs[0]["function"]
    assert fn["name"] == "search_web" and fn["parameters"]["type"] == "object"
    assert name_map["search_web"] == "search_web"
