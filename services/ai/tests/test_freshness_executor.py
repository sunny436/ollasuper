"""Freshness in the real execution paths — the executor's search/read
interception over httpx.MockTransport (no network, no real outage needed) and the
runner's pre-model retrieval gate.

Pins: a provider 500/502/timeout on the search tool is RECORDED as a failed
search; results under a strict window reach the model with stale ones moved
out; a scraped page's dateline is recorded; the runner runs ONE prefetch search
before the model writes, records it as a real tool round, does not repeat it on
a resumed turn, does not run it for a historical question, and the end-of-turn
notice says what happened.
"""

from __future__ import annotations

from datetime import timedelta

import httpx
from langchain_core.messages import AIMessage

from app.agent.executor import ToolExecContext, execute_tool_calls
from app.agent.freshness import detect_requirement, today_utc
from app.agent.policy import READ_SCOPE
from app.clients.ollagraph import OllagraphAdapter
from app.models.chat import CompletedTool, GenerateRequest, HistoryMessage
from app.models.tools import (
    Availability,
    SideEffect,
    ToolDefinition,
    ToolPermissions,
)
from app.runtime.runner import run_generation
from app.runtime.writer import DeltaWriter
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.conftest import make_settings
from tests.test_agent_executor import _settings, _tc
from tests.test_agent_runner import FakeLLM, RecordingConvex, _event_types, _ops

SEARCH_ID = "search_endpoint_v1_search_post"
SCRAPE_ID = "scrape_endpoint_v1_scrape_post"
T = today_utc()


def _tool(tool_id: str, path: str) -> ToolDefinition:
    return ToolDefinition(
        tool_id=tool_id,
        name=tool_id,
        description="Search the web for pages"
        if "search" in tool_id
        else "Read a page",
        path=path,
        method="post",
        side_effect=SideEffect.READ_ONLY,
        enabled=True,
        availability=Availability.AVAILABLE,
        permissions=ToolPermissions(required_permissions=["ollagraph:read"]),
        # the live provider's search accepts lang/engines/limit; the guard fills lang
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "url": {"type": "string"},
                "lang": {"type": "string"},
                "engines": {"type": "array", "items": {"type": "string"}},
                "limit": {"type": "integer"},
            },
        },
    )


def _ctx(handler, *tools, requirement=None):
    reg = ToolRegistry()
    for t in tools:
        reg.register(t)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    writer = DeltaWriter(RecordingConvex(), "s1", _settings())
    writer.freshness.requirement = requirement
    writer.freshness.web_available = True
    ctx = ToolExecContext(
        registry=reg,
        adapter=OllagraphAdapter(_settings(), client),
        writer=writer,
        scope=READ_SCOPE,
        name_to_tool_id={t.tool_id: t.tool_id for t in tools},
        result_max_chars=8000,
        default_timeout_s=30.0,
        run_id="run_1",
        max_concurrent_tools=4,
        tool_max_retries=0,
    )
    return ctx, client, writer


def _iso(days_ago: int) -> str:
    return (T - timedelta(days=days_ago)).isoformat()


# ------------------------------------------------------------- executor paths


async def test_provider_500_is_recorded_as_a_failed_search():
    ctx, client, writer = _ctx(
        lambda req: httpx.Response(500, json={"error": "boom"}),
        _tool(SEARCH_ID, "/v1/search"),
        requirement=detect_requirement("What changed this week in fintech?", T),
    )
    try:
        await execute_tool_calls([_tc(SEARCH_ID, {"query": "fintech"}, "c1")], ctx)
    finally:
        await client.aclose()
    fl = writer.freshness
    assert fl.search_calls == 1 and fl.search_failed == 1 and fl.search_ok == 0


async def test_provider_502_and_timeout_are_failed_searches_too():
    for handler in (
        lambda req: httpx.Response(502, text="error code: 502"),
        lambda req: (_ for _ in ()).throw(httpx.ReadTimeout("slow")),
    ):
        ctx, client, writer = _ctx(handler, _tool(SEARCH_ID, "/v1/search"))
        try:
            await execute_tool_calls([_tc(SEARCH_ID, {"query": "x"}, "c1")], ctx)
        finally:
            await client.aclose()
        assert writer.freshness.search_failed == 1


