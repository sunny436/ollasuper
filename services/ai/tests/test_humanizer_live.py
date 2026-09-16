"""The humanize stage, end to end through the REAL runner, for the skills that
actually write content.

`test_humanizer_runs.py` drives the executor with hand-built calls; that proves
the plumbing, not that a real turn reaches it. These run `run_generation` with a
scripted model, the live orchestrated runtime and real skill discovery.

WHY BLOG + MARKETING, not Report Writing. Measured with the production skill
registry: "write a blog post…" and "write a LinkedIn post…" activate
`blog-assist`; "write a product launch email…" and "draft a newsletter…"
activate `marketing`. `report-writing` scored 0.16 against a 0.2 threshold even
for "write a report summarizing…" — so the content paths a user actually hits
are Blog and Marketing, and those are what is proven here.
"""

from __future__ import annotations

import json
import logging

import httpx
from langchain_core.messages import AIMessage, SystemMessage

from app.humanizer.guidance import BLOG_STAGE, HUMANIZER_GUIDANCE, MARKETING_STAGE
from app.humanizer.tool import HUMANIZE_CHECK_TOOL_NAME
from app.runtime.runner import _log_writing_preservation, run_generation
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.conftest import make_settings
from tests.test_agent_runner import RecordingConvex, _read_tool, _req
from tests.test_live_orchestration import _CapLLM

DRAFT = (
    "# Why incident retrospectives stall\n\n"
    "In today's digital landscape, retrospectives are not just meetings but a "
    "testament to engineering culture. Additionally, we reviewed 40 teams in 2026 "
    "and 31 had unowned action items.\n"
)
FINAL = (
    "# Why incident retrospectives stall\n\n"
    "We reviewed 40 teams in 2026. In 31 of them the action items had no owner, "
    "and those were the ones that came back the next quarter.\n"
)


def _scripted() -> list[AIMessage]:
    """The shape the stage demands: detect on the finished draft, then answer."""
    return [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": HUMANIZE_CHECK_TOOL_NAME,
                    "args": {"mode": "detect", "text": DRAFT},
                    "id": "h1",
                }
            ],
        ),
        AIMessage(content=FINAL),
    ]


