"""The humanize stage end to end through the REAL runner, graph and writer.

The model is a real LangChain chat model whose `_astream` yields tokens, so
LangGraph's messages-mode streaming and the DeltaWriter behave exactly as in
production — which is what lets these tests say what the USER saw (the deltas
Convex received) and what was SAVED (the finalize text), separately:

  * a machine-shaped draft is never streamed; the rewrite is, and is saved;
  * a rewrite that loses or invents a fact still streamed, but the DRAFT is saved;
  * clean or short writing streams as written, with no second model call;
  * a rewrite call that fails before or during streaming still delivers the draft;
  * non-writing work, and the flag off, stream exactly as before;
  * the blog's score block and sources are never sent to, or changed by, the rewrite;
  * nothing in the prompt or the bound tools ever mentions humanization.
"""

from __future__ import annotations

import logging
import re
from typing import Any

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, SystemMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from pydantic import ConfigDict

from app.agent import health
from app.models.chat import GenerateRequest, HistoryMessage, ModelCandidate
from app.runtime.runner import run_generation
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.humanizer_fixtures import BLOG_TAIL, CLEAN, DRAFT, REWRITE
from tests.test_agent_runner import (
    RecordingConvex,
    _agent_settings,
    _ok_http,
    _ops,
    _read_tool,
)

WRITE = "Write a product launch email for our analytics dashboard"
_TOKENS = re.compile(r"\S+\s*|\s+")


class Recorder:
    def __init__(self, draft: str, rewrite: Any) -> None:
        self.draft = draft
        self.rewrite = rewrite
        self.draft_prompts: list[list] = []
        self.rewrite_prompts: list[list] = []
        self.bound_tools: list[str] = []


class ScriptedChat(BaseChatModel):
    """Streams its script token by token; LangChain fires the token callbacks."""

    model_config = ConfigDict(arbitrary_types_allowed=True)
    rec: Any = None

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools, **kwargs):
        for t in tools:
            name = (
                (t.get("function") or {}).get("name") if isinstance(t, dict) else None
            )
            if name:
                self.rec.bound_tools.append(name)
        return self

    def _script(self, messages):
        first = messages[0] if messages else None
        if isinstance(first, SystemMessage) and "senior copy editor" in str(
            first.content
        ):
            self.rec.rewrite_prompts.append(list(messages))
            return self.rec.rewrite
        self.rec.draft_prompts.append(list(messages))
        return self.rec.draft

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        out = self._script(messages)
        if isinstance(out, Exception):
            raise out
        text = (
            "".join(p for p in out if isinstance(p, str))
            if isinstance(out, list)
            else out
        )
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text))])

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        out = self._script(messages)
        for piece in out if isinstance(out, list) else [out]:
            if isinstance(piece, Exception):
                raise piece
            for tok in _TOKENS.findall(piece):
                yield ChatGenerationChunk(message=AIMessageChunk(content=tok))


@pytest.fixture(autouse=True)
def _clean_health():
    health.reset()
    yield
    health.reset()


