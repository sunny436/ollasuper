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

import json

import httpx
from langchain_core.messages import AIMessage

from app.ingest import retrieve
from app.models.chat import GenerateRequest, HistoryMessage, MemoryItem
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
        resp = dict(self._resp)
        if body.get("op") in ("event", "execution") and "persisted" not in resp:
            resp["persisted"] = True
        return resp


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


def _req(
    content: str,
    *,
    rag_file_count: int = 0,
    memory_enabled: bool = False,
    memories: list | None = None,
) -> GenerateRequest:
    return GenerateRequest(
        streamId="s1",
        threadId="t1",
        messageId="m1",
        userId="u1",
        workspaceId="w1",
        model="gpt-5.6-luna",
        history=[HistoryMessage(role="user", content=content, seq=1)],
        ragFileCount=rag_file_count,
        memoryEnabled=memory_enabled,
        memories=memories or [],
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


# ---- Phase 5: RAG-as-tool migration gate -------------------------------------
def _patch_retrieve(monkeypatch, rows, *, queries=None):
    async def fake_embed(settings, q):
        if queries is not None:
            queries.append(q)
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        return rows

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)


_ROW = {
    "file_id": "f1",
    "content": "Annual leave is 25 days.",
    "source_metadata": {"source": "policy.pdf"},
    "page": 3,
    "section": None,
    "distance": 0.2,
}


async def test_rag_tool_on_retrieves_and_skips_prerun(monkeypatch):
    queries: list[str] = []
    _patch_retrieve(monkeypatch, [_ROW], queries=queries)
    tc = {"name": "search_knowledge", "args": {"query": "annual leave"}, "id": "c1"}
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain"),
            [AIMessage(content="", tool_calls=[tc]), AIMessage(content="answer")],
        ),
    )
    settings = make_settings("http://x", ai_agent_rag_tool_enabled=True)
    convex = RecordingConvex()
    await run_generation(
        _req("please check my uploaded files", rag_file_count=1),
        settings,
        convex,
        engine=object(),
    )
    types = _event_types(convex)
    assert "CITATION" in types and "TOOL_RESULT" in types
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"
    # Pre-run RAG was skipped: the ONLY embed query is the tool's, never latest.content.
    assert queries == ["annual leave"]


async def test_rag_tool_binds_even_with_no_web_candidate(monkeypatch):
    # bug #2: agent_enabled + a registry that yields NO candidate for the query
    # must still bind search_knowledge (RAG never silently disappears).
    queries: list[str] = []
    _patch_retrieve(monkeypatch, [_ROW], queries=queries)
    tc = {"name": "search_knowledge", "args": {"query": "leave days"}, "id": "c1"}
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
        ai_agent_rag_tool_enabled=True,
    )
    reg = ToolRegistry()
    reg.register(
        ToolDefinition(
            tool_id="weather_now",
            name="Weather Forecast",
            description="Current weather",
            path="/v1/weather",
            method="post",
            side_effect=SideEffect.READ_ONLY,
            permissions=ToolPermissions(required_permissions=["ollagraph:read"]),
        )
    )
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={}))
    )
    convex = RecordingConvex()
    try:
        await run_generation(
            _req("what do my documents say about leave", rag_file_count=1),
            settings,
            convex,
            engine=object(),
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    assert "CITATION" in _event_types(convex)  # RAG tool bound + used


async def test_rag_tool_off_runs_prerun_no_events(monkeypatch):
    queries: list[str] = []
    _patch_retrieve(monkeypatch, [_ROW], queries=queries)
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(AIMessage(content="plain"), []),
    )
    settings = make_settings("http://x")  # ai_agent_rag_tool_enabled defaults False
    convex = RecordingConvex()
    await run_generation(
        _req("what does my file say about leave", rag_file_count=1),
        settings,
        convex,
        engine=object(),
    )
    assert _ops(convex, "event") == []  # no knowledge/tool events
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"
    # Pre-run DID run: it embedded latest.content.
    assert queries == ["what does my file say about leave"]


# ---- Phase 6: memory tools ----------------------------------------------------
async def test_memory_tool_on_remember_writes(monkeypatch):
    _patch_retrieve(monkeypatch, [])  # RAG untouched
    tc = {
        "name": "remember",
        "args": {"content": "I use Rust", "kind": "fact"},
        "id": "c1",
    }
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain"),
            [AIMessage(content="", tool_calls=[tc]), AIMessage(content="done")],
        ),
    )
    settings = make_settings("http://x", ai_agent_memory_tool_enabled=True)
    convex = RecordingConvex({"ok": True, "id": "mem1"})
    await run_generation(
        _req("please remember I use Rust", memory_enabled=True), settings, convex
    )
    assert [c for c in convex.calls if c.get("op") == "remember"]  # write fired
    assert "ARTIFACT" in _event_types(convex)
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"


