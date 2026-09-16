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

import json
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
from tests.humanizer_fixtures import BLOG_TAIL, CLEAN, DRAFT, REWRITE, in_token_space
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
        self.rewrite_models: list[str] = []


class ScriptedChat(BaseChatModel):
    """Streams its script token by token; LangChain fires the token callbacks."""

    model_config = ConfigDict(arbitrary_types_allowed=True)
    rec: Any = None
    model_id: str = ""

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
            self.rec.rewrite_models.append(self.model_id)
            if callable(self.rec.rewrite):  # a rewriter that echoes protected tokens
                return self.rec.rewrite(messages)
            return self.rec.rewrite
        # `draft` is one script, or one script PER model call (a multi-step turn).
        call = len(self.rec.draft_prompts)
        self.rec.draft_prompts.append(list(messages))
        if isinstance(self.rec.draft, tuple):
            return self.rec.draft[min(call, len(self.rec.draft) - 1)]
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
        if isinstance(out, dict):  # narration + a tool call, one model call
            for tok in _TOKENS.findall(out["text"]):
                yield ChatGenerationChunk(message=AIMessageChunk(content=tok))
            chunks = [
                {
                    "name": c["name"],
                    "args": json.dumps(c["args"]),
                    "id": c["id"],
                    "index": i,
                }
                for i, c in enumerate(out["tool_calls"])
            ]
            yield ChatGenerationChunk(
                message=AIMessageChunk(content="", tool_call_chunks=chunks)
            )
            return
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
    rewrite: Any = None,
    humanizer: bool = True,
    convex: RecordingConvex | None = None,
    candidates: list[ModelCandidate] | None = None,
    **flags,
) -> tuple[Recorder, RecordingConvex]:
    if rewrite is None:  # the faithful rewrite, as the real rewriter returns it
        rewrite = _rw(REWRITE, draft if isinstance(draft, str) else DRAFT)
    rec = Recorder(draft, rewrite)
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: ScriptedChat(rec=rec, model_id=k.get("model", "")),
    )
    settings = _agent_settings(
        **{
            "ai_orchestrated_runtime_enabled": True,
            "ai_router_enabled": True,
            "ai_quota_fallback_model": "",
            "ai_marketing_enabled": True,
            "ai_blog_enabled": True,
            "ai_humanizer_enabled": humanizer,
            **flags,
        }
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
                modelCandidates=candidates
                or [ModelCandidate(id="deepseek-v4-flash", contextWindow=131_072)],
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


def _rw(text: str, draft: str = DRAFT) -> str:
    """A rewrite a person wrote, in the draft's token space (what the rewriter
    receives and must return)."""
    return in_token_space(text, draft)


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
    assert "fast-paced" in rewrite_input
    # Every figure, date and link reaches the rewriter only as a placeholder.
    for atom in ("42", "38%", "https://example.com/pulse", "March 3, 2026"):
        assert atom not in rewrite_input, atom
    d = _decision(caplog)
    assert d["decision"] == "rewritten" and d["score_after"] > d["score_before"]


async def test_a_rewrite_that_loses_a_fact_is_refused_and_the_draft_is_saved(
    monkeypatch, caplog
):
    caplog.set_level(logging.INFO)
    lossy = _rw(REWRITE.replace("tracks 42 metrics", "tracks dozens of metrics"))
    _, convex = await _turn(monkeypatch, rewrite=lossy)

    assert _final(convex)["text"] == DRAFT, "every fact the draft had is kept"
    d = _decision(caplog)
    # The figure reached the rewriter only as a token; dropping it is refused.
    assert d["decision"] == "rejected" and d["reason"] == "protected_span_changed"


async def test_a_rewrite_that_invents_a_figure_is_refused(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    invented = _rw(REWRITE.replace("hours back each week", "12 hours back each week"))
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


async def test_the_blog_score_block_and_sources_are_never_rewritten(
    monkeypatch, caplog
):
    caplog.set_level(logging.INFO)
    rec, convex = await _turn(
        monkeypatch,
        prompt="Write a blog post about why analytics dashboards go stale",
        draft=DRAFT + BLOG_TAIL,
        rewrite=_rw(REWRITE + BLOG_TAIL, DRAFT + BLOG_TAIL),
    )
    streamed = _streamed(convex)
    assert "⟦" not in streamed, "no token ever reaches the screen"
    assert "## OllaSuper Blog Quality Score: 91/100" in streamed
    assert "https://example.com/beta-report" in streamed
    assert "fast-paced" not in streamed
    assert "Quality Score" not in str(rec.rewrite_prompts[0][1].content)
    assert _decision(caplog)["decision"] == "rewritten"


SCORE_FIRST = (
    "All checks pass. Here is the final article.\n\n"
    + BLOG_TAIL.lstrip()
    + "\n"
    + DRAFT
)


async def test_a_score_block_before_the_article_still_gets_the_article_rewritten(
    monkeypatch, caplog
):
    """Prod: the Blog skill wrote its score block FIRST and the stage judged only
    the 9-word sentence before it."""
    caplog.set_level(logging.INFO)
    rec, convex = await _turn(
        monkeypatch,
        prompt="Write a blog post about why analytics dashboards go stale",
        draft=SCORE_FIRST,
        rewrite=_rw(SCORE_FIRST.replace(DRAFT, REWRITE), SCORE_FIRST),
    )
    assert len(rec.rewrite_prompts) == 1
    assert "fast-paced" not in _streamed(convex)
    assert "## OllaSuper Blog Quality Score: 91/100" in _streamed(convex)


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


# ------------------------------------------------------------------ prod-found cases
NARRATION = 'Researching competitor pricing for "analytics dashboards" first.'


async def test_narration_between_tool_steps_shows_and_only_the_deliverable_is_rewritten(
    monkeypatch, caplog
):
    """Prod: a 19-step blog turn sent its SERP narration to the rewrite, which changed
    the quoted search terms and got the whole rewrite refused."""
    caplog.set_level(logging.INFO)
    step1 = {
        "text": NARRATION,
        "tool_calls": [{"name": "search_web", "args": {"q": "pricing"}, "id": "c1"}],
    }
    rec, convex = await _turn(
        monkeypatch,
        prompt=f"{WRITE}; search the web for competitor pricing first",
        draft=(step1, DRAFT),
    )
    streamed = _streamed(convex)
    assert streamed.startswith(NARRATION), "narration is shown, not hidden or rewritten"
    assert streamed == NARRATION + REWRITE
    assert "fast-paced" not in streamed
    rewrite_input = str(rec.rewrite_prompts[0][1].content)
    assert (
        NARRATION not in rewrite_input and "analytics dashboards" not in rewrite_input
    )
    assert _decision(caplog)["decision"] == "rewritten"


async def test_a_refused_deliverable_keeps_the_narration_before_it(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    step1 = {
        "text": NARRATION,
        "tool_calls": [{"name": "search_web", "args": {"q": "pricing"}, "id": "c1"}],
    }
    lossy = _rw(REWRITE.replace("tracks 42 metrics", "tracks dozens of metrics"))
    _, convex = await _turn(
        monkeypatch,
        prompt=f"{WRITE}; search the web for competitor pricing first",
        draft=(step1, DRAFT),
        rewrite=lossy,
    )
    assert _final(convex)["text"] == NARRATION + DRAFT


async def test_a_draft_that_opens_with_its_own_preface_is_not_refused_for_it(
    monkeypatch, caplog
):
    """Prod: two faithful rewrites were refused as `chat_wrapper` because they kept
    the model's own "Here's a launch email..." opener."""
    caplog.set_level(logging.INFO)
    opener = "Here's a launch email for your existing customers.\n\n"

    rec, convex = await _turn(
        monkeypatch,
        draft=opener + DRAFT,
        rewrite=_rw(opener + REWRITE, opener + DRAFT),
    )
    assert opener.strip() not in str(rec.rewrite_prompts[0][1].content)
    assert _decision(caplog)["decision"] == "rewritten"
    assert _streamed(convex) == opener + REWRITE


async def test_a_writing_request_no_skill_claims_still_gets_the_stage(
    monkeypatch, caplog
):
    """Prod: landing copy matched no skill and the stage never ran."""
    caplog.set_level(logging.INFO)
    rec, _ = await _turn(
        monkeypatch,
        prompt="Create landing page copy for a meditation app called Stillwater",
        ai_marketing_enabled=False,
        ai_blog_enabled=False,
    )
    assert len(rec.rewrite_prompts) == 1
    assert _decision(caplog)["register"] == "prose"


async def test_a_code_request_is_never_held_back(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    rec, convex = await _turn(
        monkeypatch, prompt="Write a Python function that formats a launch email"
    )
    assert _streamed(convex) == DRAFT
    assert rec.rewrite_prompts == []
    assert not [r for r in caplog.records if r.getMessage() == "writing.humanize"]


async def test_the_rewrite_goes_to_the_fastest_healthy_model(monkeypatch, caplog):
    """Prod: the reasoning model spent 36-83s on a voice edit. The router still
    picks the DRAFT's brain; the rewrite goes to the fastest healthy routed model."""
    caplog.set_level(logging.INFO)
    both = [
        ModelCandidate(id="deepseek-v4-flash", contextWindow=131_072),
        ModelCandidate(id="gemini-3.7-flash-high", contextWindow=0),
    ]
    rec, _ = await _turn(monkeypatch, candidates=both)
    assert rec.rewrite_models == ["gemini-3.7-flash-high"]
    assert _decision(caplog)["model"] == "gemini-3.7-flash-high"


async def test_an_unavailable_fast_model_is_skipped_for_the_rewrite(monkeypatch):
    both = [
        ModelCandidate(id="deepseek-v4-flash", contextWindow=131_072),
        ModelCandidate(id="gemini-3.7-flash-high", contextWindow=0),
    ]
    health.mark_exhausted("gemini-3.7-flash-high", 600)
    rec, _ = await _turn(monkeypatch, candidates=both)
    assert rec.rewrite_models == ["deepseek-v4-flash"]