async def test_strict_window_reaches_the_model_with_stale_results_moved_out():
    payload = {
        "status": "success",
        "count": 2,
        "results": [
            {
                "title": "Old",
                "url": "https://old.com/a",
                "snippet": f"{_iso(800)}Old fintech news",
                "rank": 1,
            },
            {
                "title": "New",
                "url": "https://new.com/b",
                "snippet": f"{_iso(2)}Fresh fintech news",
                "rank": 2,
            },
        ],
    }
    ctx, client, writer = _ctx(
        lambda req: httpx.Response(200, json=payload),
        _tool(SEARCH_ID, "/v1/search"),
        requirement=detect_requirement("What changed this week in fintech?", T),
    )
    try:
        msgs = await execute_tool_calls(
            [_tc(SEARCH_ID, {"query": "fintech news"}, "c1")], ctx
        )
    finally:
        await client.aclose()
    content = msgs[0].content
    assert "excluded_stale" in content and "https://old.com/a" in content
    assert '"cutoff"' in content
    fl = writer.freshness
    assert fl.search_calls == 1 and fl.search_ok == 1 and fl.search_compliant == 1
    assert any("new.com" in k for k in fl.dates)
    assert any("old.com" in k for k in fl.retrieved_urls)


async def test_a_read_page_is_dated_from_its_dateline(monkeypatch):
    import ipaddress

    # the SSRF guard resolves the page host; there is no DNS in the test box
    monkeypatch.setattr(
        "app.ssrf._resolved_ips",
        lambda host, port: [ipaddress.ip_address("93.184.216.34")],
    )
    page = {
        "status": "success",
        "url": "https://a.com/p",
        "content": f"Published: {_iso(400)}\n\nBody",
    }
    ctx, client, writer = _ctx(
        lambda req: httpx.Response(200, json=page),
        _tool(SCRAPE_ID, "/v1/scrape"),
        requirement=detect_requirement("Give me the past 30 days of UPI news.", T),
    )
    try:
        msgs = await execute_tool_calls(
            [_tc(SCRAPE_ID, {"url": "https://a.com/p"}, "c1")], ctx
        )
    finally:
        await client.aclose()
    assert "stale_for_request" in msgs[0].content
    fl = writer.freshness
    assert fl.read_urls and fl.dates[fl.read_urls[0]].kind == "published"


# ------------------------------------------------------------- runner gate


def _req(content: str, **kw) -> GenerateRequest:
    return GenerateRequest(
        streamId="s1",
        threadId="t1",
        messageId="m1",
        userId="u1",
        workspaceId="w1",
        model="gpt-5.6-luna",
        history=[HistoryMessage(role="user", content=content, seq=1)],
        **kw,
    )