async def _turn(monkeypatch, text: str, *, humanizer: bool):
    llms: list[_CapLLM] = []

    def _build(*a, **k):
        llm = _CapLLM(AIMessage(content="plain"), _scripted())
        llms.append(llm)
        return llm

    monkeypatch.setattr("app.runtime.runner.build_llm", _build)
    reg = ToolRegistry()
    reg.register(_read_tool())
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={}))
    )
    convex = RecordingConvex()
    settings = make_settings(
        "http://x",
        ai_agent_enabled=True,
        ai_orchestrated_runtime_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
        ai_blog_enabled=True,
        ai_marketing_enabled=True,
        ai_humanizer_enabled=humanizer,
    )
    try:
        await run_generation(
            _req(text),
            settings,
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    return llms, convex


def _system_text(llms: list[_CapLLM]) -> str:
    return "".join(
        str(m.content)
        for lm in llms
        for msgs in lm.tools.seen
        for m in msgs
        if isinstance(m, SystemMessage)
    )


def _bound_names(llms: list[_CapLLM]) -> list[str]:
    bound = next((lm.bound_specs for lm in llms if lm.bound_specs), None) or []
    return [s["function"]["name"] for s in bound]


def _events(convex: RecordingConvex) -> list[dict]:
    return [e for c in convex.calls if c.get("op") == "event" for e in c["events"]]


def _humanize_events(convex: RecordingConvex) -> tuple[list[dict], list[dict]]:
    calls, results = [], []
    call_ids = set()
    for e in _events(convex):
        payload = json.loads(e["payload"])
        if (
            e["type"] == "TOOL_CALL"
            and payload.get("tool_name") == HUMANIZE_CHECK_TOOL_NAME
        ):
            calls.append(payload)
            call_ids.add(payload.get("call_id"))
        elif e["type"] == "TOOL_RESULT" and payload.get("call_id") in call_ids:
            results.append(payload)
    return calls, results


def _finalized_text(convex: RecordingConvex) -> str:
    finals = [c for c in convex.calls if c.get("op") == "finalize"]
    assert len(finals) == 1, finals
    assert finals[0]["status"] == "done", finals[0]
    return finals[0]["text"]


# ---------------------------------------------------------------- the skills
async def _assert_stage_ran(monkeypatch, caplog, text: str, skill_marker: str):
    caplog.set_level(logging.INFO)
    llms, convex = await _turn(monkeypatch, text, humanizer=True)

    system = _system_text(llms)
    assert HUMANIZER_GUIDANCE in system, "the stage guidance never reached the model"
    assert skill_marker in system, f"the skill's own stage ({skill_marker!r}) is absent"
    assert HUMANIZE_CHECK_TOOL_NAME in _bound_names(llms)

    calls, results = _humanize_events(convex)
    assert calls, "humanize_check was never dispatched"
    assert calls[0]["arguments"] == {"mode": "detect"}, "the draft leaked into events"
    assert results and results[0]["status"] == "success"

    delivered = _finalized_text(convex)
    assert "humaniz" not in delivered.lower(), "the answer names the internal stage"

    # The delivered text was checked against the draft the stage detected.
    records = [r for r in caplog.records if r.getMessage() == "writing.preservation"]
    assert records, "the finalize-time preservation check did not run"


async def test_a_blog_turn_runs_the_stage_end_to_end(monkeypatch, caplog):
    await _assert_stage_ran(
        monkeypatch,
        caplog,
        "Write a blog post for engineering leaders about incident retrospectives",
        BLOG_STAGE,
    )


async def test_a_marketing_turn_runs_the_stage_end_to_end(monkeypatch, caplog):
    await _assert_stage_ran(
        monkeypatch,
        caplog,
        "Write a product launch email for our new analytics feature",
        MARKETING_STAGE,
    )


async def test_flag_off_binds_nothing_and_says_nothing(monkeypatch):
    """The control. Off is byte-identical: no spec, no guidance, and a scripted
    call to the tool has nothing to dispatch to."""
    llms, _convex = await _turn(
        monkeypatch,
        "Write a blog post for engineering leaders about incident retrospectives",
        humanizer=False,
    )
    system = _system_text(llms)
    assert HUMANIZER_GUIDANCE not in system
    assert HUMANIZE_CHECK_TOOL_NAME not in _bound_names(llms)
    # The skill itself activated — and, with the flag off, says nothing about a
    # tool that is not bound.
    assert "OllaSuper Blog Quality Score" in system, "the Blog skill did not activate"
    assert "humanize_check" not in system


# ------------------------------------- finalize-time preservation (Part A)
def _preservation(caplog) -> logging.LogRecord:
    records = [r for r in caplog.records if r.getMessage() == "writing.preservation"]
    assert len(records) == 1, [r.getMessage() for r in caplog.records]
    return records[0]


def test_the_delivered_text_is_checked_against_the_detected_draft(caplog):
    caplog.set_level(logging.INFO)
    _log_writing_preservation("s1", DRAFT, FINAL)
    rec = _preservation(caplog)
    assert rec.kept_everything is True, rec.lost


def test_a_delivered_answer_that_dropped_a_fact_is_caught(caplog):
    """In-loop verify checks what the model CLAIMS it will send; this checks
    what it sent. A number the checked draft had, missing from the delivered
    answer, is a loss."""
    caplog.set_level(logging.INFO)
    _log_writing_preservation("s1", DRAFT, FINAL.replace("31 of them", "most of them"))
    rec = _preservation(caplog)
    assert rec.kept_everything is False
    assert rec.lost.get("numbers") == 1


def test_blocks_written_after_the_draft_are_not_false_losses_or_additions(caplog):
    """The Blog skill writes its score block, caption, Sources and score
    progression AFTER the draft. Their numbers ("96/100", "89 -> 94") are not in
    the draft, and a draft that carried them must not read as losing them."""
    caplog.set_level(logging.INFO)
    tail = (
        "\n## OllaSuper Blog Quality Score\n96/100 - Exceptional\n"
        "Quality of this draft - NOT a Google-ranking prediction.\n\n"
        "### Score progression\n89 -> (added 2 tier-1 stats) -> 94 -> 97\n\n"
        "## Sources & evidence\n- https://example.test/survey\n"
    )
    _log_writing_preservation("s1", DRAFT + tail, FINAL)
    assert _preservation(caplog).kept_everything is True


def test_the_preservation_check_never_raises():
    _log_writing_preservation("s1", "", "")
    _log_writing_preservation("s1", DRAFT, "")
    _log_writing_preservation("s1", "x" * 300_000, "y" * 300_000)