async def _turn(
    monkeypatch,
    *,
    prompt: str = WRITE,
    draft: str = DRAFT,
    rewrite: Any = REWRITE,
    humanizer: bool = True,
    convex: RecordingConvex | None = None,
    **flags,
) -> tuple[Recorder, RecordingConvex]:
    rec = Recorder(draft, rewrite)
    monkeypatch.setattr(
        "app.runtime.runner.build_llm", lambda *a, **k: ScriptedChat(rec=rec)
    )
    settings = _agent_settings(
        ai_orchestrated_runtime_enabled=True,
        ai_router_enabled=True,
        ai_quota_fallback_model="",
        ai_marketing_enabled=True,
        ai_blog_enabled=True,
        ai_humanizer_enabled=humanizer,
        **flags,
    )
    reg = ToolRegistry()
    reg.register(_read_tool())
    http = _ok_http()
    convex = convex or RecordingConvex()
    try:
        await run_generation(
            GenerateRequest(
                streamId="s1",
                threadId="t1",
                messageId="m1",
                userId="u1",
                workspaceId="w1",
                model="deepseek-v4-flash",
                contextWindow=131_072,
                modelCandidates=[
                    ModelCandidate(id="deepseek-v4-flash", contextWindow=131_072)
                ],
                history=[HistoryMessage(role="user", content=prompt, seq=1)],
            ),
            settings,
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    return rec, convex


def _streamed(convex: RecordingConvex) -> str:
    deltas = [d for c in _ops(convex, "delta") for d in c["deltas"]]
    return "".join(d["text"] for d in sorted(deltas, key=lambda d: d["seq"]))


def _final(convex: RecordingConvex) -> dict:
    finals = _ops(convex, "finalize")
    assert len(finals) == 1
    return finals[0]


def _decision(caplog) -> dict:
    rows = [r for r in caplog.records if r.getMessage() == "writing.humanize"]
    assert len(rows) == 1, [r.getMessage() for r in caplog.records]
    return rows[0].__dict__


# ------------------------------------------------------------------ the stage runs
async def test_a_machine_shaped_draft_is_never_shown_and_the_rewrite_is_saved(
    monkeypatch, caplog
):
    caplog.set_level(logging.INFO)
    rec, convex = await _turn(monkeypatch)

    streamed = _streamed(convex)
    assert streamed == REWRITE, "the user saw exactly the rewrite"
    assert "fast-paced" not in streamed and "Let that sink in" not in streamed
    assert _final(convex)["status"] == "done"
    assert _final(convex)["text"] == REWRITE
    assert len(rec.rewrite_prompts) == 1
    rewrite_input = str(rec.rewrite_prompts[0][1].content)
    assert DRAFT.strip() in rewrite_input and "fast-paced" in rewrite_input
    d = _decision(caplog)
    assert d["decision"] == "rewritten" and d["score_after"] > d["score_before"]


async def test_a_rewrite_that_loses_a_fact_is_refused_and_the_draft_is_saved(
    monkeypatch, caplog
):
    caplog.set_level(logging.INFO)
    lossy = REWRITE.replace("tracks 42 metrics", "tracks dozens of metrics")
    _, convex = await _turn(monkeypatch, rewrite=lossy)

    assert _final(convex)["text"] == DRAFT, "every fact the draft had is kept"
    d = _decision(caplog)
    assert d["decision"] == "rejected" and d["reason"] == "not_preserved"
    assert d["lost"] == {"numbers": 1}


async def test_a_rewrite_that_invents_a_figure_is_refused(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    invented = REWRITE.replace("hours back each week", "12 hours back each week")
    _, convex = await _turn(monkeypatch, rewrite=invented)
    assert _final(convex)["text"] == DRAFT
    assert _decision(caplog)["added"] == 1


async def test_clean_writing_streams_as_written_with_no_second_call(
    monkeypatch, caplog
):
    caplog.set_level(logging.INFO)
    rec, convex = await _turn(monkeypatch, draft=CLEAN)
    assert _streamed(convex) == CLEAN
    assert _final(convex)["text"] in (None, CLEAN)
    assert rec.rewrite_prompts == []
    assert _decision(caplog)["decision"] == "clean"


async def test_a_short_answer_is_not_touched(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    short = "Subject: Pulse Analytics is live on every Pro plan."
    rec, convex = await _turn(monkeypatch, draft=short)
    assert _streamed(convex) == short and rec.rewrite_prompts == []
    assert _decision(caplog)["decision"] == "short"


# ------------------------------------------------------------------ failure paths
async def test_a_rewrite_call_that_fails_delivers_the_draft(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    _, convex = await _turn(monkeypatch, rewrite=RuntimeError("upstream down"))
    assert _streamed(convex) == DRAFT
    assert _final(convex)["status"] == "done"
    assert _decision(caplog)["decision"] == "rewrite_failed"


async def test_a_rewrite_cut_off_mid_stream_saves_the_draft(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    half = REWRITE[: len(REWRITE) // 2]
    _, convex = await _turn(
        monkeypatch, rewrite=[half, RuntimeError("connection reset")]
    )
    assert _final(convex)["status"] == "done"
    assert _final(convex)["text"] == DRAFT
    assert _decision(caplog)["decision"] == "rewrite_failed"


async def test_a_cancel_during_the_hidden_draft_leaks_nothing(monkeypatch):
    convex = RecordingConvex({"ok": True, "cancel": True})
    rec, convex = await _turn(monkeypatch, convex=convex)
    assert "fast-paced" not in _streamed(convex)
    assert rec.rewrite_prompts == []


# ------------------------------------------------------------------ scope
async def test_non_writing_work_streams_normally_even_with_a_writing_skill(
    monkeypatch, caplog
):
    caplog.set_level(logging.INFO)
    rec, convex = await _turn(
        monkeypatch,
        prompt="Analyze our email campaign funnel and calculate ROAS from 5000 spend",
    )
    skills = [
        getattr(r, "skills", [])
        for r in caplog.records
        if r.getMessage() == "agent.skills_active"
    ]
    assert any("marketing" in s for s in skills), "a writing skill IS active here"
    assert _streamed(convex) == DRAFT
    assert rec.rewrite_prompts == []
    assert not [r for r in caplog.records if r.getMessage() == "writing.humanize"]


async def test_with_the_flag_off_writing_streams_exactly_as_before(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    rec, convex = await _turn(monkeypatch, humanizer=False)
    assert _streamed(convex) == DRAFT
    assert rec.rewrite_prompts == []
    assert not [r for r in caplog.records if r.getMessage() == "writing.humanize"]


async def test_the_blog_score_block_and_sources_are_never_rewritten(monkeypatch):
    rec, convex = await _turn(
        monkeypatch,
        prompt="Write a blog post about why analytics dashboards go stale",
        draft=DRAFT + BLOG_TAIL,
    )
    final = _final(convex)["text"] or _streamed(convex)
    assert final.endswith(BLOG_TAIL)
    assert "fast-paced" not in final
    assert "Quality Score" not in str(rec.rewrite_prompts[0][1].content)


async def test_nothing_the_model_sees_mentions_humanization(monkeypatch):
    rec, _ = await _turn(monkeypatch)
    systems = " ".join(
        str(m.content)
        for prompt in rec.draft_prompts
        for m in prompt
        if isinstance(m, SystemMessage)
    )
    # The retired prompt-driven stage's instructions never reach the model: the
    # stage is enforced by code. (Marketing's own playbook text may still say
    # "write/humanize" as a step name; that is not an instruction to call anything.)
    for retired in (
        "humanize_check",
        "WRITING-QUALITY PASS",
        "WRITING QUALITY (internal",
    ):
        assert retired not in systems
    assert "humanize_check" not in rec.bound_tools


async def test_required_keywords_from_the_request_reach_the_rewrite(monkeypatch):
    rec, _ = await _turn(
        monkeypatch,
        prompt="Write a blog post about analytics dashboards, target keyword "
        "'Pulse Analytics'",
    )
    assert "Required keywords" in str(rec.rewrite_prompts[0][1].content)
    assert "Pulse Analytics" in str(rec.rewrite_prompts[0][1].content)
