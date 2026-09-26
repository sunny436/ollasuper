"""The outbound-approval boundary covers private data and every destination
(audit F-03, SECURITY-AUDIT-FINAL.md).

The audit demonstrated two transfers with ZERO approval requests: synthetic
private RAG content reaching a mocked web-search call, and tracked connector
content reaching another connector's resource URI. Both are reproduced here
through the real executor and must now park (registry tools) or be refused
(the resource-read built-in). Plus the negative controls: the user's own words
still search freely, and a clean read still reads.
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.agent.base import Agent, AgentEnv
from app.agent.executor import RagContext, execute_tool_calls, private_source_for
from app.agent.knowledge import KNOWLEDGE_TOOL_NAME
from app.agent.spec import DEFAULT_AGENT
from app.agent.taint import PRIVATE_KNOWLEDGE, TaintLedger
from app.ingest import retrieve
from app.mcp.index import CapabilityLookupError
from app.mcp.resource_tool import MCP_READ_RESOURCE_TOOL_NAME
from app.models.tools import ToolCandidate
from app.runtime.writer import DeltaWriter
from app.tools.registry import ToolRegistry
from tests.test_agent_executor import _ctx, _read_tool, _settings, _tc
from tests.test_agent_graph import FakeAdapter, ScriptedLLM
from tests.test_mcp_provenance import _mcp, _McpStub
from tests.test_writer_events import RecordingConvex

pytestmark = pytest.mark.anyio

SECRET = "acct-4471-9920-zz"  # dense: digits + punctuation


def _patch_retrieve(monkeypatch, content: str) -> None:
    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        return [
            {
                "file_id": "f1",
                "content": content,
                "source_metadata": {"source": "salaries.xlsx"},
                "page": None,
                "section": None,
                "distance": 0.1,
            }
        ]

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)


def _web_ctx(web_calls: list):
    def handler(req):
        web_calls.append(json.loads(req.content or b"{}"))
        return httpx.Response(200, json={"results": []})

    ctx, convex, client = _ctx(handler, [_read_tool()])
    s = _settings()
    ctx.rag = RagContext(engine=object(), user_id="u", settings=s)
    return ctx, convex, client


async def _run(ctx, calls):
    out = []
    for c in calls:
        out.extend(await execute_tool_calls([c], ctx))
    return out


# ------------------------------------------------ private RAG -> web search
async def test_private_knowledge_cannot_reach_web_search_unasked(monkeypatch):
    _patch_retrieve(monkeypatch, f"Payroll account for Q3 is {SECRET}.")
    web_calls: list = []
    ctx, convex, client = _web_ctx(web_calls)
    try:
        msgs = await _run(
            ctx,
            [
                {"name": KNOWLEDGE_TOOL_NAME, "args": {"query": "payroll"}, "id": "c1"},
                _tc("search_web", {"q": f"who owns account {SECRET}"}, "c2"),
            ],
        )
    finally:
        await client.aclose()
    assert web_calls == [], "private knowledge reached the web provider"
    assert json.loads(msgs[1].content)["status"] == "awaiting_approval"
    parked = [c for c in convex.calls if c.get("op") == "approval"]
    assert parked and "knowledge" in parked[0]["reason"]


async def test_the_users_own_words_still_search_freely(monkeypatch):
    """Negative control: a RAG hit shares a dense term with the question the
    user TYPED. Echoing their own words into a search is not a disclosure."""
    _patch_retrieve(monkeypatch, "The contractors-2026 policy allows 25 days.")
    web_calls: list = []
    ctx, _convex, client = _web_ctx(web_calls)
    ctx.taint.record_benign("what does the contractors-2026 policy say?")
    try:
        msgs = await _run(
            ctx,
            [
                {"name": KNOWLEDGE_TOOL_NAME, "args": {"query": "policy"}, "id": "c1"},
                _tc("search_web", {"q": "contractors-2026 policy"}, "c2"),
            ],
        )
    finally:
        await client.aclose()
    assert len(web_calls) == 1
    assert msgs[1].status == "success"


# ------------------------------------------- MCP resource URI as destination
class _Resource:
    def __init__(self, slug: str, uri: str) -> None:
        self.server_slug = slug
        self.uri = uri
        self.mime_type = "text/plain"
        self.connection_id = f"conn-{slug}"


class _Block:
    def __init__(self, text: str) -> None:
        self.text = text


class _Result:
    def __init__(self, text: str) -> None:
        self.contents = [_Block(text)]


class _Client:
    def __init__(self, text: str) -> None:
        self.text = text
        self.reads: list[str] = []

    async def read_resource(self, uri, cache_mode="use"):
        self.reads.append(uri)
        return _Result(self.text)


class _Index:
    """The per-turn capability index: every URI resolves to one connector."""

    def __init__(self, slug: str, text: str = "contents") -> None:
        self.slug = slug
        self.client = _Client(text)

    def resolve_resource(self, uri, *, connector=None):
        if not uri:
            raise CapabilityLookupError("no uri")
        return _Resource(self.slug, uri), self.client


def _read(uri: str, cid: str) -> dict:
    return {"name": MCP_READ_RESOURCE_TOOL_NAME, "args": {"uri": uri}, "id": cid}


def _resource_ctx(slug: str, text: str = "contents"):
    ctx, convex, client = _ctx(lambda r: httpx.Response(200, json={}), [])
    ctx.mcp_index = _Index(slug, text)
    return ctx, convex, client


async def test_connector_content_cannot_ride_out_in_another_connectors_resource_uri():
    ctx, _convex, client = _resource_ctx("drive")
    ctx.taint.record("mcp:gmail", {"text": f"your code is {SECRET}"})
    try:
        msgs = await _run(ctx, [_read(f"drive://search?q={SECRET}", "c1")])
        # The destination stays flagged: a "clean" retry in the same turn is
        # refused too (the retry-in-fragments rule, applied to resources).
        again = await _run(ctx, [_read("drive://files/readme", "c2")])
    finally:
        await client.aclose()
    assert json.loads(msgs[0].content)["status"] == "refused"
    assert json.loads(again[0].content)["status"] == "refused"
    assert ctx.mcp_index.client.reads == [], "the URI was sent to the server"


async def test_private_data_cannot_ride_out_in_a_resource_uri():
    ctx, _convex, client = _resource_ctx("drive")
    ctx.taint.record(PRIVATE_KNOWLEDGE, f"salary band {SECRET}")
    try:
        msgs = await _run(ctx, [_read(f"drive://find/{SECRET}", "c1")])
    finally:
        await client.aclose()
    assert json.loads(msgs[0].content)["status"] == "refused"
    assert ctx.mcp_index.client.reads == []


async def test_a_clean_resource_read_still_reads_and_is_tracked():
    """Positive control, and the other half: what a resource returns is that
    connector's content, so it cannot then flow to a DIFFERENT connector."""
    ctx, convex, client = _resource_ctx("drive", text=f"shared doc token {SECRET}")
    notion = _mcp("notion", "search")
    ctx.registry.register(notion)
    ctx.name_to_tool_id[notion.tool_id] = notion.tool_id
    stub = _McpStub({notion.tool_id: {"text": "nothing"}})
    ctx.adapters[notion.provider] = stub
    try:
        msgs = await _run(ctx, [_read("drive://files/readme", "c1")])
        out = await _run(ctx, [_tc(notion.tool_id, {"q": SECRET}, "c2")])
    finally:
        await client.aclose()
    assert msgs[0].status != "error"
    assert ctx.mcp_index.client.reads == ["drive://files/readme"]
    assert stub.calls == [], "resource content reached another connector"
    assert json.loads(out[0].content)["status"] == "awaiting_approval"
    assert any(c.get("op") == "approval" for c in convex.calls)