async def test_memory_search_bound_only_with_memories(monkeypatch):
    _patch_retrieve(monkeypatch, [])
    tc = {"name": "search_memory", "args": {"query": "my language"}, "id": "c1"}
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain"),
            [AIMessage(content="", tool_calls=[tc]), AIMessage(content="answer")],
        ),
    )
    settings = make_settings("http://x", ai_agent_memory_tool_enabled=True)
    convex = RecordingConvex()
    await run_generation(
        _req(
            "what language do I use",
            memory_enabled=True,
            memories=[MemoryItem(id="1", kind="fact", content="Uses Python")],
        ),
        settings,
        convex,
    )
    assert "CITATION" in _event_types(convex)  # search_memory recalled + cited


async def test_memory_off_binds_nothing(monkeypatch):
    _patch_retrieve(monkeypatch, [])
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(AIMessage(content="plain"), []),
    )
    settings = make_settings("http://x")  # ai_agent_memory_tool_enabled defaults False
    convex = RecordingConvex()
    await run_generation(
        _req(
            "hi",
            memory_enabled=True,
            memories=[MemoryItem(id="1", kind="fact", content="x")],
        ),
        settings,
        convex,
    )
    assert [c for c in convex.calls if c.get("op") == "remember"] == []
    assert _ops(convex, "event") == []


# --- Phase 12b (Stage 1): dynamic capability discovery wired into the runner ---
def _seo_tool() -> ToolDefinition:
    # Does NOT match "search the web", so it is absent from the initial discovery.
    return ToolDefinition(
        tool_id="broken_links_audit",
        name="Broken Links Audit",
        description="Audit a site for broken links",
        path="/v1/seo/broken-links-audit",
        method="post",
        side_effect=SideEffect.READ_ONLY,
        enabled=True,
        availability=Availability.AVAILABLE,
        permissions=ToolPermissions(required_permissions=["ollagraph:read"]),
        input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
    )


def _tool_call_ids(convex: RecordingConvex) -> list[str]:
    out: list[str] = []
    for c in _ops(convex, "event"):
        for ev in c["events"]:
            if ev["type"] == "TOOL_CALL":
                out.append(json.loads(ev["payload"]).get("tool_id"))
    return out


def _agent_settings(**over):
    return make_settings(
        "http://x",
        ai_agent_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
        **over,
    )


def _ok_http() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.MockTransport(lambda req: httpx.Response(200, json={"ok": []}))
    )


