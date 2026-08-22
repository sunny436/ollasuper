"""Phase 4 — run_generation wiring.

Two assertions that matter for reversibility and correctness:
  * with no registry/selector (the prod default), the run is byte-identical to
    before Phase 4: no discovery, no adapter, ONLY the finalize op — no events;
  * with the agent enabled and a discoverable read-only tool, the executor runs
    inside the graph and the ingress op stream carries TOOL_CALL/TOOL_RESULT
    events plus the terminal finalize.

The runner streams via graph.astream(stream_mode="messages"); a duck-typed fake
LLM emits no streamed tokens, but the graph still executes fully, so the executor
events fire. Real streamed text with tools is covered by e2e (p-chat.js).
"""

from __future__ import annotations

import httpx
from langchain_core.messages import AIMessage

from app.models.chat import GenerateRequest, HistoryMessage
from app.models.tools import (
    Availability,
    SideEffect,
    ToolDefinition,
    ToolPermissions,
)
from app.runtime.runner import run_generation
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.conftest import make_settings


class RecordingConvex:
    def __init__(self, resp: dict | None = None) -> None:
        self.calls: list[dict] = []
        self._resp = resp or {"ok": True}

    async def ingress(self, body: dict) -> dict:
        self.calls.append(body)
        return self._resp


class FakeTools:
    def __init__(self, responses: list[AIMessage]) -> None:
        self._r = responses
        self.calls = 0

    async def ainvoke(self, messages, *a, **k) -> AIMessage:
        self.calls += 1
        return self._r[min(self.calls - 1, len(self._r) - 1)]


class FakeLLM:
    def __init__(self, plain: AIMessage, tool_responses: list[AIMessage]) -> None:
        self._plain = plain
        self._tools = FakeTools(tool_responses)

    def bind_tools(self, specs):
        return self._tools

    async def ainvoke(self, messages, *a, **k) -> AIMessage:
        return self._plain


def _req(content: str) -> GenerateRequest:
    return GenerateRequest(
        streamId="s1",
        threadId="t1",
        messageId="m1",
        userId="u1",
        workspaceId="w1",
        model="gpt-5.6-luna",
        history=[HistoryMessage(role="user", content=content, seq=1)],
    )


def _ops(convex: RecordingConvex, op: str) -> list[dict]:
    return [c for c in convex.calls if c.get("op") == op]


def _event_types(convex: RecordingConvex) -> list[str]:
    out = []
    for c in _ops(convex, "event"):
        out += [e["type"] for e in c["events"]]
    return out


def _read_tool() -> ToolDefinition:
    return ToolDefinition(
        tool_id="search_web",
        name="Search Web",
        description="Search the web for pages",
        path="/v1/search",
        method="post",
        side_effect=SideEffect.READ_ONLY,
        enabled=True,
        availability=Availability.AVAILABLE,
        permissions=ToolPermissions(required_permissions=["ollagraph:read"]),
        input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
    )


async def test_no_registry_is_identical_no_tools_path(monkeypatch):
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(AIMessage(content="plain"), []),
    )
    settings = make_settings("http://x")
    convex = RecordingConvex()
    await run_generation(_req("hello there"), settings, convex)  # no tool params

    assert _ops(convex, "event") == []  # no executor ran
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"


async def test_agent_enabled_emits_tool_events(monkeypatch):
    tc = {"name": "search_web", "args": {"q": "cats"}, "id": "c1"}
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain-final"),
            [AIMessage(content="", tool_calls=[tc]), AIMessage(content="answer")],
        ),
    )
    settings = make_settings(
        "http://x",
        ai_agent_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
    )
    assert settings.agent_enabled is True

    reg = ToolRegistry()
    reg.register(_read_tool())
    selector = ToolSelector(reg)

    def handler(req):
        return httpx.Response(200, json={"hits": ["p1", "p2"]})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    convex = RecordingConvex()
    try:
        await run_generation(
            _req("search the web for cats"),
            settings,
            convex,
            tool_registry=reg,
            tool_selector=selector,
            ollagraph_http=http,
        )
    finally:
        await http.aclose()

    types = _event_types(convex)
    assert "TOOL_CALL" in types and "TOOL_RESULT" in types
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"


async def test_agent_off_by_flag_binds_no_tools(monkeypatch):
    # Registry present but the flag off -> agent_enabled False -> no tools.
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(AIMessage(content="plain"), []),
    )
    settings = make_settings(
        "http://x",
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
    )  # ai_agent_enabled defaults False
    assert settings.agent_enabled is False
    reg = ToolRegistry()
    reg.register(_read_tool())

    def handler(req):
        return httpx.Response(200, json={})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    convex = RecordingConvex()
    try:
        await run_generation(
            _req("search the web for cats"),
            settings,
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    assert _ops(convex, "event") == []