# --------------------------------------------------- delegation + resume
def test_a_delegated_sub_agent_shares_the_parent_turns_ledger():
    """A sub-agent used to start from an EMPTY ledger, so anything the parent
    put in `delegate_to_agent(task)` left through the sub-agent's tools with no
    check — including connector content the H-06 gate had been tracking."""
    parent = TaintLedger()
    parent.record(PRIVATE_KNOWLEDGE, f"private {SECRET}")
    reg = ToolRegistry()
    reg.register(_read_tool())
    env = AgentEnv(
        writer=DeltaWriter(RecordingConvex(), "s1", _settings()),
        llm=ScriptedLLM([]),
        run_id="run_1",
        registry=reg,
        adapter=FakeAdapter(),
        candidates=[ToolCandidate(tool=_read_tool(), score=1.0)],
        taint=parent,
    )
    ctx, _specs = Agent.build_context(DEFAULT_AGENT, env)
    assert ctx is not None
    assert ctx.taint is parent
    assert ctx.taint.sources_in({"q": SECRET}) == {PRIVATE_KNOWLEDGE}


def test_resume_re_records_private_built_in_results():
    assert private_source_for(KNOWLEDGE_TOOL_NAME) == PRIVATE_KNOWLEDGE
    assert private_source_for("search_web") == ""


def test_values_inside_uris_punctuation_and_percent_encoding_still_match():
    """A secret is not hidden by being a query parameter, a path segment, the
    end of a sentence, or percent-encoded (the resource-URI half of F-03)."""
    ledger = TaintLedger()
    ledger.record("mcp:gmail", {"text": f"your code is {SECRET}."})
    for args in (
        {"uri": f"drive://search?q={SECRET}&page=1"},
        {"uri": f"drive://files/{SECRET}/readme"},
        {"uri": "drive://search?q=acct%2D4471%2D9920%2Dzz"},
        {"q": f"look up {SECRET}, please"},
    ):
        assert ledger.sources_in(args) == {"mcp:gmail"}, args
    # Common words in a URI are still not taint.
    assert ledger.sources_in({"uri": "drive://files/quarterly/readme"}) == set()