async def test_orchestrated_reaches_tool_outside_initial_discovery(monkeypatch):
    # FLAGSHIP (§8): with dynamic discovery ON, the model reaches a tool that was
    # NOT in the initial top-K discovery, via find_capabilities -> dynamic load.
    find = {"name": "find_capabilities",
            "args": {"query": "broken links audit"}, "id": "c1"}
    target = {"name": "broken_links_audit", "args": {"q": "x"}, "id": "c2"}
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain-final"),
            [
                AIMessage(content="", tool_calls=[find]),
                AIMessage(content="", tool_calls=[target]),
                AIMessage(content="audited"),
            ],
        ),
    )
    reg = ToolRegistry()
    reg.register(_read_tool())
    reg.register(_seo_tool())
    selector = ToolSelector(reg)
    http = _ok_http()
    convex = RecordingConvex()
    try:
        await run_generation(
            _req("search the web for cats"),
            _agent_settings(ai_orchestrated_runtime_enabled=True),
            convex,
            tool_registry=reg,
            tool_selector=selector,
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    # the tool ranked OUTSIDE the initial discovery actually executed
    assert "broken_links_audit" in _tool_call_ids(convex)
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"


async def test_orchestrated_off_leaves_tool_unreachable(monkeypatch):
    # GATE: flag OFF -> find_capabilities is not bound/routed -> the out-of-discovery
    # tool is never loaded -> never executed. Proves the wiring is flag-gated.
    find = {"name": "find_capabilities",
            "args": {"query": "broken links audit"}, "id": "c1"}
    target = {"name": "broken_links_audit", "args": {"q": "x"}, "id": "c2"}
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain-final"),
            [
                AIMessage(content="", tool_calls=[find]),
                AIMessage(content="", tool_calls=[target]),
                AIMessage(content="done"),
            ],
        ),
    )
    reg = ToolRegistry()
    reg.register(_read_tool())
    reg.register(_seo_tool())
    selector = ToolSelector(reg)
    http = _ok_http()
    convex = RecordingConvex()
    try:
        await run_generation(
            _req("search the web for cats"),
            _agent_settings(),  # ai_orchestrated_runtime_enabled defaults False
            convex,
            tool_registry=reg,
            tool_selector=selector,
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    assert "broken_links_audit" not in _tool_call_ids(convex)  # never reachable
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"  # still completes


async def test_orchestrated_on_normal_tool_flow_still_streams(monkeypatch):
    # ON path does not regress a normal in-discovery tool flow: events fire + the
    # run finalizes through the streaming astream path.
    tc = {"name": "search_web", "args": {"q": "cats"}, "id": "c1"}
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain-final"),
            [AIMessage(content="", tool_calls=[tc]), AIMessage(content="answer")],
        ),
    )
    reg = ToolRegistry()
    reg.register(_read_tool())
    selector = ToolSelector(reg)
    http = _ok_http()
    convex = RecordingConvex()
    try:
        await run_generation(
            _req("search the web for cats"),
            _agent_settings(ai_orchestrated_runtime_enabled=True),
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


# --- FIX: autonomous capability selection (core-capability seeding + orientation)
async def test_core_seeding_binds_web_tool_for_keywordless_query(monkeypatch):
    # The "current macbook price" bug: a natural query with NO lexical overlap with
    # the web tool. Without seeding the model gets NO tool (n_scored=0) and answers
    # from memory; with seeding the web capability is ALWAYS bound (flag-independent)
    # so the model can search — and the system prompt now orients it to.
    tc = {"name": "search_web", "args": {"q": "macbook air m5 price india"}, "id": "c1"}
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain"),
            [AIMessage(content="", tool_calls=[tc]), AIMessage(content="₹1,49,900")],
        ),
    )
    reg = ToolRegistry()
    reg.register(_read_tool())  # tool_id search_web, name "Search Web", /v1/search
    selector = ToolSelector(reg)
    http = _ok_http()
    convex = RecordingConvex()
    try:
        await run_generation(
            # NO "search"/"web" tokens — lexical discovery alone returns nothing.
            _req("what is the current macbook air m5 price in india"),
            _agent_settings(),  # agent on; orchestrated flag OFF (seeding is flagless)
            convex,
            tool_registry=reg,
            tool_selector=selector,
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    # the web tool was bound + executed despite the query not matching it lexically
    assert "search_web" in _tool_call_ids(convex)
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"


async def test_huge_message_truncation_keeps_head_and_tail(monkeypatch):
    # QA-6 fix: a huge message must keep its TAIL (the user's trailing question),
    # not just the head — head-only truncation silently dropped a trailing ask.
    seen = {}

    class RecLLM(FakeLLM):
        async def ainvoke(self, messages, *a, **k):
            seen["msgs"] = messages
            return await super().ainvoke(messages, *a, **k)

    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: RecLLM(AIMessage(content="ok"), []),
    )
    tail = "TAILQUESTION-9c3f what is 2+2"
    huge = ("filler word " * 9000) + tail  # ~100k chars, well over the 48k cap
    convex = RecordingConvex()
    await run_generation(_req(huge), make_settings("http://x"), convex)
    body = "".join(
        m.content
        for m in seen.get("msgs", [])
        if isinstance(getattr(m, "content", None), str)
    )
    assert tail in body, "the trailing question was truncated away (head-only)"
    assert "truncated to fit" in body, "truncation was not made visible to the model"


def test_capability_orientation_only_when_agentic():
    from app.agent.context import CAPABILITY_ORIENTATION, build_system_prompt
    # agentic -> orientation leads, even when the user set custom instructions.
    p = build_system_prompt(
        custom="Talk like a pirate.", about=None, style=None, summary=None,
        summary_through_seq=0, agentic=True,
    )
    assert p.startswith(CAPABILITY_ORIENTATION) and "pirate" in p
    # not agentic (plain chat, no capabilities) -> orientation absent, unchanged.
    p2 = build_system_prompt(
        custom=None, about=None, style=None, summary=None,
        summary_through_seq=0, agentic=False,
    )
    assert CAPABILITY_ORIENTATION not in p2


# --- Phase 1 (v2) runner smoke tests ----------------------------------------
async def test_v2_orchestrated_tool_flow_finalizes(monkeypatch):
    # v2 ON + tools: the corrected runner path (shared prepare + factory delegator
    # + find_capabilities) still streams tool events and finalizes cleanly.
    tc = {"name": "search_web", "args": {"q": "cats"}, "id": "c1"}
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain-final"),
            [AIMessage(content="", tool_calls=[tc]), AIMessage(content="answer")],
        ),
    )
    reg = ToolRegistry()
    reg.register(_read_tool())
    http = _ok_http()
    convex = RecordingConvex()
    try:
        await run_generation(
            _req("search the web for cats"),
            _agent_settings(
                ai_orchestrated_runtime_enabled=True, ai_runtime_v2_enabled=True
            ),
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    types = _event_types(convex)
    assert "TOOL_CALL" in types and "TOOL_RESULT" in types
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"


async def test_v2_skills_decoupled_finalize_without_tools(monkeypatch):
    # Item 2: with Ollagraph OFF (no registry passed), a knowledge skill still
    # activates under v2 and the turn finalizes via the plain graph — proving skill
    # activation is decoupled from tool availability.
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(AIMessage(content="researched answer"), []),
    )
    convex = RecordingConvex()
    await run_generation(
        _req("research and verify sources about cats"),
        _agent_settings(
            ai_orchestrated_runtime_enabled=True, ai_runtime_v2_enabled=True
        ),
        convex,  # NO tool_registry/selector/http -> Ollagraph off
    )
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"