def _setup(monkeypatch, handler, *, model_tool_call=None):
    responses = [AIMessage(content="Rates fell this week [1](https://new.com/b).")]
    if model_tool_call is not None:
        responses.insert(0, AIMessage(content="", tool_calls=[model_tool_call]))
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(AIMessage(content="plain"), responses),
    )
    settings = make_settings(
        "http://x",
        ai_agent_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
    )
    reg = ToolRegistry()
    reg.register(_tool(SEARCH_ID, "/v1/search"))
    return (
        settings,
        reg,
        ToolSelector(reg),
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def _prefetch_calls(convex) -> list[dict]:
    import json

    out = []
    for c in _ops(convex, "event"):
        for e in c["events"]:
            if e["type"] != "TOOL_CALL":
                continue
            payload = e.get("payload")
            payload = (
                json.loads(payload) if isinstance(payload, str) else (payload or {})
            )
            if payload.get("call_id") == "freshness_prefetch":
                out.append(e)
    return out


def _final_text(convex) -> str:
    finals = _ops(convex, "finalize")
    assert len(finals) == 1
    return finals[0].get("text") or ""


async def test_a_temporal_request_is_searched_by_code_before_the_model_writes(
    monkeypatch,
):
    seen: list[dict] = []

    def handler(req):
        seen.append({"url": str(req.url), "body": req.read().decode()})
        return httpx.Response(
            200,
            json={
                "status": "success",
                "count": 1,
                "results": [
                    {
                        "title": "New",
                        "url": "https://new.com/b",
                        "snippet": f"{_iso(1)}Fresh",
                        "rank": 1,
                    }
                ],
            },
        )

    settings, reg, selector, http = _setup(monkeypatch, handler)
    convex = RecordingConvex()
    try:
        await run_generation(
            _req("What changed this week in Indian fintech?"),
            settings,
            convex,
            tool_registry=reg,
            tool_selector=selector,
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    assert len(seen) == 1, "exactly one prefetch search, by code"
    assert "fintech" in seen[0]["body"] and T.strftime("%B %Y") in seen[0]["body"]
    assert len(_prefetch_calls(convex)) == 1
    assert "TOOL_RESULT" in _event_types(convex)
    # a compliant turn: the cited source is inside the window → no notice
    assert "Recency" not in _final_text(convex)
    assert "no search was run" not in _final_text(convex)


async def test_a_historical_question_runs_no_prefetch_and_gets_no_notice(monkeypatch):
    seen: list = []
    settings, reg, selector, http = _setup(
        monkeypatch,
        lambda req: seen.append(1) or httpx.Response(200, json={"results": []}),
    )
    convex = RecordingConvex()
    try:
        await run_generation(
            _req("When was UPI launched?"),
            settings,
            convex,
            tool_registry=reg,
            tool_selector=selector,
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    assert seen == [] and _prefetch_calls(convex) == []
    assert (
        "Recency" not in _final_text(convex)
        and "search" not in _final_text(convex).lower()
    )


async def test_a_provider_failure_on_the_prefetch_is_stated_at_the_end(monkeypatch):
    settings, reg, selector, http = _setup(
        monkeypatch, lambda req: httpx.Response(502, text="error code: 502")
    )
    convex = RecordingConvex()
    try:
        await run_generation(
            _req("What changed this week in Indian fintech?"),
            settings,
            convex,
            tool_registry=reg,
            tool_selector=selector,
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    text = _final_text(convex)
    assert "search failed" in text and "provider error" in text


async def test_the_prefetch_is_not_repeated_on_a_resumed_turn(monkeypatch):
    seen: list = []
    settings, reg, selector, http = _setup(
        monkeypatch,
        lambda req: seen.append(1) or httpx.Response(200, json={"results": []}),
    )
    convex = RecordingConvex()
    resumed = _req(
        "What changed this week in Indian fintech?",
        completedTools=[
            CompletedTool(
                toolId=SEARCH_ID,
                args={"query": "fintech"},
                resultContent='{"results": []}',
            )
        ],
    )
    try:
        await run_generation(
            resumed,
            settings,
            convex,
            tool_registry=reg,
            tool_selector=selector,
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    assert seen == [] and _prefetch_calls(convex) == []
    # the completed search counts: the turn is not told "no search was run"
    assert "no search was run" not in _final_text(convex)


async def test_a_stale_citation_is_named_in_the_final_notice(monkeypatch):
    def handler(req):
        return httpx.Response(
            200,
            json={
                "status": "success",
                "count": 1,
                "results": [
                    {
                        "title": "Old",
                        "url": "https://old.com/a",
                        "snippet": f"{_iso(700)}Old",
                        "rank": 1,
                    }
                ],
            },
        )

    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain"),
            [AIMessage(content="UPI volumes rose 20% [1](https://old.com/a).")],
        ),
    )
    settings = make_settings(
        "http://x",
        ai_agent_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
    )
    reg = ToolRegistry()
    reg.register(_tool(SEARCH_ID, "/v1/search"))
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    convex = RecordingConvex()
    try:
        await run_generation(
            _req("Give me the past 30 days of UPI news."),
            settings,
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    text = _final_text(convex)
    assert "Recency check" in text and "https://old.com/a" in text
    assert text.count("---") == 1, "one notices block, not several"
